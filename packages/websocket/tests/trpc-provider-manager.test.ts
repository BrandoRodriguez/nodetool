/**
 * Provider Manager: the saved configuration (one settings row, applied to the
 * browser package and to the paid-media admission) and its tRPC router.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTestDb, Setting } from "@nodetool-ai/models";
import {
  beginBrowserOperation,
  browserEnv,
  getSavedBrowserConfig,
  registerBrowserTransport,
  setSavedBrowserConfig,
  unregisterBrowserTransport,
  type BrowserTransportFactory
} from "@nodetool-ai/browser";
import { clearPaidMediaPolicy, paidMediaPolicy } from "@nodetool-ai/runtime";

const cloud = vi.hoisted(() => ({ on: false }));
vi.mock("../src/lib/cloud-profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/cloud-profile.js")>()),
  isCloudProfile: () => cloud.on
}));

const {
  FACTORY_PROVIDER_SETTING_KEY,
  applyFactoryProviderConfig,
  loadFactoryProviderConfig,
  parseFactoryProviderConfig,
  saveFactoryProviderConfig
} = await import("../src/lib/factory-provider-config.js");
const { appRouter } = await import("../src/trpc/router.js");
const { createCallerFactory } = await import("../src/trpc/index.js");
type Context = import("../src/trpc/context.js").Context;

const USER = "1";
const caller = createCallerFactory(appRouter)({
  userId: USER,
  registry: {} as never,
  apiOptions: { metadataRoots: [], registry: {} as never } as never,
  pythonBridge: {} as never,
  getPythonBridgeReady: () => false
} as Context);

/** A stand-in for the Orca transport: knows one tab on chatgpt.com. */
const fakeOrca = (): BrowserTransportFactory & { opened: string[] } => {
  const opened: string[] = [];
  return {
    id: "orca",
    opened,
    describe: () => "fake",
    open: async () => {
      throw new Error("not used");
    },
    status: async (tabs) => ({
      connected: true,
      tabs: Object.fromEntries(
        Object.entries(tabs).map(([provider, { pageId }]) => [
          provider,
          pageId === "gpt-tab" ? { exists: true, onHost: true } : { exists: false, onHost: false, detail: `No tab ${pageId}` }
        ])
      )
    }),
    openSignInTab: async (url) => {
      opened.push(url);
      return "new-tab";
    }
  };
};

beforeEach(() => {
  initTestDb();
  cloud.on = false;
  vi.stubEnv("FACTORY_ORCA_WORKTREE", "path:/factory");
  vi.stubEnv("NODETOOL_BROWSER_PROVIDER_POLICY", "terms");
  vi.stubEnv("NODETOOL_PROVIDER_MANAGER", "1");
  applyFactoryProviderConfig(parseFactoryProviderConfig(null));
});

afterEach(() => {
  vi.unstubAllEnvs();
  unregisterBrowserTransport("orca");
  setSavedBrowserConfig({});
  clearPaidMediaPolicy();
});

describe("saved configuration", () => {
  it("falls back to the safe default on anything malformed", () => {
    for (const raw of [null, "", "not json", JSON.stringify({ transport: "evil" }), JSON.stringify({ paidMediaEnabled: ["Bad Id!"] })]) {
      expect(parseFactoryProviderConfig(raw)).toEqual({ providerTabs: {}, paidMediaEnabled: [] });
    }
  });

  it("keeps paid media off with nothing saved", async () => {
    await loadFactoryProviderConfig(USER);
    expect(paidMediaPolicy()).toEqual(new Set());
  });

  it("survives a backend restart: saved, then loaded into a fresh process state", async () => {
    await saveFactoryProviderConfig(USER, {
      transport: "orca",
      providerTabs: { chatgpt: "gpt-tab" },
      paidMediaEnabled: ["openai"]
    });
    const row = await Setting.find(USER, FACTORY_PROVIDER_SETTING_KEY);
    expect(JSON.parse(row!.value)).toEqual({ transport: "orca", providerTabs: { chatgpt: "gpt-tab" }, paidMediaEnabled: ["openai"] });

    // A restart: process state gone, database kept.
    setSavedBrowserConfig({});
    clearPaidMediaPolicy();
    await loadFactoryProviderConfig(USER);

    expect(getSavedBrowserConfig()).toEqual({ transport: "orca", providerTabs: { chatgpt: "gpt-tab" } });
    expect(browserEnv({})["NODETOOL_BROWSER_TRANSPORT"]).toBe("orca");
    expect(browserEnv({})["FACTORY_ORCA_PROVIDER_TABS"]).toBe("chatgpt=gpt-tab");
    expect(paidMediaPolicy()).toEqual(new Set(["openai"]));
  });
});

