/**
 * {@link BrowserPage} over one Orca tab, through the public CLI.
 *
 * Every command names the tab and the factory workspace. Arguments to page
 * functions cross as a JSON string literal, never spliced into source, and
 * results come back wrapped in `JSON.stringify({ v })`: Orca returns every
 * evaluation as a string, so without the wrapper `42` and `"42"` would be the
 * same value.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger } from "@nodetool-ai/config";
import type {
  BrowserPage,
  BrowserPageConsoleMessage,
  BrowserPageFunction,
  BrowserWaitUntil
} from "@nodetool-ai/browser";
import type { OrcaCli, RunOptions } from "./orca-cli.js";
import type { TabScope } from "./tab-scope.js";
import { OrcaHumanActionRequiredError, OrcaPolicyError, OrcaProtocolError } from "./errors.js";
import { isInside } from "./policy.js";

const log = createLogger("factory.browser.orca");

/** What an Orca action reports it caused. */
interface Effects {
  url?: string;
  title?: string;
  loading?: boolean;
  downloads?: Array<{ filename?: string; origin?: string }>;
  passkeyRequest?: unknown;
  consoleErrors?: unknown[];
  newTabs?: unknown[];
}

interface ConsoleEntry {
  type?: string;
  level?: string;
  text?: string;
  message?: string;
  timestamp?: number;
}

export interface OrcaPageOptions {
  navigationTimeoutMs: number;
  consolePollIntervalMs: number;
  /** Directories `setFileInputFiles` may read from. */
  uploadRoots: string[];
  /** Largest evaluation result accepted, in characters. */
  maxEvalChars: number;
}

/** Builds the expression for `orca eval`. Exported for tests. */
export function buildEvalExpression(fnOrExpr: string | BrowserPageFunction, args: unknown[]): string {
  const wrap = (call: string): string =>
    `(async () => { const __ntValue = await (${call}); ` +
    `return JSON.stringify({ v: __ntValue === undefined ? null : __ntValue }); })()`;
  if (typeof fnOrExpr === "function") {
    const argsLiteral = JSON.stringify(JSON.stringify(args));
    return wrap(`(${fnOrExpr.toString()})(...JSON.parse(${argsLiteral}))`);
  }
  return wrap(fnOrExpr);
}

