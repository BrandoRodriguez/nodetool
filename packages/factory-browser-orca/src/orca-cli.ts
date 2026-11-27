/**
 * The one place that runs the public `orca` CLI.
 *
 * - Every call is checked by {@link OrcaPolicy}, gets `--json`, and runs with
 *   `spawn` and no shell, so no argument is ever interpreted by a shell.
 * - Secrets go through stdin (`--value-stdin`), never argv, where `ps` shows them.
 * - Each call has a deadline and an optional AbortSignal; both kill the child.
 * - Output past `maxOutputBytes` kills the child instead of growing memory.
 * - Commands on one tab run in order; at most `maxConcurrent` run at once.
 * - An identical read already in flight is shared, not repeated.
 * - Only reads are retried, and only when Orca says its runtime is busy.
 *   An action that may have reached the page is never sent twice.
 */

import { spawn } from "node:child_process";
import {
  OrcaAbortError,
  OrcaError,
  OrcaProtocolError,
  OrcaTabGoneError,
  OrcaTimeoutError,
  OrcaUnavailableError
} from "./errors.js";
import { commandName, type OrcaPolicy } from "./policy.js";

export interface RunnerResult {
  stdout: string;
  exitCode: number | null;
}

export interface RunnerOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  stdin?: string;
  env: NodeJS.ProcessEnv;
}

/** Runs the executable once. Injected in tests. */
export type OrcaRunner = (
  executable: string,
  args: string[],
  opts: RunnerOptions
) => Promise<RunnerResult>;

export interface OrcaCliOptions {
  executable: string;
  policy: OrcaPolicy;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  maxConcurrent: number;
  env?: NodeJS.ProcessEnv;
  runner?: OrcaRunner;
  /** Delay before retrying a read that met a busy runtime. */
  retryDelayMs?: number;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Sent on stdin; the argv should carry the matching `-stdin` flag. */
  stdin?: string;
}

interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

/** The documented way Orca says its runtime is momentarily busy. */
const BUSY_CODES = new Set(["runtime_unavailable"]);
const READ_RETRIES = 2;

