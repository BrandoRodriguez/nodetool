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
  /** One opened transport tab and the calls still using it. */
  interface Entry {
    key: string;
    tab: Promise<Opened>;
    users: number;
    retired: boolean;
  }
  let entry: Entry | null = null;
  let extension: ExtensionTab | null = null;

  const configKey = (): { transport: string; key: string; env: NodeJS.ProcessEnv } => {
    const env = browserEnv(opts.env ?? process.env);
    const transport = configuredProviderTransport(opts.env ?? process.env);
    return { transport, env, key: `${transport}|${env["FACTORY_ORCA_PROVIDER_TABS"] ?? ""}` };
  };

  /** Release a replaced tab once the last call using it has finished. */
  const retire = (old: Entry): void => {
    old.retired = true;
    if (old.users === 0) void old.tab.then((tab) => tab.release?.()).catch(() => undefined);
  };

  const open = (transport: string, key: string, env: NodeJS.ProcessEnv): Entry => {
    const next: Entry = {
      key,
      users: 0,
      retired: false,
      tab: (async () => {
        const { loadBrowserTransport } = await import("@nodetool-ai/browser");
        const factory = await loadBrowserTransport(transport, env);
        if (!factory.openProviderTab) {
          throw new Error(
            `Browser transport "${transport}" cannot open provider tabs. Use the extension transport, or do this step by hand in ${opts.host}.`
          );
        }
        return factory.openProviderTab({ providerId: opts.providerId, host: opts.host, automated: opts.automated });
      })()
    };
    next.tab.catch(() => {
      // A failed open is retried on the next call instead of cached.
      if (entry === next) entry = null;
    });
    return next;
  };

  type AnyTab = Pick<ExtensionTab, "evaluate" | "navigate"> & {
    download?: ExtensionTab["download"];
    focus?(): Promise<void>;
    release?(): Promise<void>;
  };

  /**
   * Run `use` on the tab the configuration names now. The tab is pinned for
   * the whole call: a configuration change meanwhile affects the next call,
   * and the replaced tab is released only after this one ends.
   */
  const withTab = async <T>(use: (tab: AnyTab) => Promise<T>): Promise<T> => {
    const end = beginBrowserOperation();
    try {
      const { transport, key, env } = configKey();
      if (transport === "extension") return await use((extension ??= createExtensionTab(opts.host)));
      if (!entry || entry.key !== key) {
        if (entry) retire(entry);
        entry = open(transport, key, env);
      }
      const pinned = entry;
      pinned.users += 1;
      try {
        return await use(await pinned.tab);
      } finally {
        pinned.users -= 1;
        if (pinned.retired && pinned.users === 0) {
          void pinned.tab.then((tab) => tab.release?.()).catch(() => undefined);
        }
      }
    } finally {
      end();
    }
  };

  return {
    evaluate: (expression, timeoutMs, signal) => withTab((tab) => tab.evaluate(expression, timeoutMs, signal)),
    navigate: (url, signal) => withTab((tab) => tab.navigate(url, signal)),
    download: async (url, timeoutMs, signal) => {
      const { transport } = configKey();
      if (transport === "extension") {
        return withTab(async () => (extension ??= createExtensionTab(opts.host)).download(url, timeoutMs, signal));
      }
      throw new Error(
        `Browser transport "${transport}" cannot load files with the browser's cookies. Download the file from ${opts.host} by hand.`
      );
    },
    focus: () => withTab(async (tab) => tab.focus?.()),
    release: async () => {
      if (!entry) return;
      const current = await entry.tab.catch(() => null);
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
