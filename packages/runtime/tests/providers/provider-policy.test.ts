/**
 * Provider Manager rules the runtime enforces: paid media off until a
 * provider is turned on, browser providers with unreviewed terms refused under
 * the terms policy, and the local / API / browser classification.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeBrowserOperations,
  registerBrowserTransport,
  setSavedBrowserConfig,
  unregisterBrowserTransport
} from "@nodetool-ai/browser";
import { ProcessingContext } from "../../src/context.js";
import { BaseProvider } from "../../src/providers/base-provider.js";
import type { Message, ProviderStreamItem, TextToImageParams } from "../../src/providers/types.js";
import "../../src/providers/index.js";
import {
  PaidProviderDisabledError,
  ProviderTermsUnreviewedError,
  assertGenerationAllowed,
  clearPaidMediaPolicy,
  installPaidMediaPolicy,
  isPaidProvider,
  providerAccessMode
} from "../../src/providers/index.js";
import { configuredProviderTransport, resolveProviderTab } from "../../src/providers/provider-tab.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const TERMS = { NODETOOL_BROWSER_PROVIDER_POLICY: "terms" };

class SpyImageProvider extends BaseProvider {
  readonly textToImageCalls: TextToImageParams[] = [];
  constructor(id: string) {
    super(id);
  }
  override async textToImage(params: TextToImageParams): Promise<Uint8Array> {
    this.textToImageCalls.push(params);
    return PNG;
  }
  async generateMessage(): Promise<Message> {
    throw new Error("not used");
  }
  async *generateMessages(): AsyncGenerator<ProviderStreamItem> {
    throw new Error("not used");
  }
}

afterEach(() => {
  clearPaidMediaPolicy();
  setSavedBrowserConfig({});
  vi.unstubAllEnvs();
});

describe("provider classification", () => {
  it("follows the registry: local engines are local, hosted APIs are paid", () => {
    for (const id of ["ollama", "wangp", "node_llama_cpp", "stable_diffusion_cpp", "lmstudio", "transformers_js"]) {
      expect(providerAccessMode(id, {}), id).toBe("local");
      expect(isPaidProvider(id, {}), id).toBe(false);
    }
    for (const id of ["openai", "fal", "replicate"]) {
      expect(providerAccessMode(id, {}), id).toBe("api");
      expect(isPaidProvider(id, {}), id).toBe(true);
    }
  });

  it("puts browser sites in the browser modes, never paid", () => {
    for (const id of ["chatgpt", "gemini_web", "google_flow", "dreamina", "muse_ai"]) {
      expect(providerAccessMode(id, TERMS), id).toBe("browser_assisted");
      expect(isPaidProvider(id, TERMS), id).toBe(false);
    }
  });
});

describe("assertGenerationAllowed", () => {
  it("lets everything through when no paid-media policy is installed", () => {
    expect(() => assertGenerationAllowed({ provider: "openai", capability: "text_to_image" }, {})).not.toThrow();
  });

  it("refuses paid media until the provider is turned on, and leaves text alone", () => {
    installPaidMediaPolicy([]);
    expect(() => assertGenerationAllowed({ provider: "openai", capability: "text_to_image" }, {})).toThrow(
      PaidProviderDisabledError
    );
    expect(() => assertGenerationAllowed({ provider: "fal", capability: "text_to_video" }, {})).toThrow(PaidProviderDisabledError);
    expect(() => assertGenerationAllowed({ provider: "openai", capability: "text_to_speech" }, {})).toThrow(
      PaidProviderDisabledError
    );
    expect(() => assertGenerationAllowed({ provider: "openai", capability: "generate_message" }, {})).not.toThrow();
    expect(() => assertGenerationAllowed({ provider: "openai", capability: "generate_embedding" }, {})).not.toThrow();
    expect(() => assertGenerationAllowed({ provider: "ollama", capability: "text_to_image" }, {})).not.toThrow();
    expect(() => assertGenerationAllowed({ provider: "chatgpt", capability: "text_to_image" }, {})).not.toThrow();

    installPaidMediaPolicy(["openai"]);
    expect(() => assertGenerationAllowed({ provider: "openai", capability: "text_to_image" }, {})).not.toThrow();
    expect(() => assertGenerationAllowed({ provider: "fal", capability: "text_to_image" }, {})).toThrow(PaidProviderDisabledError);
  });

  it("refuses browser providers with unreviewed terms only under the terms policy", () => {
    for (const id of ["gemini_web", "google_flow", "dreamina"]) {
      expect(() => assertGenerationAllowed({ provider: id, capability: "text_to_image" }, TERMS)).toThrow(
        ProviderTermsUnreviewedError
      );
      expect(() => assertGenerationAllowed({ provider: id, capability: "text_to_image" }, {})).not.toThrow();
    }
    expect(() => assertGenerationAllowed({ provider: "chatgpt", capability: "text_to_image" }, TERMS)).not.toThrow();
  });
});

describe("the generation envelope", () => {
  it("refuses a paid media generation before the provider is called or anything is recorded", async () => {
    installPaidMediaPolicy([]);
    const accepted = vi.fn();
    const ctx = new ProcessingContext({ jobId: "paid-gate", generationLifecycle: { onGenerationAccepted: accepted } });
    const provider = new SpyImageProvider("openai");
    ctx.registerProvider("openai", provider);
    await expect(
      ctx.runGeneration({
        provider: "openai",
        capability: "text_to_image",
        model: "gpt-image-1",
        params: { prompt: "a lighthouse" }
      })
    ).rejects.toThrow(PaidProviderDisabledError);
    expect(provider.textToImageCalls).toHaveLength(0);
    expect(accepted).not.toHaveBeenCalled();
  });

  it("runs it once the provider is turned on", async () => {
    installPaidMediaPolicy(["openai"]);
    const ctx = new ProcessingContext({ jobId: "paid-on" });
    const provider = new SpyImageProvider("openai");
    ctx.registerProvider("openai", provider);
    await ctx.runGeneration({
      provider: "openai",
      capability: "text_to_image",
      model: "gpt-image-1",
      params: { prompt: "a lighthouse" }
    });
    expect(provider.textToImageCalls).toHaveLength(1);
  });

  it("refuses an unreviewed browser provider under the terms policy", async () => {
    vi.stubEnv("NODETOOL_BROWSER_PROVIDER_POLICY", "terms");
    const ctx = new ProcessingContext({ jobId: "terms-gate" });
    const provider = new SpyImageProvider("gemini_web");
    ctx.registerProvider("gemini_web", provider);
    await expect(
      ctx.runGeneration({ provider: "gemini_web", capability: "text_to_image", model: "x", params: { prompt: "p" } })
    ).rejects.toThrow(ProviderTermsUnreviewedError);
    expect(provider.textToImageCalls).toHaveLength(0);
  });
});

describe("one browser configuration for every caller", () => {
  it("reads the saved transport over the environment", () => {
    expect(configuredProviderTransport({ NODETOOL_BROWSER_TRANSPORT: "orca" })).toBe("orca");
    setSavedBrowserConfig({ transport: "extension" });
    expect(configuredProviderTransport({ NODETOOL_BROWSER_TRANSPORT: "orca" })).toBe("extension");
    setSavedBrowserConfig({ transport: "local" });
    expect(configuredProviderTransport({})).toBe("extension");
  });
});

describe("resolveProviderTab follows configuration changes", () => {
  it("reopens the tab after the authorized tab changes, and counts calls in flight", async () => {
    const opened: string[] = [];
    const released: string[] = [];
    let hold: Promise<void> | null = null;
    registerBrowserTransport({
      id: "orca",
      describe: () => "fake orca",
      open: async () => {
        throw new Error("not used");
      },
      openProviderTab: async (spec) => {
        const label = `${spec.providerId}:${opened.length}`;
        opened.push(label);
        return {
          evaluate: async () => {
            if (hold) await hold;
            return label;
          },
          navigate: async () => undefined,
          release: async () => {
            released.push(label);
          }
        };
      }
    });
    try {
      setSavedBrowserConfig({ transport: "orca", providerTabs: { chatgpt: "tab-a" } });
      const tab = resolveProviderTab({ providerId: "chatgpt", host: "chatgpt.com", automated: false, env: {} });
      const before = activeBrowserOperations();
      let letGo!: () => void;
      hold = new Promise((resolve) => (letGo = resolve));
      const first = tab.evaluate("1");
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      expect(activeBrowserOperations()).toBe(before + 1);
      letGo();
      hold = null;
      await expect(first).resolves.toBe("chatgpt:0");
      expect(activeBrowserOperations()).toBe(before);

      // Same configuration: the same tab.
      await expect(tab.evaluate("2")).resolves.toBe("chatgpt:0");
      expect(opened).toHaveLength(1);

      // Another authorized tab: released and reopened.
      setSavedBrowserConfig({ transport: "orca", providerTabs: { chatgpt: "tab-b" } });
      await expect(tab.evaluate("3")).resolves.toBe("chatgpt:1");
      expect(released).toEqual(["chatgpt:0"]);
    } finally {
      unregisterBrowserTransport("orca");
    }
  });
});

describe("configuration changes during active operations", () => {
  it("keeps an in-flight call on its tab and releases that tab only when the call ends", async () => {
    const released: string[] = [];
    const holds = new Map<string, () => void>();
    registerBrowserTransport({
      id: "orca",
      describe: () => "fake orca",
      open: async () => {
        throw new Error("not used");
      },
      openProviderTab: async () => {
        const label = process.env["__unused__"] ?? `tab-${holds.size + released.length}`;
        return {
          evaluate: (expression: string) =>
            new Promise((resolve) => holds.set(`${label}:${expression}`, () => resolve(`${label}:${expression}`))),
          navigate: async () => undefined,
          release: async () => {
            released.push(label);
          }
        };
      }
    });
    try {
      setSavedBrowserConfig({ transport: "orca", providerTabs: { chatgpt: "a" } });
      const tab = resolveProviderTab({ providerId: "chatgpt", host: "chatgpt.com", automated: false, env: {} });
      const first = tab.evaluate("first");
      await vi.waitFor(() => expect(holds.has("tab-0:first")).toBe(true));

      // The authorized tab changes while the first call is still running.
      setSavedBrowserConfig({ transport: "orca", providerTabs: { chatgpt: "b" } });
      const second = tab.evaluate("second");
      await vi.waitFor(() => expect([...holds.keys()].some((k) => k.endsWith(":second"))).toBe(true));
      const secondKey = [...holds.keys()].find((k) => k.endsWith(":second"))!;
      expect(secondKey.startsWith("tab-0")).toBe(false);
      // The old tab is still in use: not released yet.
      expect(released).toEqual([]);

      holds.get(secondKey)!();
      await second;
      expect(released).toEqual([]);
      holds.get("tab-0:first")!();
      await expect(first).resolves.toBe("tab-0:first");
      await vi.waitFor(() => expect(released).toEqual(["tab-0"]));
    } finally {
      unregisterBrowserTransport("orca");
    }
  });
});

describe("the shared saved configuration", () => {
  it("is applied only inside the AI Content Factory environment", async () => {
    const { applySavedFactoryProviderConfig } = await import("../../src/providers/factory-provider-config.js");
    const { paidMediaPolicy } = await import("../../src/providers/provider-policy.js");
    const row = JSON.stringify({ transport: "orca", providerTabs: { chatgpt: "t" }, paidMediaEnabled: ["openai"] });

    await expect(applySavedFactoryProviderConfig(async () => row, {})).resolves.toBe(false);
    expect(paidMediaPolicy()).toBeNull();

    await expect(applySavedFactoryProviderConfig(async () => row, { NODETOOL_PROVIDER_MANAGER: "1" })).resolves.toBe(true);
    expect(paidMediaPolicy()).toEqual(new Set(["openai"]));
    expect(configuredProviderTransport({})).toBe("orca");
  });

  it("keeps paid media off when the saved row cannot be read", async () => {
    const { applySavedFactoryProviderConfig } = await import("../../src/providers/factory-provider-config.js");
    const { paidMediaPolicy } = await import("../../src/providers/provider-policy.js");
    await applySavedFactoryProviderConfig(async () => {
      throw new Error("database locked");
    }, { NODETOOL_PROVIDER_MANAGER: "1" });
    expect(paidMediaPolicy()).toEqual(new Set());
  });
});
