/**
 * The one place browser configuration is read from.
 *
 * Agents (the `browser_*` tools), storyboard and workflow providers all reach
 * a browser through this package, so they all read the transport and the
 * per-provider tabs through {@link browserEnv}. The values come from the
 * process environment, overlaid by what the app saved (the Provider Manager):
 * a saved value wins over the environment, and an unsaved one falls back to it.
 *
 * Only these keys can be overlaid. In particular nothing saved can name a
 * transport module (that would load arbitrary code) or turn off the provider
 * terms policy: those stay environment-only.
 */

/** Transports a saved configuration may select. */
export const SELECTABLE_BROWSER_TRANSPORTS = ["local", "extension", "orca"] as const;
export type SelectableBrowserTransport = (typeof SELECTABLE_BROWSER_TRANSPORTS)[number];

/** The module of the one non-built-in transport a saved configuration may select. */
const KNOWN_TRANSPORT_MODULES: Readonly<Record<string, string>> = {
  orca: "@nodetool-ai/factory-browser-orca"
};

export interface SavedBrowserConfig {
  transport?: SelectableBrowserTransport;
  /** Provider id → authorized tab id, for transports that serve provider tabs. */
  providerTabs?: Record<string, string>;
}

let saved: SavedBrowserConfig = {};

export function isSelectableBrowserTransport(value: unknown): value is SelectableBrowserTransport {
  return typeof value === "string" && (SELECTABLE_BROWSER_TRANSPORTS as readonly string[]).includes(value);
}

/** Replace the saved configuration. Values that are not allowed are dropped. */
export function setSavedBrowserConfig(config: SavedBrowserConfig): void {
  const next: SavedBrowserConfig = {};
  if (isSelectableBrowserTransport(config.transport)) next.transport = config.transport;
  if (config.providerTabs) {
    const tabs: Record<string, string> = {};
    for (const [provider, page] of Object.entries(config.providerTabs)) {
      if (/^[a-z0-9_]{1,64}$/.test(provider) && /^[A-Za-z0-9-]{1,128}$/.test(page)) tabs[provider] = page;
    }
    next.providerTabs = tabs;
  }
  saved = next;
}

export function getSavedBrowserConfig(): SavedBrowserConfig {
  return {
    ...(saved.transport ? { transport: saved.transport } : {}),
    ...(saved.providerTabs ? { providerTabs: { ...saved.providerTabs } } : {})
  };
}

/**
 * The environment browser code reads: `env` with the saved values on top.
 * Saved provider tabs are written as `FACTORY_ORCA_PROVIDER_TABS`; selecting
 * a known external transport also names its module when the environment
 * does not.
 */
export function browserEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (saved.transport) {
    out["NODETOOL_BROWSER_TRANSPORT"] = saved.transport;
    const module = KNOWN_TRANSPORT_MODULES[saved.transport];
    const modules = out["NODETOOL_BROWSER_TRANSPORT_MODULES"] ?? "";
    if (module && !modules.split(",").some((entry) => entry.trim().startsWith(`${saved.transport}=`))) {
      out["NODETOOL_BROWSER_TRANSPORT_MODULES"] = [modules, `${saved.transport}=${module}`].filter(Boolean).join(",");
    }
  }
  if (saved.providerTabs) {
    out["FACTORY_ORCA_PROVIDER_TABS"] = Object.entries(saved.providerTabs)
      .map(([provider, page]) => `${provider}=${page}`)
      .join(",");
  }
  return out;
}

/** The transport in effect: `local`, `extension` or a registered transport id. */
export function effectiveBrowserTransport(env: NodeJS.ProcessEnv = process.env): string {
  const value = browserEnv(env)["NODETOOL_BROWSER_TRANSPORT"]?.trim();
  return value ? value : "local";
}

// ── Work in flight ───────────────────────────────────────────────────────────

let inFlight = 0;

/**
 * Count one browser operation (a provider tab call) while it runs, so the
 * transport is not switched under it. Call the returned function when done.
 */
export function beginBrowserOperation(): () => void {
  inFlight += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    inFlight -= 1;
  };
}

/** Browser operations running now. */
export function activeBrowserOperations(): number {
  return inFlight;
}
