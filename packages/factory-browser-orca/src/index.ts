/**
 * AI Content Factory: NodeTool browser transport for the Orca built-in browser.
 *
 * Selected with `NODETOOL_BROWSER_TRANSPORT=orca` and
 * `NODETOOL_BROWSER_TRANSPORT_MODULES=orca=@nodetool-ai/factory-browser-orca`.
 */

export { browserTransport, openOrcaSession, orcaCapabilities, createOrcaCli, ORCA_TRANSPORT_ID } from "./transport.js";
export { OrcaCli, spawnRunner, type OrcaRunner, type RunnerOptions, type RunnerResult } from "./orca-cli.js";
export { OrcaPage, assertNoCredentials, buildEvalExpression, decodeEvalResult } from "./orca-page.js";
export { openOrcaProviderTab, parseProviderTabs } from "./provider-tab.js";
export { OrcaPolicy, commandName, isInside } from "./policy.js";
export { TabScope, type OrcaProfile, type OrcaTabInfo } from "./tab-scope.js";
export { MediaCapture, retryAfterSeconds, type RateLimitGate } from "./media.js";
export {
  readOrcaTransportConfig,
  resolveOrcaExecutable,
  resolveWorkDir,
  DEFAULT_PROFILE_LABEL,
  MEDIA_BYTES_CEILING,
  type OrcaTransportConfig
} from "./config.js";
export * from "./errors.js";