describe("providerManager router", () => {
  it("lists every kind of provider with honest availability", async () => {
    const overview = await caller.providerManager.overview();
    expect(overview.policy).toEqual({ terms: true, paidMediaOffByDefault: true });
    const byId = new Map(overview.providers.map((p) => [p.id, p]));

    expect(byId.get("chatgpt")).toMatchObject({ mode: "browser_assisted", available: true, paid: false });
    for (const id of ["gemini_web", "google_flow", "dreamina"]) {
      expect(byId.get(id)).toMatchObject({ available: false, unavailableReason: "terms_unreviewed" });
    }
    expect(byId.get("muse_ai")).toMatchObject({ available: false, unavailableReason: "planned", capabilities: [] });
    expect(byId.get("wangp")).toMatchObject({ mode: "local", paid: false });
    expect(byId.get("openai")).toMatchObject({ mode: "api", paid: true, paidEnabled: false, secretKey: "OPENAI_API_KEY" });
    expect(byId.get("openai")?.capabilities).toEqual(expect.arrayContaining(["text", "image"]));
    expect(byId.has("fake")).toBe(false);
  });

  it("does not claim text for media-only browser sites", async () => {
    const overview = await caller.providerManager.overview();
    const dreamina = overview.providers.find((p) => p.id === "dreamina");
    expect(dreamina?.capabilities).not.toContain("text");
  });

  it("saves the transport, and refuses Orca when it is not set up", async () => {
    await expect(caller.providerManager.setTransport({ transport: "extension" })).resolves.toEqual({ transport: "extension" });
    expect((await caller.providerManager.overview()).transport).toMatchObject({ selected: "extension", source: "saved" });

    vi.stubEnv("FACTORY_ORCA_WORKTREE", "");
    await expect(caller.providerManager.setTransport({ transport: "orca" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("will not switch the transport while browser work is in progress", async () => {
    const end = beginBrowserOperation();
    try {
      await expect(caller.providerManager.setTransport({ transport: "orca" })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(getSavedBrowserConfig().transport).toBeUndefined();
    } finally {
      end();
    }
    await expect(caller.providerManager.setTransport({ transport: "orca" })).resolves.toEqual({ transport: "orca" });
  });

  it("authorizes only a tab the transport finds on the provider's host", async () => {
    registerBrowserTransport(fakeOrca());
    await expect(caller.providerManager.authorizeTab({ provider: "chatgpt", pageId: "other-tab" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED"
    });
    await expect(caller.providerManager.authorizeTab({ provider: "chatgpt", pageId: "gpt-tab" })).resolves.toEqual({
      pageId: "gpt-tab"
    });
    const status = await caller.providerManager.status();
    expect(status.tabs["chatgpt"]).toMatchObject({ authorized: true, exists: true, onHost: true });
    expect(status.session).toBe("unverifiable");

    await caller.providerManager.revokeTab({ provider: "chatgpt" });
    expect((await caller.providerManager.status()).tabs).toEqual({});
  });

  it("opens a sign-in tab on the provider's own address and authorizes it", async () => {
    const orca = fakeOrca();
    registerBrowserTransport(orca);
    await expect(caller.providerManager.openSignInTab({ provider: "chatgpt" })).resolves.toEqual({ pageId: "new-tab" });
    expect(orca.opened).toEqual(["https://chatgpt.com/"]);
    expect(getSavedBrowserConfig().providerTabs).toEqual({ chatgpt: "new-tab" });
    // A planned or extension-only provider gets no Orca tab.
    await expect(caller.providerManager.openSignInTab({ provider: "muse_ai" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.providerManager.openSignInTab({ provider: "dreamina" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED"
    });
  });

  it("turns paid media on only for API providers, and applies it at once", async () => {
    await expect(caller.providerManager.setPaidMedia({ provider: "ollama", enabled: true })).rejects.toMatchObject({
      code: "BAD_REQUEST"
    });
    await expect(caller.providerManager.setPaidMedia({ provider: "chatgpt", enabled: true })).rejects.toMatchObject({
      code: "BAD_REQUEST"
    });
    await caller.providerManager.setPaidMedia({ provider: "openai", enabled: true });
    expect(paidMediaPolicy()).toEqual(new Set(["openai"]));
    await caller.providerManager.setPaidMedia({ provider: "openai", enabled: false });
    expect(paidMediaPolicy()).toEqual(new Set());
  });

  it("is refused outside the AI Content Factory environment, and installs nothing there", async () => {
    vi.stubEnv("NODETOOL_PROVIDER_MANAGER", "");
    clearPaidMediaPolicy();
    await expect(caller.providerManager.overview()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await loadFactoryProviderConfig(USER);
    expect(paidMediaPolicy()).toBeNull();
  });

  it("applies concurrent changes one after another, losing none", async () => {
    await Promise.all([
      caller.providerManager.setPaidMedia({ provider: "openai", enabled: true }),
      caller.providerManager.setPaidMedia({ provider: "gemini", enabled: true }),
      caller.providerManager.setTransport({ transport: "extension" })
    ]);
    const row = await Setting.find(USER, FACTORY_PROVIDER_SETTING_KEY);
    expect(JSON.parse(row!.value)).toMatchObject({ transport: "extension", paidMediaEnabled: ["gemini", "openai"] });
  });

  it("refuses a tab change when browser work starts while it is being checked", async () => {
    const orca = fakeOrca();
    let end: (() => void) | null = null;
    const status = orca.status!.bind(orca);
    orca.status = async (tabs) => {
      // A provider call starts while the tab is being verified.
      end = beginBrowserOperation();
      return status(tabs);
    };
    registerBrowserTransport(orca);
    try {
      await expect(caller.providerManager.authorizeTab({ provider: "chatgpt", pageId: "gpt-tab" })).rejects.toMatchObject({
        code: "CONFLICT"
      });
      expect(getSavedBrowserConfig().providerTabs ?? {}).toEqual({});
    } finally {
      end?.();
    }
  });

  it("is refused on the cloud profile", async () => {
    cloud.on = true;
    await expect(caller.providerManager.overview()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.providerManager.setTransport({ transport: "local" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
