/**
 * Provider Manager (AI Content Factory): one place to see and configure the
 * providers. Local profile only.
 *
 * It keeps four things apart:
 * - transport connected: the browser transport answers (the extension's
 *   native host, Orca and its factory profile);
 * - provider configured: what the provider needs is present (an API key, a
 *   local server setting; nothing for a browser site);
 * - tab authorized: the tab saved for a browser provider exists, in the
 *   factory profile, on the provider's host;
 * - session authenticated: never claimed for a browser site. Telling would
 *   mean reading the signed-in page, which the provider terms policy forbids.
 *
 * Nothing here sends anything to a provider or reads a page.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router } from "../index.js";
import { protectedProcedure } from "../middleware.js";
import {

  FACTORY_BROWSER_PROVIDERS,
  capabilityGroups,
  factoryBrowserProvider,
  type ManagedProvider
} from "@nodetool-ai/protocol";
import {
  SELECTABLE_BROWSER_TRANSPORTS,
  activeBrowserOperations,
  browserEnv,
  hasOpenBrowserSession,
  isBridgeAvailable,
  loadBrowserTransport,
  type BrowserTransportStatus
} from "@nodetool-ai/browser";
import {
  BaseProvider,
  enforceProviderTerms,
  getRegisteredProvider,
  isProviderConfigured,
  listRegisteredProviderIds,
  providerAccessMode
} from "@nodetool-ai/runtime";
import { getSecret as getStoredSecret } from "@nodetool-ai/models";
import { isCloudProfile } from "../../lib/cloud-profile.js";
import {
  currentFactoryProviderConfig,
  saveFactoryProviderConfig,
  type FactoryProviderConfig
} from "../../lib/factory-provider-config.js";

const ORCA_MODULE = "@nodetool-ai/factory-browser-orca";
/** Registered providers that are not offered to people: test doubles. */
const HIDDEN_PROVIDERS = new Set(["fake"]);

const transportId = z.enum(SELECTABLE_BROWSER_TRANSPORTS);
const providerId = z.string().regex(/^[a-z0-9_]{1,64}$/);

function localOnly(): void {
  if (isCloudProfile()) {
    throw new TRPCError({ code: "FORBIDDEN", message: "The Provider Manager runs on your own computer only" });
  }
}

function refuseWhileBusy(action: string): void {
  const operations = activeBrowserOperations();
  if (operations > 0 || hasOpenBrowserSession()) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        `Cannot ${action} while browser work is in progress ` +
        `(${operations} provider operation${operations === 1 ? "" : "s"}${hasOpenBrowserSession() ? ", an open agent browser session" : ""}). ` +
        "Wait for it to finish, then try again."
    });
  }
}

/** Where the transport in effect comes from. */
function transportInEffect(config: FactoryProviderConfig): { id: string; source: "saved" | "environment" | "default" } {
  if (config.transport) return { id: config.transport, source: "saved" };
  const fromEnv = process.env["NODETOOL_BROWSER_TRANSPORT"]?.trim();
  if (fromEnv) return { id: fromEnv, source: "environment" };
  return { id: "local", source: "default" };
}

/** Browser providers use the extension tab on `local` and `extension`. */
function providerTransportOf(transport: string): "extension" | "orca" | string {
  return transport === "local" || transport === "extension" ? "extension" : transport;
}

function orcaConfigured(): boolean {
  return Boolean(process.env["FACTORY_ORCA_WORKTREE"]?.trim());
}

/** The environment to load the Orca transport with, whatever is selected. */
function orcaEnv(): NodeJS.ProcessEnv {
  const env = browserEnv();
  const modules = env["NODETOOL_BROWSER_TRANSPORT_MODULES"] ?? "";
  if (!modules.split(",").some((entry) => entry.trim().startsWith("orca="))) {
    env["NODETOOL_BROWSER_TRANSPORT_MODULES"] = [modules, `orca=${ORCA_MODULE}`].filter(Boolean).join(",");
  }
  return env;
}

const capabilityCache = new Map<string, string[]>();

const CHAT_CAPABILITIES = new Set(["generate_message", "generate_messages"]);

/**
 * Declared capabilities, read off an instance built without credentials. No
 * call is made. Every provider reports chat through the base class, so chat
 * counts only when the provider lists language models of its own.
 */
