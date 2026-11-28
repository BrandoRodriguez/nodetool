/**
 * The signed-in tab a browser-driven provider runs in, on whichever browser
 * transport the user configured.
 *
 * `NODETOOL_BROWSER_TRANSPORT` unset, `local` or `extension` keeps the
 * original path: the tab in the user's Chrome behind the NodeTool extension
 * ({@link createExtensionTab}). Any other value names a transport from the
 * `@nodetool-ai/browser` registry, which serves the tab through its
 * `openProviderTab`. Either way the provider gets an {@link ExtensionTab}, so
 * its logic is written once.
 */

import { beginBrowserOperation, browserEnv } from "@nodetool-ai/browser";
import { createExtensionTab, type ExtensionTab } from "./extension-tab.js";
import { BROWSER_PROVIDER_TERMS } from "./browser-provider-terms.js";

const EXTENSION_TRANSPORTS = new Set(["", "local", "extension"]);

export interface ResolveProviderTabOptions {
  providerId: string;
  host: string;
  /** Whether the provider's own scripts may run in the tab. */
  automated: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * The configured transport id, `extension` for the original path. Read from
 * the shared browser configuration (saved settings over the environment).
 */
export function configuredProviderTransport(env: NodeJS.ProcessEnv = process.env): string {
  const value = browserEnv(env)["NODETOOL_BROWSER_TRANSPORT"]?.trim() ?? "";
  return EXTENSION_TRANSPORTS.has(value) ? "extension" : value;
}

type Opened = Awaited<ReturnType<NonNullable<import("@nodetool-ai/browser").BrowserTransportFactory["openProviderTab"]>>>;

/**
 * The provider's tab. The transport opens lazily, on the first call, so
 * listing models or building a provider never touches a browser. Each call
 * reads the configuration again: after the transport or the authorized tab
 * changes, the next call opens the new one. Every call counts as browser work
 * in flight while it runs.
 */
export function resolveProviderTab(opts: ResolveProviderTabOptions): ExtensionTab & { focus?(): Promise<void> } {
  let openedKey = "";
  let opened: Promise<Opened> | null = null;
  let extension: ExtensionTab | null = null;

  const configKey = (): { transport: string; key: string; env: NodeJS.ProcessEnv } => {
    const env = browserEnv(opts.env ?? process.env);
    const transport = configuredProviderTransport(opts.env ?? process.env);
    return { transport, env, key: `${transport}|${env["FACTORY_ORCA_PROVIDER_TABS"] ?? ""}` };
  };

  const transportTab = (): Promise<Opened> => {
    const { transport, key, env } = configKey();
    if (opened && openedKey === key) return opened;
    const previous = opened;
    openedKey = key;
    opened = (async () => {
      if (previous) await previous.then((tab) => tab.release?.()).catch(() => undefined);
      const { loadBrowserTransport } = await import("@nodetool-ai/browser");
      const factory = await loadBrowserTransport(transport, env);
      if (!factory.openProviderTab) {
        throw new Error(
          `Browser transport "${transport}" cannot open provider tabs. Use the extension transport, or do this step by hand in ${opts.host}.`
        );
      }
      return factory.openProviderTab({ providerId: opts.providerId, host: opts.host, automated: opts.automated });
    })().catch((error: unknown) => {
      // A failed open is retried on the next call instead of cached.
      opened = null;
      throw error;
    });
    return opened;
  };

  type AnyTab = Pick<ExtensionTab, "evaluate" | "navigate"> & {
    download?: ExtensionTab["download"];
    focus?(): Promise<void>;
    release?(): Promise<void>;
  };
  const tab = async (): Promise<AnyTab> => {
    if (configKey().transport === "extension") return (extension ??= createExtensionTab(opts.host));
    return transportTab();
  };

  const tracked = async <T>(run: () => Promise<T>): Promise<T> => {
    const end = beginBrowserOperation();
    try {
      return await run();
    } finally {
      end();
    }
  };

  return {
    evaluate: (expression, timeoutMs, signal) => tracked(async () => (await tab()).evaluate(expression, timeoutMs, signal)),
    navigate: (url, signal) => tracked(async () => (await tab()).navigate(url, signal)),
    download: async (url, timeoutMs, signal) => {
      const { transport } = configKey();
      if (transport === "extension") return tracked(async () => (extension ??= createExtensionTab(opts.host)).download(url, timeoutMs, signal));
      throw new Error(
        `Browser transport "${transport}" cannot load files with the browser's cookies. Download the file from ${opts.host} by hand.`
      );
    },
    focus: async () => {
      const current = await tab();
      await current.focus?.();
    },
    release: async () => {
      if (!opened) return;
      const current = await opened.catch(() => null);
      await current?.release?.();
    }
  };
}

/**
 * Bring a browser provider's authorized tab in front of the user, for a step
 * left to them. Runs no script and sends nothing to the site. Answers false
 * when the transport cannot show a tab (the extension), so the caller can
 * open the site's address instead.
 */
export async function showProviderTab(providerId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const terms = BROWSER_PROVIDER_TERMS[providerId];
  if (!terms) throw new Error(`Unknown browser provider "${providerId}"`);
  if (configuredProviderTransport(env) === "extension") return false;
  const tab = resolveProviderTab({ providerId, host: terms.host, automated: false, env });
  await tab.focus?.();
  return true;
}
