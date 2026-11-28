import { afterEach, describe, expect, it } from "vitest";
import {
  activeBrowserOperations,
  beginBrowserOperation,
  browserEnv,
  effectiveBrowserTransport,
  getSavedBrowserConfig,
  setSavedBrowserConfig
} from "../src/browser-config.js";

afterEach(() => setSavedBrowserConfig({}));

describe("browserEnv: the one browser configuration", () => {
  it("falls back to the environment when nothing is saved", () => {
    const env = { NODETOOL_BROWSER_TRANSPORT: "extension", FACTORY_ORCA_PROVIDER_TABS: "chatgpt=env-tab" };
    expect(browserEnv(env)).toMatchObject(env);
    expect(effectiveBrowserTransport({})).toBe("local");
  });

  it("puts saved values over the environment", () => {
    setSavedBrowserConfig({ transport: "orca", providerTabs: { chatgpt: "saved-tab" } });
    const env = browserEnv({ NODETOOL_BROWSER_TRANSPORT: "extension", FACTORY_ORCA_PROVIDER_TABS: "chatgpt=env-tab" });
    expect(env["NODETOOL_BROWSER_TRANSPORT"]).toBe("orca");
    expect(env["FACTORY_ORCA_PROVIDER_TABS"]).toBe("chatgpt=saved-tab");
    // Selecting Orca names its module only when the environment does not.
    expect(env["NODETOOL_BROWSER_TRANSPORT_MODULES"]).toBe("orca=@nodetool-ai/factory-browser-orca");
    expect(browserEnv({ NODETOOL_BROWSER_TRANSPORT_MODULES: "orca=./local-orca.js" })["NODETOOL_BROWSER_TRANSPORT_MODULES"]).toBe(
      "orca=./local-orca.js"
    );
  });

  it("drops what may not be saved: unknown transports and malformed tabs", () => {
    setSavedBrowserConfig({
      transport: "evil" as never,
      providerTabs: { chatgpt: "ok-tab", "bad id": "x", gemini_web: "has spaces" }
    });
    expect(getSavedBrowserConfig()).toEqual({ providerTabs: { chatgpt: "ok-tab" } });
    // The policy and module variables are never written from saved values.
    const env = browserEnv({ NODETOOL_BROWSER_PROVIDER_POLICY: "terms" });
    expect(env["NODETOOL_BROWSER_PROVIDER_POLICY"]).toBe("terms");
    expect(env["NODETOOL_BROWSER_TRANSPORT_MODULES"]).toBeUndefined();
  });

  it("does not leak the saved copy to callers", () => {
    setSavedBrowserConfig({ providerTabs: { chatgpt: "a" } });
    getSavedBrowserConfig().providerTabs!["chatgpt"] = "changed";
    expect(getSavedBrowserConfig().providerTabs).toEqual({ chatgpt: "a" });
  });
});

describe("browser operations in flight", () => {
  it("counts each operation until it ends, once", () => {
    const before = activeBrowserOperations();
    const end1 = beginBrowserOperation();
    const end2 = beginBrowserOperation();
    expect(activeBrowserOperations()).toBe(before + 2);
    end1();
    end1();
    expect(activeBrowserOperations()).toBe(before + 1);
    end2();
    expect(activeBrowserOperations()).toBe(before);
  });
});
