/**
 * A media provider's signed-in tab over Orca (`openProviderTab`).
 *
 * - The tab is the one the user authorized for that provider in
 *   `FACTORY_ORCA_PROVIDER_TABS` (`providerId=browserPageId`), in the factory
 *   profile and workspace, on exactly the provider's host. Tabs authorized for
 *   the agent browser do not count.
 * - In assisted mode (`automated: false`) the tab is only shown to the user:
 *   no script runs and no navigation happens.
 * - In automated mode the provider's own scripts run through
 *   {@link OrcaPage.evaluateProviderScript}: host-checked inside the script,
 *   credentials refused on the way out. Agents never reach this channel, and
 *   FACTORY_ORCA_ALLOW_PAGE_SCRIPTS does not open it.
 * - Navigation stays on the provider's host, over https.
 */

import os from "node:os";
import type { ProviderTab, ProviderTabSpec } from "@nodetool-ai/browser";
import { ensureWorkDir, readOrcaTransportConfig } from "./config.js";
import { OrcaPolicyError } from "./errors.js";
import type { OrcaRunner } from "./orca-cli.js";
import { OrcaPage } from "./orca-page.js";
import { TabScope } from "./tab-scope.js";
import { createOrcaCli } from "./transport.js";

/** Parses `providerId=browserPageId` pairs. */
export function parseProviderTabs(raw: string | undefined): Map<string, string> {
  const tabs = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const provider = eq > 0 ? trimmed.slice(0, eq).trim() : "";
    const page = eq > 0 ? trimmed.slice(eq + 1).trim() : "";
    if (!provider || !page) throw new OrcaPolicyError(`FACTORY_ORCA_PROVIDER_TABS entry "${trimmed}" must be provider=pageId`);
    tabs.set(provider, page);
  }
  return tabs;
}

export interface OpenProviderTabOptions {
  env?: NodeJS.ProcessEnv;
  runner?: OrcaRunner;
}

export async function openOrcaProviderTab(spec: ProviderTabSpec, opts: OpenProviderTabOptions = {}): Promise<ProviderTab> {
  const env = opts.env ?? process.env;
  const config = readOrcaTransportConfig(env);
  ensureWorkDir(config.workDir);
  const pageId = parseProviderTabs(env["FACTORY_ORCA_PROVIDER_TABS"]).get(spec.providerId);
  if (!pageId) {
    throw new OrcaPolicyError(
      `No Orca tab is authorized for ${spec.providerId}. Open https://${spec.host} with the factory login helper, ` +
        `sign in, then set FACTORY_ORCA_PROVIDER_TABS=${spec.providerId}=<browserPageId>.`
    );
  }
  const cli = createOrcaCli(config, opts.runner, env);
  const scope = new TabScope(cli, {
    worktree: config.worktree,
    profileId: config.profileId,
    profileLabel: config.profileLabel,
    // Only this provider's tab: the agent browser's authorized tabs are not shared.
    authorizedPageIds: [pageId]
  });
  const info = await scope.adopt(pageId);
  const hostOf = (url: string): string | null => {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  };
  if (hostOf(info.url) !== spec.host) {
    throw new OrcaPolicyError(
      `The tab authorized for ${spec.providerId} is on ${hostOf(info.url) ?? "no web page"}, not ${spec.host}. Open https://${spec.host} in it.`
    );
  }
  const page = await OrcaPage.attach(cli, scope, pageId, {
    navigationTimeoutMs: config.navigationTimeoutMs,
    consolePollIntervalMs: 0,
    uploadRoots: [os.tmpdir(), config.workDir],
    maxEvalChars: config.maxOutputBytes,
    // The agent page-script gate stays closed; provider scripts use their own channel.
    allowPageScripts: false
  });

  const assisted = (): never => {
    throw new OrcaPolicyError(
      `${spec.providerId} runs in assisted mode on this transport: its terms leave the step to the user. Nothing was sent.`
    );
  };

  return {
    evaluate: async (expression, timeoutMs, signal) => {
      if (!spec.automated) assisted();
      return page.evaluateProviderScript(expression, spec.host, { timeoutMs, signal });
    },
    navigate: async (url) => {
      if (!spec.automated) assisted();
      const target = new URL(url);
      if (target.protocol !== "https:" || target.hostname !== spec.host) {
        throw new OrcaPolicyError(`${spec.providerId} may only navigate within https://${spec.host}`);
      }
      await page.goto(url, { waitUntil: "load" });
    },
    focus: async () => {
      await cli.run(["tab", "switch", "--page", pageId, "--worktree", config.worktree, "--focus"]);
    },
    // The tab belongs to the user; it stays open.
    release: async () => undefined
  };
}
