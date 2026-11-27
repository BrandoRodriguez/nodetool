/**
 * Configuration of the Orca transport, read from the environment once per
 * session. Every value has a safe default except the workspace, which must be
 * named: the transport never guesses which Orca workspace it may use.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrcaPolicyError } from "./errors.js";

export const DEFAULT_PROFILE_LABEL = "AI Content Factory";
const MB = 1024 * 1024;
/** No configuration may raise media captures above this. */
export const MEDIA_BYTES_CEILING = 256 * MB;

export interface OrcaTransportConfig {
  /** The orca executable (absolute path or a name on PATH). */
  executable: string;
  /** Orca workspace selector every page command is pinned to, e.g. `path:/…`. */
  worktree: string;
  /** Profile id; when unset the profile is found by {@link profileLabel}. */
  profileId: string | null;
  profileLabel: string;
  /** Existing tabs the user authorized, by browserPageId. */
  authorizedPageIds: string[];
  /** Reuse this tab instead of opening one. It must be authorized or owned. */
  pageId: string | null;
  /** Keep tabs this transport opened when the session closes. */
  keepTabs: boolean;
  commandTimeoutMs: number;
  navigationTimeoutMs: number;
  maxConcurrentCommands: number;
  maxOutputBytes: number;
  maxMediaBytes: number;
  mediaChunkBytes: number;
  /** Navigation is refused outside these origins when the list is not empty. */
  allowedOrigins: string[];
  /** Minimum gap between two actions on the same origin. */
  minActionIntervalMs: number;
  /** Navigations allowed per origin per minute. */
  maxNavigationsPerMinute: number;
  /** Milliseconds between console polls. 0 turns polling off. */
  consolePollIntervalMs: number;
  /** The only directory this package writes to. */
  workDir: string;
}

function intFrom(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new OrcaPolicyError(`${key} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function listFrom(env: NodeJS.ProcessEnv, key: string): string[] {
  return (env[key] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The orca executable, following the resolution order Orca documents. */
export function resolveOrcaExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["FACTORY_ORCA_CLI"]?.trim();
  if (explicit) return explicit;
  const session = env["ORCA_CLI_COMMAND"]?.trim();
  if (session) return session;
  // On Linux a bare `orca` is usually the GNOME screen reader.
  return process.platform === "linux" ? "orca-ide" : "orca";
}

/**
 * The directory this package may write to: inside `FACTORY_DEV_ENV_DIR` when
 * that is set, otherwise inside the process temp directory (which the factory
 * environment points at its own folder).
 */
export function resolveWorkDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = path.resolve(env["FACTORY_DEV_ENV_DIR"]?.trim() || os.tmpdir());
  const requested = env["FACTORY_ORCA_WORK_DIR"]?.trim();
  const workDir = path.resolve(requested || path.join(root, "factory-browser-orca"));
  const relative = path.relative(root, workDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new OrcaPolicyError(`FACTORY_ORCA_WORK_DIR (${workDir}) must be inside ${root}`);
  }
  return workDir;
}

/** Creates the work directory, private to this user. */
export function ensureWorkDir(workDir: string): string {
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  return workDir;
}

export function readOrcaTransportConfig(env: NodeJS.ProcessEnv = process.env): OrcaTransportConfig {
  const worktree = env["FACTORY_ORCA_WORKTREE"]?.trim();
  if (!worktree) {
    throw new OrcaPolicyError(
      "FACTORY_ORCA_WORKTREE is not set. Name the Orca workspace the transport may use, e.g. path:/…/AI Content Factory"
    );
  }
  if (worktree === "all" || worktree === "active" || worktree === "current") {
    throw new OrcaPolicyError(`FACTORY_ORCA_WORKTREE must name one workspace, not "${worktree}"`);
  }
  const maxMediaBytes = intFrom(env, "FACTORY_ORCA_MAX_MEDIA_BYTES", 64 * MB, 1, MEDIA_BYTES_CEILING);
  return {
    executable: resolveOrcaExecutable(env),
    worktree,
    profileId: env["FACTORY_ORCA_PROFILE_ID"]?.trim() || null,
    profileLabel: env["FACTORY_ORCA_PROFILE_LABEL"]?.trim() || DEFAULT_PROFILE_LABEL,
    authorizedPageIds: listFrom(env, "FACTORY_ORCA_AUTHORIZED_PAGES"),
    pageId: env["FACTORY_ORCA_PAGE_ID"]?.trim() || null,
    keepTabs: env["FACTORY_ORCA_KEEP_TABS"] === "1",
    commandTimeoutMs: intFrom(env, "FACTORY_ORCA_COMMAND_TIMEOUT_MS", 30_000, 1_000, 600_000),
    navigationTimeoutMs: intFrom(env, "FACTORY_ORCA_NAVIGATION_TIMEOUT_MS", 60_000, 1_000, 600_000),
    maxConcurrentCommands: intFrom(env, "FACTORY_ORCA_MAX_CONCURRENT", 4, 1, 16),
    // Room for one media chunk in base64 plus the JSON envelope.
    maxOutputBytes: intFrom(env, "FACTORY_ORCA_MAX_OUTPUT_BYTES", 32 * MB, 1 * MB, 128 * MB),
    maxMediaBytes,
    mediaChunkBytes: intFrom(env, "FACTORY_ORCA_MEDIA_CHUNK_BYTES", 4 * MB, 64 * 1024, 16 * MB),
    allowedOrigins: listFrom(env, "FACTORY_ORCA_ALLOWED_ORIGINS"),
    minActionIntervalMs: intFrom(env, "FACTORY_ORCA_MIN_ACTION_INTERVAL_MS", 250, 0, 60_000),
    maxNavigationsPerMinute: intFrom(env, "FACTORY_ORCA_MAX_NAVIGATIONS_PER_MINUTE", 30, 1, 600),
    consolePollIntervalMs: intFrom(env, "FACTORY_ORCA_CONSOLE_POLL_MS", 2_000, 0, 600_000),
    workDir: resolveWorkDir(env)
  };
}
