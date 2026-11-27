/**
 * An in-memory stand-in for the orca CLI. It records every call and answers
 * by command name, so tests assert exactly what would have been sent.
 */

import { commandName, type OrcaRunner, type RunnerOptions } from "../src/index.js";

export interface FakeCall {
  args: string[];
  command: string;
  stdin?: string;
}

type Handler = (args: string[], opts: RunnerOptions) => unknown;

export const WORKTREE = "path:/factory";
export const PROFILE_ID = "factory-profile";

export function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export class FakeOrca {
  readonly calls: FakeCall[] = [];
  private readonly handlers = new Map<string, Handler>();
  tabs = new Map<string, { profileId: string; url: string; title: string }>();
  private nextTab = 1;

  constructor() {
    this.on("status", () => ({ app: { running: true }, runtime: { state: "ready" } }));
    this.on("tab profile list", () => ({
      profiles: [
        { id: "default", scope: "default", label: "Default" },
        { id: PROFILE_ID, scope: "isolated", label: "AI Content Factory" }
      ]
    }));
    this.on("tab create", (args) => {
      const id = `tab-${this.nextTab++}`;
      this.tabs.set(id, { profileId: flag(args, "--profile") ?? "default", url: flag(args, "--url") ?? "about:blank", title: "" });
      return { browserPageId: id };
    });
    this.on("tab show", (args) => {
      const id = flag(args, "--page") ?? "";
      const tab = this.tabs.get(id);
      if (!tab) throw { code: "browser_tab_not_found", message: "not found" };
      return { tab: { browserPageId: id, ...tab, worktreeId: WORKTREE } };
    });
    this.on("tab close", (args) => {
      this.tabs.delete(flag(args, "--page") ?? "");
      return {};
    });
    this.on("capture start", () => ({}));
    this.on("eval", () => ({ result: JSON.stringify({ v: { width: 1000, height: 700 } }) }));
  }

  on(command: string, handler: Handler): this {
    this.handlers.set(command, handler);
    return this;
  }

  /** Calls of one command, in order. */
  of(command: string): FakeCall[] {
    return this.calls.filter((c) => c.command === command);
  }

  readonly runner: OrcaRunner = async (_exe, rawArgs, opts) => {
    const args = rawArgs.filter((a) => a !== "--json");
    const command = commandName(args);
    this.calls.push({ args, command, stdin: opts.stdin || undefined });
    const handler = this.handlers.get(command);
    if (!handler) return { stdout: JSON.stringify({ ok: true, result: {} }), exitCode: 0 };
    try {
      const result = await handler(args, opts);
      return { stdout: JSON.stringify({ ok: true, result }), exitCode: 0 };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { stdout: JSON.stringify({ ok: false, error: { code: e.code ?? "browser_error", message: e.message ?? "failed" } }), exitCode: 1 };
    }
  };
}

/** Environment for a session against the fake. */
export function fakeEnv(workRoot: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    FACTORY_ORCA_WORKTREE: WORKTREE,
    FACTORY_DEV_ENV_DIR: workRoot,
    FACTORY_ORCA_MIN_ACTION_INTERVAL_MS: "0",
    FACTORY_ORCA_CONSOLE_POLL_MS: "0",
    FACTORY_ORCA_CLI: "/nonexistent/orca",
    ...extra
  };
}