function declaredCapabilities(id: string): string[] {
  const cached = capabilityCache.get(id);
  if (cached) return cached;
  const registration = getRegisteredProvider(id);
  let capabilities: string[] = [];
  if (registration) {
    try {
      // Required credentials get a placeholder so constructors that insist
      // on one still build. The instance is only asked what it declares; it
      // is never called, so the placeholder never leaves this process.
      const kwargs: Record<string, unknown> = { ...registration.optionalKwargs };
      for (const [key, value] of Object.entries(registration.kwargs)) {
        kwargs[key] = value === "" || value == null ? "capability-probe" : value;
      }
      const instance = new registration.cls(kwargs) as {
        getCapabilities?: () => readonly string[];
        getAvailableLanguageModels?: unknown;
      };
      const chat = instance.getAvailableLanguageModels !== BaseProvider.prototype.getAvailableLanguageModels;
      capabilities = [...(instance.getCapabilities?.() ?? [])].filter(
        (capability) => chat || !CHAT_CAPABILITIES.has(capability)
      );
    } catch {
      capabilities = [];
    }
  }
  capabilityCache.set(id, capabilities);
  return capabilities;
}

async function listProviders(userId: string, config: FactoryProviderConfig): Promise<ManagedProvider[]> {
  const terms = enforceProviderTerms();
  const transport = providerTransportOf(transportInEffect(config).id);
  const getSecret = (key: string) => getStoredSecret(key, userId).then((value) => value ?? undefined);
  const browserIds = new Set(FACTORY_BROWSER_PROVIDERS.map((entry) => entry.id));

  const browser: ManagedProvider[] = FACTORY_BROWSER_PROVIDERS.map((entry) => {
    const registered = Boolean(getRegisteredProvider(entry.id));
    const base = {
      id: entry.id,
      name: entry.name,
      mode: providerAccessMode(entry.id),
      capabilities: registered ? capabilityGroups(declaredCapabilities(entry.id)) : [],
      configured: registered,
      paid: false,
      paidEnabled: false,
      host: entry.host,
      transports: [...entry.transports]
    };
    if (entry.integration === "planned" || !registered) {
      return { ...base, available: false, unavailableReason: "planned" as const };
    }
    if (entry.integration === "terms_unreviewed" && terms) {
      return { ...base, available: false, unavailableReason: "terms_unreviewed" as const };
    }
    if (!(entry.transports as readonly string[]).includes(transport)) {
      return { ...base, available: false, unavailableReason: "transport_unsupported" as const };
    }
    return { ...base, available: true };
  });

  const others = await Promise.all(
    listRegisteredProviderIds()
      .filter((id) => !browserIds.has(id) && !HIDDEN_PROVIDERS.has(id))
      .map(async (id): Promise<ManagedProvider> => {
        const mode = providerAccessMode(id);
        const configured = await isProviderConfigured(id, getSecret).catch(() => false);
        const paid = mode === "api";
        const paidEnabled = paid && config.paidMediaEnabled.includes(id);
        const registration = getRegisteredProvider(id);
        const secretKey =
          Object.keys(registration?.kwargs ?? {}).find((key) => /KEY|TOKEN|SECRET/.test(key)) ?? null;
        // A hosted provider with no key to store signs in with an account
        // (OAuth, a CLI login). That is not checked here, so it is not
        // reported as configured.
        const account = mode === "api" && secretKey === null;
        const entry: ManagedProvider = {
          id,
          name: registration?.metadata.displayName ?? id,
          mode,
          capabilities: capabilityGroups(declaredCapabilities(id)),
          configured: configured && !account,
          credential: mode === "api" ? (account ? "account" : "api_key") : "none",
          paid,
          paidEnabled,
          secretKey,
          available: configured && !account
        };
        if (!entry.available) entry.unavailableReason = account ? "account_unverified" : "not_configured";
        return entry;
      })
  );
  return [...browser, ...others.sort((a, b) => a.name.localeCompare(b.name))];
}

const managedProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.enum(["browser_assisted", "browser_automated", "api", "local"]),
  capabilities: z.array(z.enum(["text", "image", "video", "audio"])),
  available: z.boolean(),
  unavailableReason: z
    .enum(["planned", "terms_unreviewed", "not_configured", "transport_unsupported", "paid_disabled", "account_unverified"])
    .optional(),
  credential: z.enum(["api_key", "account", "none"]).optional(),
  configured: z.boolean(),
  paid: z.boolean(),
  paidEnabled: z.boolean(),
  host: z.string().optional(),
  transports: z.array(z.enum(["extension", "orca"])).optional(),
  secretKey: z.string().nullable().optional()
});

const transportOptionSchema = z.object({
  id: transportId,
  /** Can be selected here. */
  selectable: z.boolean(),
  /** Why not, when it cannot. */
  reason: z.enum(["orca_not_configured"]).optional()
});

const statusSchema = z.object({
  transports: z.object({
    local: z.object({ connected: z.boolean(), detail: z.string().optional() }),
    extension: z.object({ connected: z.boolean(), detail: z.string().optional() }),
    orca: z.object({ connected: z.boolean(), configured: z.boolean(), detail: z.string().optional() })
  }),
  tabs: z.record(
    z.string(),
    z.object({
      pageId: z.string(),
      authorized: z.boolean(),
      exists: z.boolean(),
      onHost: z.boolean(),
      detail: z.string().optional()
    })
  ),
  /** A browser site's sign-in is never verified: it would mean reading the page. */
  session: z.literal("unverifiable"),
  activeOperations: z.number().int(),
  agentSessionOpen: z.boolean()
});

async function orcaStatus(
  tabs: Readonly<Record<string, { pageId: string; host: string }>>
): Promise<BrowserTransportStatus & { configured: boolean }> {
  if (!orcaConfigured()) {
    return { connected: false, configured: false, detail: "FACTORY_ORCA_WORKTREE is not set for this backend.", tabs: {} };
  }
  try {
    const factory = await loadBrowserTransport("orca", orcaEnv());
    if (!factory.status) return { connected: false, configured: true, detail: "This Orca transport reports no status.", tabs: {} };
    return { ...(await factory.status(tabs)), configured: true };
  } catch (error) {
    return { connected: false, configured: true, detail: error instanceof Error ? error.message : String(error), tabs: {} };
  }
}

function hostOf(provider: string): string {
  const entry = factoryBrowserProvider(provider);
  if (!entry || entry.integration === "planned") {
    throw new TRPCError({ code: "NOT_FOUND", message: `No browser provider "${provider}" can be used yet` });
  }
  return entry.host;
}

