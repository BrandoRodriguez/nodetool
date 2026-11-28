/**
 * Browser transports beyond the built-in `local` and `extension`.
 *
 * A transport is a factory that opens a {@link BrowserPage} session. It is
 * registered in process with {@link registerBrowserTransport}, or loaded on
 * first use from a module named in `NODETOOL_BROWSER_TRANSPORT_MODULES`
 * (`id=module-specifier`, comma-separated). The module exports the factory as
 * `browserTransport`. `NODETOOL_BROWSER_TRANSPORT=<id>` selects it.
 *
 * The built-in transports never go through this registry, so registering or
 * failing to load a module cannot change how they behave.
 */

import type { BrowserPage } from "./browser-page.js";
import { browserEnv } from "./browser-config.js";
import type {
  BrowserCaptureMediaInput,
  BrowserCaptureMediaRaw
} from "./schemas.js";

/** Ids the action loop handles itself. A registered transport cannot take them. */
export const BUILTIN_BROWSER_TRANSPORTS = ["local", "extension"] as const;

/**
 * What a transport can and cannot do, declared up front so callers and agents
 * can see a limitation instead of discovering it as a failure.
 */
export interface BrowserTransportCapabilities {
  /** `Network.getResponseBody` style access to bodies the page already fetched. */
  networkResponseBodies: boolean;
  /** How console messages arrive: as events, by polling, or not at all. */
  consoleMessages: "events" | "polling" | "none";
  /** Raw Chrome DevTools Protocol commands. */
  rawCdp: boolean;
  /** Mouse and keyboard input by viewport coordinates. */
  coordinateInput: boolean;
  /** The caller chooses where a page download is saved. */
  downloadPath: boolean;
  /** The page can carry a session the user signed in to by hand. */
  signedInSessions: boolean;
  /** Largest media capture in bytes, or null when the transport sets no limit. */
  maxMediaBytes: number | null;
  /** Limitations a caller should know, in plain sentences. */
  limitations: string[];
}

export interface BrowserTransportSession {
  page: BrowserPage;
  close(): Promise<void>;
  capabilities: BrowserTransportCapabilities;
  /**
   * Replaces the in-page capture rung when present, so a transport can bound
   * memory or read bytes its own way.
   */
  captureMedia?(input: BrowserCaptureMediaInput): Promise<BrowserCaptureMediaRaw>;
}

/**
 * What a media provider asks a transport for: the signed-in tab of one site.
 * `automated` says whether the provider's own scripts may run in it; when
 * false the tab is only shown to the user, who does the work by hand.
 */
export interface ProviderTabSpec {
  providerId: string;
  /** The site's host, e.g. `chatgpt.com`. The tab must be on exactly this host. */
  host: string;
  automated: boolean;
}

/**
 * A provider's signed-in tab. This is a channel for the provider's own fixed
 * scripts, kept apart from the agent browser actions: an agent never reaches
 * it, so the agent page-script setting does not apply here.
 */
export interface ProviderTab {
  /** Run one of the provider's scripts (a JS expression, may be a promise) and return its JSON value. */
  evaluate(expression: string, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>;
  /** Navigate within the provider's host and wait for the load event. */
  navigate(url: string, signal?: AbortSignal): Promise<void>;
  /** Bring the tab in front of the user, for a step only the user may take. */
  focus?(): Promise<void>;
  /** End this use of the tab. The tab itself stays open. */
  release?(): Promise<void>;
}

export interface BrowserTransportFactory {
  /** The value of `NODETOOL_BROWSER_TRANSPORT` that selects this transport. */
  id: string;
  /** One sentence for `browser_status`: what the transport drives. */
  describe(): string;
  open(opts: {
    viewport: { width: number; height: number };
  }): Promise<BrowserTransportSession>;
  /** A provider's signed-in tab. Absent when the transport cannot serve providers. */
  openProviderTab?(spec: ProviderTabSpec): Promise<ProviderTab>;
  /**
   * What the transport can say about itself right now, without touching any
   * site: whether it is reachable, and for each provider tab given whether
   * that tab exists on the provider's host. Absent when it cannot tell.
   */
  status?(providerTabs: Readonly<Record<string, { pageId: string; host: string }>>): Promise<BrowserTransportStatus>;
  /**
   * Open a new tab on `url` in the transport's own profile, for the user to
   * sign in by hand. Answers the tab id to authorize for the provider.
   */
  openSignInTab?(url: string): Promise<string>;
}

export interface BrowserTransportStatus {
  connected: boolean;
  /** Why not, or what to check, when `connected` is false. */
  detail?: string;
  tabs: Record<string, { exists: boolean; onHost: boolean; detail?: string }>;
}

const registry = new Map<string, BrowserTransportFactory>();

function isBuiltin(id: string): boolean {
  return (BUILTIN_BROWSER_TRANSPORTS as readonly string[]).includes(id);
}

export function registerBrowserTransport(factory: BrowserTransportFactory): void {
  if (isBuiltin(factory.id)) {
    throw new Error(`Browser transport "${factory.id}" is built in and cannot be replaced`);
  }
  registry.set(factory.id, factory);
}

export function unregisterBrowserTransport(id: string): void {
  registry.delete(id);
}

/** Parses `NODETOOL_BROWSER_TRANSPORT_MODULES` into id → module specifier. */
export function parseTransportModules(raw: string | undefined): Map<string, string> {
  const modules = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const id = eq > 0 ? trimmed.slice(0, eq).trim() : "";
    const specifier = eq > 0 ? trimmed.slice(eq + 1).trim() : "";
    if (!id || !specifier) {
      throw new Error(
        `NODETOOL_BROWSER_TRANSPORT_MODULES entry "${trimmed}" must be id=module`
      );
    }
    modules.set(id, specifier);
  }
  return modules;
}

function isTransportFactory(value: unknown): value is BrowserTransportFactory {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["describe"] === "function" &&
    typeof v["open"] === "function"
  );
}

/**
 * The factory for a non-built-in transport id, importing its module from
 * `NODETOOL_BROWSER_TRANSPORT_MODULES` the first time it is asked for.
 */
export async function loadBrowserTransport(
  id: string,
  env: NodeJS.ProcessEnv = browserEnv()
): Promise<BrowserTransportFactory> {
  const registered = registry.get(id);
  if (registered) return registered;
  if (isBuiltin(id)) {
    throw new Error(`Browser transport "${id}" is built in and has no factory`);
  }
  const specifier = parseTransportModules(env["NODETOOL_BROWSER_TRANSPORT_MODULES"]).get(id);
  if (!specifier) {
    throw new Error(
      `Unknown browser transport "${id}". Built in: ${BUILTIN_BROWSER_TRANSPORTS.join(", ")}. ` +
        "Register it, or name its module in NODETOOL_BROWSER_TRANSPORT_MODULES (id=module)."
    );
  }
  const mod = (await import(specifier)) as Record<string, unknown>;
  const factory = mod["browserTransport"];
  if (!isTransportFactory(factory)) {
    throw new Error(`Module "${specifier}" does not export a browserTransport factory`);
  }
  if (factory.id !== id) {
    throw new Error(
      `Module "${specifier}" exports transport "${factory.id}", not "${id}"`
    );
  }
  registerBrowserTransport(factory);
  return factory;
}
