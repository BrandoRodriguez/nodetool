/**
 * Opens a provider's sign-in page in the factory profile, in front, so the
 * user signs in by hand. The session then persists in that profile for the
 * transport. Nothing is typed, read or stored by this script.
 *
 *   npm run login --workspace=packages/factory-browser-orca -- https://provider.example
 */

import { createLogger } from "@nodetool-ai/config";
import { readOrcaTransportConfig } from "./config.js";
import { createOrcaCli } from "./transport.js";
import { TabScope } from "./tab-scope.js";

const log = createLogger("factory.browser.orca.login");

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    throw new Error("Usage: login <https://provider-sign-in-url>");
  }
  const config = readOrcaTransportConfig();
  const cli = createOrcaCli(config);
  cli.policy.checkNavigationUrl(url);
  const scope = new TabScope(cli, {
    worktree: config.worktree,
    profileId: config.profileId,
    profileLabel: config.profileLabel,
    authorizedPageIds: config.authorizedPageIds
  });
  const pageId = await scope.openTab(url, true);
  log.info("Sign-in tab opened in the factory profile. Sign in there, then keep or close the tab.", {
    pageId
  });
  process.stdout.write(`${pageId}\n`);
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
