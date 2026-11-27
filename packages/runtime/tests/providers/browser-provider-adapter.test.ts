/**
 * The browser-provider adapter on ChatGPT Images: transport selection, the
 * terms policy (assisted mode), HTTP 429, duplicate and concatenated prompts.
 * No browser: the tab is simulated.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  registerBrowserTransport,
  unregisterBrowserTransport,
  type ProviderTab,
  type ProviderTabSpec
} from "@nodetool-ai/browser";
import { ChatGPTProvider, setChatGPTTab } from "../../src/providers/chatgpt-provider.js";
import {
  ManualGenerationRequiredError,
  ProviderCooldowns,
  ProviderRateLimitedError,
  automationAllowed,
  retryAfterMs
} from "../../src/providers/browser-provider-terms.js";
import { configuredProviderTransport, resolveProviderTab } from "../../src/providers/provider-tab.js";
import type { ExtensionTab } from "../../src/providers/extension-tab.js";

const CONVERSATION_ID = "6acbd47e-e42c-83eb-a5d0-1400ee225d3d";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
const ENV_KEYS = ["NODETOOL_BROWSER_PROVIDER_POLICY", "NODETOOL_BROWSER_TRANSPORT"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  setChatGPTTab(null);
  unregisterBrowserTransport("fake-provider-transport");
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

interface Log {
  ops: string[];
  sent: string[];
  navigations: string[];
  focused: number;
}

/**
 * A chatgpt.com tab: a send opens the conversation, a conversation read
 * returns a finished image turn, unless `conversationStatus` says otherwise.
 */
function fakeTab(opts: { conversationStatus?: () => number; retryAfter?: string; sendDelayMs?: number } = {}): Log {
  const log: Log = { ops: [], sent: [], navigations: [], focused: 0 };
  let pathname = "/";
  let reads = 0;
  const tab: ExtensionTab & { focus(): Promise<void> } = {
    async download() {
      throw new Error("not used");
    },
    async navigate(url) {
      log.navigations.push(url);
      pathname = new URL(url).pathname;
    },
    async focus() {
      log.focused += 1;
    },
    async evaluate(expression) {
      const op = /\/\*nt:(\w+)\*\//.exec(expression)?.[1] ?? "stage";
      log.ops.push(op);
      switch (op) {
        case "ready":
        case "accepted":
        case "click":
        case "attached":
        case "unstage":
          return true;
        case "sendready":
          return true;
        case "send":
          if (opts.sendDelayMs) await new Promise((r) => setTimeout(r, opts.sendDelayMs));
          log.sent.push(JSON.parse(/insertText", false, ("(?:[^"\\]|\\.)*")\)/.exec(expression)![1]!) as string);
          pathname = `/c/${CONVERSATION_ID}`;
          return true;
        case "location":
          return pathname;
        case "conversation": {
          const status = opts.conversationStatus?.() ?? 200;
          if (status !== 200) {
            throw new Error(`ChatGPT conversation request failed: HTTP ${status}${status === 429 ? ` retry-after=${opts.retryAfter ?? ""}` : ""}`);
          }
          reads += 1;
          const user = { id: `u${reads}`, role: "user", contentType: "text", status: null, endTurn: null, text: "x", images: [] };
          const toolNode = { id: `t${reads}`, role: "tool", contentType: "multimodal_text", status: null, endTurn: null, text: "", images: ["sediment://file_abc"] };
          const done = { id: `a${reads}`, role: "assistant", contentType: "text", status: "finished_successfully", endTurn: true, text: "", images: [] };
          return { currentNode: done.id, path: [user, toolNode, done] };
        }
        case "download":
          return Buffer.from(PNG).toString("base64");
        case "models":
          return [];
        default:
          return true;
      }
    }
  };
  setChatGPTTab(tab);
  return log;
}

