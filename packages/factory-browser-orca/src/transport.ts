/**
 * The `orca` browser transport: a NodeTool browser session on a tab of the
 * Orca built-in browser, in the isolated "AI Content Factory" profile.
 */

import os from "node:os";
import path from "node:path";
import type {
  BrowserTransportCapabilities,
  BrowserTransportFactory,
  BrowserTransportSession
} from "@nodetool-ai/browser";
import { ensureWorkDir, readOrcaTransportConfig, type OrcaTransportConfig } from "./config.js";
import { OrcaUnavailableError } from "./errors.js";
import { MediaCapture } from "./media.js";
import { OrcaCli, type OrcaRunner } from "./orca-cli.js";
import { OrcaPage } from "./orca-page.js";
import { OrcaPolicy } from "./policy.js";
import { TabScope } from "./tab-scope.js";

export const ORCA_TRANSPORT_ID = "orca";

/** What this transport can and cannot do, for `browser_status` and callers. */
export function orcaCapabilities(config: Pick<OrcaTransportConfig, "maxMediaBytes">): BrowserTransportCapabilities {
  return {
    networkResponseBodies: false,
    consoleMessages: "polling",
    rawCdp: false,
    coordinateInput: true,
    downloadPath: false,
    signedInSessions: true,
    maxMediaBytes: config.maxMediaBytes,
    limitations: [
      "No raw CDP: Orca exposes only its public CLI, so Network events and response bodies are unavailable.",
      "Media is captured by an in-page fetch with the page's session; one-time URLs, MSE streams and DRM content cannot be captured.",
      "Console messages are polled after actions, not streamed.",
      "A link that downloads a file is saved by Orca in the user's Downloads folder; use capture_media instead.",
      "Each command is one CLI call (about 120 ms for a read, 300 ms for an action).",
      "Passkeys, security keys, captchas and other sign-in steps are left to the user in the Orca tab.",
      "Only tabs opened by the factory or listed in FACTORY_ORCA_AUTHORIZED_PAGES are driven."
    ]
  };
}

export interface OpenOrcaSessionOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected in tests instead of spawning orca. */
  runner?: OrcaRunner;
}

export function createOrcaCli(config: OrcaTransportConfig, runner?: OrcaRunner, env?: NodeJS.ProcessEnv): OrcaCli {
  const policy = new OrcaPolicy({
    worktree: config.worktree,
    allowedOrigins: config.allowedOrigins,
    minActionIntervalMs: config.minActionIntervalMs,
    maxNavigationsPerMinute: config.maxNavigationsPerMinute
  });
  return new OrcaCli({
    executable: config.executable,
    policy,
    defaultTimeoutMs: config.commandTimeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    maxConcurrent: config.maxConcurrentCommands,
    env,
    runner
  });
}

/** Opens a session: checks Orca, the profile and the tab, then attaches. */
export async function openOrcaSession(opts: OpenOrcaSessionOptions = {}): Promise<BrowserTransportSession & { page: OrcaPage }> {
  const env = opts.env ?? process.env;
  const config = readOrcaTransportConfig(env);
  ensureWorkDir(config.workDir);
  const cli = createOrcaCli(config, opts.runner, env);

  const status = await cli.run<{ app?: { running?: boolean }; runtime?: { state?: string } }>(["status"]);
  if (status.app?.running === false || (status.runtime?.state && status.runtime.state !== "ready")) {
    throw new OrcaUnavailableError("Orca is not running or not ready. Open Orca and try again.");
  }

  const scope = new TabScope(cli, {
    worktree: config.worktree,
    profileId: config.profileId,
    profileLabel: config.profileLabel,
    authorizedPageIds: config.authorizedPageIds
  });
  const pageId = config.pageId ?? (await scope.openTab());
  if (config.pageId) await scope.adopt(config.pageId);

  const page = await OrcaPage.attach(cli, scope, pageId, {
    navigationTimeoutMs: config.navigationTimeoutMs,
    consolePollIntervalMs: config.consolePollIntervalMs,
    // The core upload path writes its temp files under os.tmpdir().
    uploadRoots: [os.tmpdir(), path.dirname(config.workDir)],
    maxEvalChars: config.maxOutputBytes
  });
  const media = new MediaCapture({ maxBytes: config.maxMediaBytes, chunkBytes: config.mediaChunkBytes });

  return {
    page,
    capabilities: orcaCapabilities(config),
    captureMedia: (input) => media.capture(page, input),
    close: async () => {
      if (!config.keepTabs) await scope.closeTab(pageId);
    }
  };
}

export const browserTransport: BrowserTransportFactory = {
  id: ORCA_TRANSPORT_ID,
  describe: () =>
    "Driving a tab of the Orca built-in browser in the isolated \"AI Content Factory\" profile. " +
    "It carries only the sessions you signed in to by hand in that profile; NodeTool never reads its cookies. " +
    "No raw CDP: response bodies, streamed console events and download paths are unavailable.",
  open: () => openOrcaSession()
};