/** spawn-based runner with deadline, cancellation and an output cap. */
export const spawnRunner: OrcaRunner = (executable, args, opts) =>
  new Promise((resolve, reject) => {
    const label = commandName(args);
    if (opts.signal?.aborted) {
      reject(new OrcaAbortError(label));
      return;
    }
    const child = spawn(executable, args, {
      env: opts.env,
      stdio: ["pipe", "pipe", "ignore"],
      shell: false
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err: Error | null, result?: RunnerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else if (result) resolve(result);
    };
    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    const timer = setTimeout(() => {
      kill();
      finish(new OrcaTimeoutError(label, opts.timeoutMs));
    }, opts.timeoutMs);
    const onAbort = (): void => {
      kill();
      finish(new OrcaAbortError(label));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > opts.maxOutputBytes) {
        kill();
        finish(new OrcaError("output_too_large", `orca ${label} answered more than ${opts.maxOutputBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(
        err.code === "ENOENT"
          ? new OrcaUnavailableError(`The orca CLI was not found (${executable}). Install Orca or set FACTORY_ORCA_CLI.`)
          : err
      );
    });
    child.on("close", (exitCode) => {
      finish(null, { stdout: Buffer.concat(chunks).toString("utf8"), exitCode });
    });
    child.stdin.on("error", () => {
      // The child exited before reading stdin; its exit status reports why.
    });
    child.stdin.end(opts.stdin ?? "");
  });

function toError(args: readonly string[], envelope: Envelope): OrcaError {
  const code = envelope.error?.code ?? "orca_error";
  const message = envelope.error?.message ?? `orca ${commandName(args)} failed`;
  if (code === "browser_tab_not_found") {
    const i = args.indexOf("--page");
    return new OrcaTabGoneError(i >= 0 ? (args[i + 1] ?? "?") : "?");
  }
  if (BUSY_CODES.has(code)) return new OrcaUnavailableError(message, code);
  if (code === "selector_not_found") {
    const i = args.indexOf("--worktree");
    const selector = i >= 0 ? args[i + 1] : "(none)";
    const folder = selector?.startsWith("path:") ? selector.slice(5) : "<folder>";
    return new OrcaUnavailableError(
      `Orca does not know the workspace ${selector}. Add the folder to Orca ` +
        `(orca repo add --path "${folder}" --kind folder) or set FACTORY_ORCA_WORKTREE.`,
      "workspace_not_found"
    );
  }
  return new OrcaError(code, message);
}

export class OrcaCli {
  private readonly opts: OrcaCliOptions;
  private readonly runner: OrcaRunner;
  private readonly pageQueues = new Map<string, Promise<unknown>>();
  private readonly inflightReads = new Map<string, Promise<unknown>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(opts: OrcaCliOptions) {
    this.opts = opts;
    this.runner = opts.runner ?? spawnRunner;
  }

  get policy(): OrcaPolicy {
    return this.opts.policy;
  }

  /**
   * Runs `orca <args> --json` and returns `result`. Throws an {@link OrcaError}
   * for every failure Orca reports.
   */
  async run<T = unknown>(args: string[], opts: RunOptions = {}): Promise<T> {
    this.opts.policy.checkCommand(args);
    const readOnly = !this.opts.policy.isMutating(args) && opts.stdin === undefined;
    const key = JSON.stringify(args);
    if (readOnly) {
      const shared = this.inflightReads.get(key);
      if (shared) return shared as Promise<T>;
    }
    const pageIndex = args.indexOf("--page");
    const pageId = pageIndex >= 0 ? args[pageIndex + 1] : undefined;
    const task = (): Promise<T> => this.withSlot(() => this.runWithRetries<T>(args, opts, readOnly));
    const promise = pageId ? this.enqueue(pageId, task) : task();
    if (readOnly) {
      this.inflightReads.set(key, promise);
      const forget = (): void => {
        if (this.inflightReads.get(key) === promise) this.inflightReads.delete(key);
      };
      promise.then(forget, forget);
    }
    return promise;
  }

  private async runWithRetries<T>(args: string[], opts: RunOptions, readOnly: boolean): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.runOnce<T>(args, opts);
      } catch (err) {
        const busy = err instanceof OrcaUnavailableError && err.retriable;
        if (!readOnly || !busy || attempt >= READ_RETRIES || opts.signal?.aborted) throw err;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, (this.opts.retryDelayMs ?? 500) * attempt));
      }
    }
  }

  private async runOnce<T>(args: string[], opts: RunOptions): Promise<T> {
    const { stdout } = await this.runner(this.opts.executable, [...args, "--json"], {
      timeoutMs: opts.timeoutMs ?? this.opts.defaultTimeoutMs,
      maxOutputBytes: this.opts.maxOutputBytes,
      signal: opts.signal,
      stdin: opts.stdin,
      env: this.opts.env ?? process.env
    });
    let envelope: Envelope;
    try {
      envelope = JSON.parse(stdout) as Envelope;
    } catch {
      throw new OrcaProtocolError(
        `orca ${commandName(args)} did not answer JSON: ${stdout.slice(0, 200) || "(empty)"}`
      );
    }
    if (typeof envelope !== "object" || envelope === null || typeof envelope.ok !== "boolean") {
      throw new OrcaProtocolError(`orca ${commandName(args)} answered an unknown envelope`);
    }
    if (!envelope.ok) throw toError(args, envelope);
    return envelope.result as T;
  }

  /** Runs tasks for one tab strictly in order, whatever their outcome. */
  private enqueue<T>(pageId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.pageQueues.get(pageId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    this.pageQueues.set(pageId, settled);
    void settled.then(() => {
      if (this.pageQueues.get(pageId) === settled) this.pageQueues.delete(pageId);
    });
    return next;
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.opts.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