describe("terms policy (assisted mode)", () => {
  it("allows automation unless terms are enforced", () => {
    expect(automationAllowed("chatgpt", {})).toBe(true);
    expect(automationAllowed("chatgpt", { NODETOOL_BROWSER_PROVIDER_POLICY: "terms" })).toBe(false);
    // A provider nobody reviewed is refused when terms are enforced.
    expect(automationAllowed("unknown_site", { NODETOOL_BROWSER_PROVIDER_POLICY: "terms" })).toBe(false);
  });

  it("hands ChatGPT Images over without sending anything", async () => {
    process.env["NODETOOL_BROWSER_PROVIDER_POLICY"] = "terms";
    const log = fakeTab();
    const error = await new ChatGPTProvider()
      .textToImage({ prompt: "A lighthouse at dawn", aspectRatio: "3:2" } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManualGenerationRequiredError);
    const manual = error as ManualGenerationRequiredError;
    expect(manual.prompt).toContain("A lighthouse at dawn");
    expect(manual.prompt).toContain("Aspect ratio: 3:2.");
    expect(manual.message).toMatch(/NodeTool sent nothing to ChatGPT/);
    expect(manual.message).toMatch(/Upload your own still/);
    expect(manual.message).toMatch(/OpenAI provider/);
    expect(log.focused).toBe(1);
    expect(log.ops).toEqual([]);
    expect(log.navigations).toEqual([]);
  });

  it("asks for the references by hand for image-to-image", async () => {
    process.env["NODETOOL_BROWSER_PROVIDER_POLICY"] = "terms";
    fakeTab();
    const error = await new ChatGPTProvider()
      .imageToImage([PNG], { prompt: "Make it night" } as never)
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).toMatch(/Attach the shot's reference image/);
  });

  it("hands chat over too, with the composed prompt", async () => {
    process.env["NODETOOL_BROWSER_PROVIDER_POLICY"] = "terms";
    const log = fakeTab();
    const error = await new ChatGPTProvider()
      .generateMessage({ model: "auto", messages: [{ role: "user", content: "Say hi" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManualGenerationRequiredError);
    expect((error as ManualGenerationRequiredError).prompt).toBe("Say hi");
    expect(log.sent).toEqual([]);
  });
});

describe("HTTP 429", () => {
  it("stops the generation, honours Retry-After and blocks the next call", async () => {
    const log = fakeTab({ conversationStatus: () => 429, retryAfter: "120" });
    const provider = new ChatGPTProvider();
    const before = Date.now();
    const error = await provider.textToImage({ prompt: "A fox" } as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRateLimitedError);
    expect((error as ProviderRateLimitedError).retryAt).toBeGreaterThanOrEqual(before + 119_000);
    // One read hit the 429 and polling stopped there.
    expect(log.ops.filter((op) => op === "conversation")).toHaveLength(1);
    const sentBefore = log.sent.length;
    await expect(provider.textToImage({ prompt: "Another" } as never)).rejects.toBeInstanceOf(ProviderRateLimitedError);
    expect(log.sent).toHaveLength(sentBefore);
  }, 20_000);

  it("never opens another conversation to repeat a rate-limited turn", async () => {
    const log = fakeTab({ conversationStatus: () => 429 });
    const error = await new ChatGPTProvider()
      .generateMessage({
        model: "auto",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "and you?" }
        ],
        providerSession: { providerId: "chatgpt", model: "auto", token: CONVERSATION_ID, checkpoint: 2 }
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRateLimitedError);
    // The continued thread was opened once, read once, and nothing was sent.
    expect(log.navigations).toHaveLength(1);
    expect(log.sent).toEqual([]);
  });

  it("parses Retry-After as seconds or an HTTP date, and blocks per provider", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterMs("30", now)).toBe(30_000);
    expect(retryAfterMs("Thu, 01 Jan 2026 00:01:00 GMT", now)).toBe(60_000);
    expect(retryAfterMs("later", now)).toBeNull();
    const cooldowns = new ProviderCooldowns();
    cooldowns.block("chatgpt", null, now);
    expect(() => cooldowns.assertReady("chatgpt", now + 59_000)).toThrow(ProviderRateLimitedError);
    expect(() => cooldowns.assertReady("chatgpt", now + 61_000)).not.toThrow();
    expect(() => cooldowns.assertReady("other", now)).not.toThrow();
  });
});

describe("duplicates and concatenation", () => {
  it("shares one turn between identical image requests in flight", async () => {
    const log = fakeTab({ sendDelayMs: 20 });
    const provider = new ChatGPTProvider();
    const [a, b] = await Promise.all([
      provider.textToImage({ prompt: "Same shot" } as never),
      provider.textToImage({ prompt: "Same shot" } as never)
    ]);
    expect(a).toBe(b);
    expect(log.sent).toHaveLength(1);
  }, 20_000);

  it("sends each prompt on its own, never joined to another", async () => {
    const log = fakeTab();
    const provider = new ChatGPTProvider();
    await Promise.all([
      provider.textToImage({ prompt: "Shot one: a red door" } as never),
      provider.textToImage({ prompt: "Shot two: a blue window" } as never)
    ]);
    expect(log.sent).toHaveLength(2);
    const [first, second] = log.sent;
    expect(first).toContain("red door");
    expect(first).not.toContain("blue window");
    expect(second).toContain("blue window");
    expect(second).not.toContain("red door");
    // Each image turn starts a new conversation: no session carries over.
    expect(log.navigations.every((url) => !url.includes("/c/"))).toBe(true);
  }, 20_000);
});

describe("transport selection", () => {
  it("keeps the extension for unset, local and extension", () => {
    for (const value of [undefined, "", "local", "extension"]) {
      expect(configuredProviderTransport(value === undefined ? {} : { NODETOOL_BROWSER_TRANSPORT: value })).toBe("extension");
    }
    expect(configuredProviderTransport({ NODETOOL_BROWSER_TRANSPORT: "orca" })).toBe("orca");
  });

  it("opens the provider tab through a registered transport", async () => {
    const specs: ProviderTabSpec[] = [];
    const scripts: string[] = [];
    const providerTab: ProviderTab = {
      evaluate: async (expression) => {
        scripts.push(expression);
        return "ok";
      },
      navigate: async () => undefined,
      focus: async () => undefined
    };
    registerBrowserTransport({
      id: "fake-provider-transport",
      describe: () => "fake",
      open: async () => {
        throw new Error("not used");
      },
      openProviderTab: async (spec) => {
        specs.push(spec);
        return providerTab;
      }
    });
    const tab = resolveProviderTab({
      providerId: "chatgpt",
      host: "chatgpt.com",
      automated: false,
      env: { NODETOOL_BROWSER_TRANSPORT: "fake-provider-transport" }
    });
    // Nothing opens until the first call.
    expect(specs).toEqual([]);
    await expect(tab.evaluate("1")).resolves.toBe("ok");
    await tab.focus?.();
    expect(specs).toEqual([{ providerId: "chatgpt", host: "chatgpt.com", automated: false }]);
    await expect(tab.download("https://chatgpt.com/x")).rejects.toThrow(/by hand/);
  });

  it("explains a transport that cannot serve providers", async () => {
    registerBrowserTransport({
      id: "fake-provider-transport",
      describe: () => "fake",
      open: async () => {
        throw new Error("not used");
      }
    });
    const tab = resolveProviderTab({
      providerId: "chatgpt",
      host: "chatgpt.com",
      automated: true,
      env: { NODETOOL_BROWSER_TRANSPORT: "fake-provider-transport" }
    });
    await expect(tab.evaluate("1")).rejects.toThrow(/cannot open provider tabs/);
  });
});
