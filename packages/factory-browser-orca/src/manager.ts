/**
 * What the Provider Manager asks of the Orca transport: its live status and a
 * sign-in tab. Both use only the public CLI commands the policy already
 * allows (`status`, `tab profile list`, `tab show`, `tab create`) and never
 * read a page: a tab is described by its id, profile and address alone.
 */

import type { BrowserTransportStatus } from "@nodetool-ai/browser";
import { readOrcaTransportConfig, ensureWorkDir } from "./config.js";
import { createOrcaCli } from "./transport.js";
import { TabScope } from "./tab-scope.js";
import type { OrcaRunner } from "./orca-cli.js";

export interface OrcaManagerOptions {
  env?: NodeJS.ProcessEnv;
  runner?: OrcaRunner;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/**
 * Orca reachable and ready, the factory profile present, and for each given
 * provider tab whether it is in that profile and workspace and on the
 * provider's host. Nothing here tells whether the user is signed in.
 */
export async function orcaTransportStatus(
  providerTabs: Readonly<Record<string, { pageId: string; host: string }>>,
  opts: OrcaManagerOptions = {}
): Promise<BrowserTransportStatus> {
  const env = opts.env ?? process.env;
  const tabs: BrowserTransportStatus["tabs"] = {};
  const notChecked = (detail: string): BrowserTransportStatus => {
    for (const provider of Object.keys(providerTabs)) tabs[provider] = { exists: false, onHost: false, detail };
    return { connected: false, detail, tabs };
  };

  let config: ReturnType<typeof readOrcaTransportConfig>;
  try {
    config = readOrcaTransportConfig(env);
  } catch (error) {
    return notChecked(message(error));
  }
  const cli = createOrcaCli(config, opts.runner, env);
  try {
    const status = await cli.run<{ app?: { running?: boolean }; runtime?: { state?: string } }>(["status"]);
    if (status.app?.running === false || (status.runtime?.state && status.runtime.state !== "ready")) {
      return notChecked("Orca is not running or not ready.");
    }
  } catch (error) {
    return notChecked(message(error));
  }

  for (const [provider, { pageId, host }] of Object.entries(providerTabs)) {
    const scope = new TabScope(cli, {
      worktree: config.worktree,
      profileId: config.profileId,
      profileLabel: config.profileLabel,
      authorizedPageIds: [pageId]
    });
    try {
      const info = await scope.adopt(pageId);
      const onHost = hostOf(info.url) === host;
      tabs[provider] = onHost
        ? { exists: true, onHost }
        : { exists: true, onHost, detail: `The tab is on ${hostOf(info.url) ?? "no web page"}, not ${host}.` };
    } catch (error) {
      tabs[provider] = { exists: false, onHost: false, detail: message(error) };
    }
  }

  try {
    await new TabScope(cli, {
      worktree: config.worktree,
      profileId: config.profileId,
      profileLabel: config.profileLabel,
      authorizedPageIds: []
    }).resolveProfile();
  } catch (error) {
    return { connected: false, detail: message(error), tabs };
  }
  return { connected: true, tabs };
}

/**
 * Open `url` in a new, focused tab of the factory profile and workspace, for
 * the user to sign in by hand. Answers the tab id. The navigation allowlist
 * applies, as for every other tab the transport opens.
 */
export async function openOrcaSignInTab(url: string, opts: OrcaManagerOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const config = readOrcaTransportConfig(env);
  ensureWorkDir(config.workDir);
  const cli = createOrcaCli(config, opts.runner, env);
  cli.policy.checkNavigationUrl(url);
  const scope = new TabScope(cli, {
    worktree: config.worktree,
    profileId: config.profileId,
    profileLabel: config.profileLabel,
    authorizedPageIds: []
  });
  return scope.openTab(url, true);
}