export const providerManagerRouter = router({
  overview: protectedProcedure
    .output(
      z.object({
        policy: z.object({ terms: z.boolean(), paidMediaOffByDefault: z.literal(true) }),
        transport: z.object({
          selected: z.string(),
          source: z.enum(["saved", "environment", "default"]),
          options: z.array(transportOptionSchema)
        }),
        providers: z.array(managedProviderSchema)
      })
    )
    .query(async ({ ctx }) => {
      localOnly();
      const config = currentFactoryProviderConfig();
      const effect = transportInEffect(config);
      return {
        policy: { terms: enforceProviderTerms(), paidMediaOffByDefault: true as const },
        transport: {
          selected: effect.id,
          source: effect.source,
          options: SELECTABLE_BROWSER_TRANSPORTS.map((id) =>
            id === "orca" && !orcaConfigured()
              ? { id, selectable: false, reason: "orca_not_configured" as const }
              : { id, selectable: true }
          )
        },
        providers: await listProviders(ctx.userId, config)
      };
    }),

  status: protectedProcedure.output(statusSchema).query(async () => {
    localOnly();
    const config = currentFactoryProviderConfig();
    const saved: Record<string, { pageId: string; host: string }> = {};
    for (const [provider, pageId] of Object.entries(config.providerTabs)) {
      const entry = factoryBrowserProvider(provider);
      if (entry) saved[provider] = { pageId, host: entry.host };
    }
    const [extensionConnected, orca] = await Promise.all([
      isBridgeAvailable().catch(() => false),
      orcaStatus(saved)
    ]);
    const tabs: z.infer<typeof statusSchema>["tabs"] = {};
    for (const [provider, { pageId }] of Object.entries(saved)) {
      const checked = orca.tabs[provider];
      tabs[provider] = {
        pageId,
        authorized: true,
        exists: checked?.exists ?? false,
        onHost: checked?.onHost ?? false,
        ...(checked?.detail ? { detail: checked.detail } : !checked && orca.detail ? { detail: orca.detail } : {})
      };
    }
    return {
      transports: {
        local: { connected: true },
        extension: extensionConnected
          ? { connected: true }
          : { connected: false, detail: "The NodeTool browser extension is not connected." },
        orca: { connected: orca.connected, configured: orca.configured, ...(orca.detail ? { detail: orca.detail } : {}) }
      },
      tabs,
      session: "unverifiable" as const,
      activeOperations: activeBrowserOperations(),
      agentSessionOpen: hasOpenBrowserSession()
    };
  }),

  setTransport: protectedProcedure
    .input(z.object({ transport: transportId }))
    .output(z.object({ transport: transportId }))
    .mutation(async ({ ctx, input }) => {
      localOnly();
      if (input.transport === "orca" && !orcaConfigured()) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Orca is not configured for this backend (FACTORY_ORCA_WORKTREE)." });
      }
      refuseWhileBusy("change the browser transport");
      const config = currentFactoryProviderConfig();
      await saveFactoryProviderConfig(ctx.userId, { ...config, transport: input.transport });
      return { transport: input.transport };
    }),

  openSignInTab: protectedProcedure
    .input(z.object({ provider: providerId }))
    .output(z.object({ pageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      localOnly();
      const host = hostOf(input.provider);
      const entry = factoryBrowserProvider(input.provider);
      if (!entry?.transports.includes("orca")) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${entry?.name ?? input.provider} cannot use Orca tabs yet.` });
      }
      if (!orcaConfigured()) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Orca is not configured for this backend (FACTORY_ORCA_WORKTREE)." });
      }
      refuseWhileBusy("change a provider tab");
      const factory = await loadBrowserTransport("orca", orcaEnv());
      if (!factory.openSignInTab) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This Orca transport cannot open sign-in tabs." });
      }
      let pageId: string;
      try {
        pageId = await factory.openSignInTab(`https://${host}/`);
      } catch (error) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? error.message : String(error) });
      }
      const config = currentFactoryProviderConfig();
      await saveFactoryProviderConfig(ctx.userId, { ...config, providerTabs: { ...config.providerTabs, [input.provider]: pageId } });
      return { pageId };
    }),

  authorizeTab: protectedProcedure
    .input(z.object({ provider: providerId, pageId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/) }))
    .output(z.object({ pageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      localOnly();
      const host = hostOf(input.provider);
      refuseWhileBusy("change a provider tab");
      const checked = await orcaStatus({ [input.provider]: { pageId: input.pageId, host } });
      const tab = checked.tabs[input.provider];
      if (!tab?.exists || !tab.onHost) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: tab?.detail ?? checked.detail ?? `Tab ${input.pageId} is not in the factory profile on ${host}.`
        });
      }
      const config = currentFactoryProviderConfig();
      await saveFactoryProviderConfig(ctx.userId, {
        ...config,
        providerTabs: { ...config.providerTabs, [input.provider]: input.pageId }
      });
      return { pageId: input.pageId };
    }),

  revokeTab: protectedProcedure
    .input(z.object({ provider: providerId }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      localOnly();
      refuseWhileBusy("change a provider tab");
      const config = currentFactoryProviderConfig();
      const providerTabs = { ...config.providerTabs };
      delete providerTabs[input.provider];
      await saveFactoryProviderConfig(ctx.userId, { ...config, providerTabs });
      return { ok: true as const };
    }),

  setPaidMedia: protectedProcedure
    .input(z.object({ provider: providerId, enabled: z.boolean() }))
    .output(z.object({ paidMediaEnabled: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      localOnly();
      if (providerAccessMode(input.provider) !== "api" || !getRegisteredProvider(input.provider)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `${input.provider} is not a paid API provider.` });
      }
      const config = currentFactoryProviderConfig();
      const enabled = new Set(config.paidMediaEnabled);
      if (input.enabled) enabled.add(input.provider);
      else enabled.delete(input.provider);
      const saved = await saveFactoryProviderConfig(ctx.userId, { ...config, paidMediaEnabled: [...enabled].sort() });
      return { paidMediaEnabled: saved.paidMediaEnabled };
    })
});