/** Reads the value back out of a {@link buildEvalExpression} result. */
export function decodeEvalResult<T>(raw: unknown): T {
  if (typeof raw !== "string") {
    throw new OrcaProtocolError("orca eval returned a non-string result");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OrcaProtocolError("orca eval returned a result the transport did not wrap");
  }
  if (typeof parsed !== "object" || parsed === null || !("v" in parsed)) {
    throw new OrcaProtocolError("orca eval returned a result the transport did not wrap");
  }
  return (parsed as { v: T }).v;
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export class OrcaPage implements BrowserPage {
  readonly pageId: string;
  private readonly cli: OrcaCli;
  private readonly scope: TabScope;
  private readonly opts: OrcaPageOptions;
  private currentUrl = "about:blank";
  private currentTitle: string | null = null;
  private viewport = { width: 1280, height: 900 };
  private readonly consoleHandlers: Array<(msg: BrowserPageConsoleMessage) => void> = [];
  private consoleSeen = 0;
  private lastConsolePoll = 0;

  private constructor(cli: OrcaCli, scope: TabScope, pageId: string, opts: OrcaPageOptions) {
    this.cli = cli;
    this.scope = scope;
    this.pageId = pageId;
    this.opts = opts;
  }

  /** Attaches to a tab the scope already checked. */
  static async attach(cli: OrcaCli, scope: TabScope, pageId: string, opts: OrcaPageOptions): Promise<OrcaPage> {
    scope.assertUsable(pageId);
    const page = new OrcaPage(cli, scope, pageId, opts);
    await page.refresh();
    if (opts.consolePollIntervalMs > 0) {
      await page.run(["capture", "start"]);
    }
    return page;
  }

  // ── BrowserPage ──────────────────────────────────────────────────────

  url(): string {
    return this.currentUrl;
  }

  viewportSize(): { width: number; height: number } {
    return { ...this.viewport };
  }

  async title(): Promise<string> {
    if (this.currentTitle === null) {
      this.currentTitle = await this.evaluate<string>("document.title");
    }
    return this.currentTitle;
  }

  on(event: "console", handler: (msg: BrowserPageConsoleMessage) => void): void {
    if (event === "console") this.consoleHandlers.push(handler);
  }

  async goto(
    url: string,
    opts: { waitUntil?: BrowserWaitUntil; timeout?: number } = {}
  ): Promise<{ status: number | null }> {
    this.cli.policy.checkNavigationUrl(url);
    const timeoutMs = opts.timeout ?? this.opts.navigationTimeoutMs;
    await this.act(["goto", "--url", url], { navigation: url, timeoutMs });
    if (opts.waitUntil === "load" || opts.waitUntil === "domcontentloaded") {
      await this.run(["wait", "--load", opts.waitUntil, "--timeout", String(timeoutMs)], { timeoutMs: timeoutMs + 5_000 });
    }
    // The navigation entry carries the document's HTTP status (Chromium 109+).
    const status = await this.evaluate<number | null>(
      "(performance.getEntriesByType('navigation')[0]?.responseStatus) || null"
    );
    return { status: typeof status === "number" && status > 0 ? status : null };
  }

  async evaluate<T = unknown>(fnOrExpr: string | BrowserPageFunction, ...args: unknown[]): Promise<T> {
    const expression = buildEvalExpression(fnOrExpr, args);
    const result = await this.run<{ result: unknown }>(["eval", "--expression", expression]);
    if (typeof result.result === "string" && result.result.length > this.opts.maxEvalChars) {
      throw new OrcaPolicyError(`Evaluation result exceeds ${this.opts.maxEvalChars} characters`);
    }
    return decodeEvalResult<T>(result.result);
  }

  async click(selector: string): Promise<void> {
    await this.act(["click", "--element", selector]);
  }

  async fill(selector: string, text: string): Promise<void> {
    // Through stdin: the value may be a password, and argv is visible to ps.
    await this.act(["fill", "--element", selector, "--value-stdin"], { stdin: text });
  }

  async press(selector: string, key: string): Promise<void> {
    await this.run(["focus", "--element", selector]);
    await this.act(["keypress", "--key", key]);
  }

  async selectOption(selector: string, value: string): Promise<string[]> {
    const result = await this.act<{ selected?: string[] }>(["select", "--element", selector, "--value", value]);
    return Array.isArray(result.selected) ? result.selected : [value];
  }

  async setFileInputFiles(selector: string, files: string[]): Promise<void> {
    if (files.length === 0) throw new OrcaPolicyError("No files to upload");
    for (const file of files) {
      if (file.includes(",")) {
        throw new OrcaPolicyError(`Upload paths cannot contain a comma: ${path.basename(file)}`);
      }
      if (!this.opts.uploadRoots.some((root) => isInside(root, file))) {
        throw new OrcaPolicyError(`Uploads must come from the factory environment, not ${file}`);
      }
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new OrcaPolicyError(`Not a file: ${file}`);
    }
    await this.act(["upload", "--element", selector, "--files", files.join(",")]);
  }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    const result = await this.run<{ path: string }>([opts.fullPage ? "full-screenshot" : "screenshot"]);
    if (typeof result.path !== "string") throw new OrcaProtocolError("orca screenshot returned no path");
    const bytes = await fs.readFile(result.path);
    // The CLI saves captures under the caller's TMPDIR. Remove ours once read;
    // a path anywhere else belongs to Orca and is left alone.
    const [file, tmp] = await Promise.all([fs.realpath(result.path), fs.realpath(os.tmpdir())]);
    if (isInside(tmp, file)) {
      await fs.rm(file, { force: true });
    }
    return bytes;
  }

  readonly mouse = {
    move: async (x: number, y: number): Promise<void> => {
      await this.run(["mouse", "move", "--x", String(Math.round(x)), "--y", String(Math.round(y))]);
    },
    click: async (x: number, y: number): Promise<void> => {
      await this.run(["mouse", "move", "--x", String(Math.round(x)), "--y", String(Math.round(y))]);
      await this.act(["mouse", "down"]);
      await this.act(["mouse", "up"]);
    }
  };

  readonly keyboard = {
    type: async (text: string): Promise<void> => {
      await this.act(["type", "--input", text]);
    },
    press: async (key: string): Promise<void> => {
      await this.act(["keypress", "--key", key]);
    }
  };

  // ── Extras beyond BrowserPage ────────────────────────────────────────

  async content(): Promise<string> {
    return this.evaluate<string>("document.documentElement.outerHTML");
  }

  async reload(): Promise<void> {
    await this.act(["reload"], { navigation: this.currentUrl });
  }

  async goBack(): Promise<void> {
    await this.act(["back"], { navigation: this.currentUrl });
  }

  async waitForSelector(selector: string, opts: { timeout?: number } = {}): Promise<{ exists: true }> {
    const timeoutMs = opts.timeout ?? 30_000;
    await this.run(["wait", "--selector", selector, "--timeout", String(timeoutMs)], { timeoutMs: timeoutMs + 5_000 });
    return { exists: true };
  }

  // ── Plumbing ─────────────────────────────────────────────────────────

  private pageArgs(): string[] {
    return ["--page", this.pageId, "--worktree", this.scope.worktree];
  }

  /** A read: no pacing, no effects. */
  private run<T = unknown>(args: string[], opts: RunOptions = {}): Promise<T> {
    this.scope.assertUsable(this.pageId);
    return this.cli.run<T>([...args, ...this.pageArgs()], opts);
  }

  /** An action: paced per origin, its effects folded into the cached state. */
  private async act<T extends object = Record<string, unknown>>(
    args: string[],
    opts: RunOptions & { navigation?: string } = {}
  ): Promise<T> {
    const target = opts.navigation ?? this.currentUrl;
    await this.cli.policy.pace(originOf(target), opts.navigation !== undefined);
    const result = await this.run<T & { effects?: Effects; url?: string; title?: string }>(args, opts);
    this.applyEffects(result.effects, result);
    await this.maybePollConsole();
    return result;
  }

  private applyEffects(effects: Effects | undefined, result: { url?: string; title?: string }): void {
    const url = effects?.url ?? result.url;
    const title = effects?.title ?? result.title;
    if (typeof url === "string") {
      this.currentUrl = url;
      this.currentTitle = null;
    }
    if (typeof title === "string") this.currentTitle = title;
    if (effects?.downloads?.length) {
      // Orca saves page downloads in the user's Downloads folder and the CLI
      // cannot redirect them. Report it; capture_media is the bounded path.
      log.warn("A page action started a download outside the factory environment", {
        files: effects.downloads.map((d) => d.filename ?? "?")
      });
    }
    if (effects?.passkeyRequest) {
      throw new OrcaHumanActionRequiredError(
        "The page is waiting for a passkey or security key. Finish the sign-in in the Orca tab."
      );
    }
  }

  private async refresh(): Promise<void> {
    const { tab } = await this.run<{ tab: { url: string; title: string } }>(["tab", "show"]);
    this.currentUrl = tab.url;
    this.currentTitle = tab.title;
    try {
      const size = await this.evaluate<{ width: number; height: number }>(
        "({ width: window.innerWidth, height: window.innerHeight })"
      );
      if (size.width > 0 && size.height > 0) this.viewport = size;
    } catch {
      // about:blank and some error pages refuse script; keep the default size.
    }
  }

  private async maybePollConsole(): Promise<void> {
    if (this.consoleHandlers.length === 0 || this.opts.consolePollIntervalMs === 0) return;
    const now = Date.now();
    if (now - this.lastConsolePoll < this.opts.consolePollIntervalMs) return;
    this.lastConsolePoll = now;
    try {
      const result = await this.run<Record<string, unknown>>(["console", "--limit", "200"]);
      const entries = (Object.values(result).find(Array.isArray) ?? []) as ConsoleEntry[];
      // Orca returns the most recent entries; deliver the ones not seen yet.
      const fresh = entries.slice(Math.max(0, Math.min(this.consoleSeen, entries.length)));
      this.consoleSeen = entries.length;
      for (const entry of fresh) {
        const msg = { type: entry.type ?? entry.level ?? "log", text: entry.text ?? entry.message ?? "" };
        for (const handler of this.consoleHandlers) handler(msg);
      }
    } catch (err) {
      log.debug("Console poll failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
