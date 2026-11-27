/**
 * What the transport may ask of Orca. Every orca invocation passes through
 * {@link OrcaPolicy.checkCommand}; anything not listed here is refused.
 *
 * - Page commands always carry `--page` and `--worktree`, and the workspace is
 *   the configured one, so Orca itself refuses a tab from another workspace.
 * - Commands that read or change cookies, profiles, downloads or other
 *   workspaces are not on the list.
 * - `exec` reaches agent-browser, which can read cookies and storage and write
 *   files, so only its read subcommands pass.
 * - Navigation is limited to http(s) and about:blank, optionally to an origin
 *   allow-list, and paced per origin so a provider never sees bursts.
 */

import path from "node:path";
import { OrcaPolicyError } from "./errors.js";

/** Commands that act on one tab. */
const PAGE_COMMANDS = new Set([
  "goto",
  "back",
  "reload",
  "click",
  "fill",
  "type",
  "keypress",
  "select",
  "check",
  "focus",
  "upload",
  "wait",
  "eval",
  "screenshot",
  "full-screenshot",
  "console",
  "network",
  "capture start",
  "mouse move",
  "mouse down",
  "mouse up",
  "mouse wheel",
  "exec",
  "tab show",
  "tab close"
]);

/** Commands with no tab. */
const GLOBAL_COMMANDS = new Set(["status", "tab profile list", "tab create"]);

/** Commands that change the page, paced per origin and never retried. */
const MUTATING = new Set([
  "goto",
  "back",
  "reload",
  "click",
  "fill",
  "type",
  "keypress",
  "select",
  "check",
  "upload",
  "mouse down",
  "mouse up",
  "mouse wheel",
  "exec"
]);

/** agent-browser subcommands `exec` may run: reads and history only, no files. */
const EXEC_ALLOWED = new Set(["get", "is", "forward"]);

/** Flags that would widen the target beyond one workspace. */
const FORBIDDEN_FLAG_VALUES = new Map([["--worktree", new Set(["all", "active", "current"])]]);

export interface OrcaPolicyOptions {
  worktree: string;
  allowedOrigins: string[];
  minActionIntervalMs: number;
  maxNavigationsPerMinute: number;
  now?: () => number;
}

/** The command name of an argv: one word, or two for `tab …`, `mouse …`, `capture …`. */
export function commandName(args: readonly string[]): string {
  const [first = "", second = ""] = args;
  if (first === "tab" && second === "profile") return `tab profile ${args[2] ?? ""}`.trim();
  if (first === "tab" || first === "mouse" || first === "capture") return `${first} ${second}`;
  return first;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export class OrcaPolicy {
  private readonly opts: OrcaPolicyOptions;
  private readonly lastActionAt = new Map<string, number>();
  private readonly navigations = new Map<string, number[]>();

  constructor(opts: OrcaPolicyOptions) {
    this.opts = opts;
  }

  isMutating(args: readonly string[]): boolean {
    return MUTATING.has(commandName(args));
  }

  /** Throws {@link OrcaPolicyError} unless the argv is allowed. */
  checkCommand(args: readonly string[]): void {
    const name = commandName(args);
    if (!PAGE_COMMANDS.has(name) && !GLOBAL_COMMANDS.has(name)) {
      throw new OrcaPolicyError(`orca ${name || "(empty)"} is not allowed by the factory transport`);
    }
    for (const [flag, banned] of FORBIDDEN_FLAG_VALUES) {
      const value = flagValue(args, flag);
      if (value !== undefined && banned.has(value)) {
        throw new OrcaPolicyError(`${flag} ${value} is not allowed`);
      }
    }
    const worktree = flagValue(args, "--worktree");
    if (worktree !== undefined && worktree !== this.opts.worktree) {
      throw new OrcaPolicyError(`Workspace ${worktree} is not the factory workspace`);
    }
    if (PAGE_COMMANDS.has(name)) {
      if (!flagValue(args, "--page")) {
        throw new OrcaPolicyError(`orca ${name} must name its tab with --page`);
      }
      if (worktree === undefined) {
        throw new OrcaPolicyError(`orca ${name} must be pinned with --worktree`);
      }
    }
    if (name === "tab create") {
      if (worktree === undefined || !flagValue(args, "--profile")) {
        throw new OrcaPolicyError("orca tab create needs the factory --worktree and --profile");
      }
      this.checkNavigationUrl(flagValue(args, "--url") ?? "about:blank");
    }
    if (name === "goto") {
      this.checkNavigationUrl(flagValue(args, "--url") ?? "");
    }
    if (name === "exec") {
      this.checkExec(flagValue(args, "--command") ?? "");
    }
  }

  /** http(s) and about:blank, inside the allow-list when one is configured. */
  checkNavigationUrl(raw: string): void {
    if (raw === "about:blank") return;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new OrcaPolicyError(`Not a URL: ${raw.slice(0, 200)}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new OrcaPolicyError(`Navigation to ${url.protocol} URLs is not allowed`);
    }
    const allowed = this.opts.allowedOrigins;
    if (allowed.length > 0 && !allowed.some((entry) => originMatches(entry, url))) {
      throw new OrcaPolicyError(`${url.origin} is not in FACTORY_ORCA_ALLOWED_ORIGINS`);
    }
  }

  private checkExec(command: string): void {
    const [sub = ""] = command.trim().split(/\s+/);
    if (!EXEC_ALLOWED.has(sub)) {
      throw new OrcaPolicyError(`exec ${sub || "(empty)"} is not allowed by the factory transport`);
    }
  }

  /**
   * Waits until the origin may take another action, and counts navigations.
   * Throws when the navigation budget for the minute is spent: waiting it out
   * silently would hide a runaway loop.
   */
  async pace(origin: string | null, navigation: boolean): Promise<void> {
    const now = this.opts.now ?? Date.now;
    const key = origin ?? "(none)";
    if (navigation) {
      const windowStart = now() - 60_000;
      const recent = (this.navigations.get(key) ?? []).filter((t) => t > windowStart);
      if (recent.length >= this.opts.maxNavigationsPerMinute) {
        throw new OrcaPolicyError(
          `More than ${this.opts.maxNavigationsPerMinute} navigations to ${key} in a minute`
        );
      }
      recent.push(now());
      this.navigations.set(key, recent);
    }
    const last = this.lastActionAt.get(key);
    const wait = last === undefined ? 0 : last + this.opts.minActionIntervalMs - now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastActionAt.set(key, now());
  }
}

function originMatches(entry: string, url: URL): boolean {
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(1);
    return url.protocol === "https:" && (url.hostname.endsWith(suffix) || url.hostname === entry.slice(2));
  }
  try {
    return new URL(entry).origin === url.origin;
  } catch {
    return false;
  }
}

/** Whether `target` resolves inside `dir`. */
export function isInside(dir: string, target: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(target));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}
