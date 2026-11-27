/**
 * `extension.showProviderTab`: the assisted-mode "open the provider" button.
 * It shows the provider's authorized tab and never runs a script.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const shown: string[] = [];
vi.mock("@nodetool-ai/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nodetool-ai/runtime")>();
  return {
    ...actual,
    showProviderTab: async (provider: string) => {
      shown.push(provider);
      return process.env["NODETOOL_BROWSER_TRANSPORT"] === "orca";
    }
  };
});

const { appRouter } = await import("../src/trpc/router.js");
const { createCallerFactory } = await import("../src/trpc/index.js");
type Context = import("../src/trpc/context.js").Context;

const caller = createCallerFactory(appRouter)({
  userId: "1",
  registry: {} as never,
  apiOptions: { metadataRoots: [], registry: {} as never } as never,
  pythonBridge: {} as never,
  getPythonBridgeReady: () => false
} as Context);

const saved = process.env["NODETOOL_BROWSER_TRANSPORT"];
afterEach(() => {
  shown.length = 0;
  if (saved === undefined) delete process.env["NODETOOL_BROWSER_TRANSPORT"];
  else process.env["NODETOOL_BROWSER_TRANSPORT"] = saved;
});

describe("extension.showProviderTab", () => {
  it("shows the provider's tab on a transport that can", async () => {
    process.env["NODETOOL_BROWSER_TRANSPORT"] = "orca";
    await expect(caller.extension.showProviderTab({ provider: "chatgpt" })).resolves.toEqual({
      shown: true,
      openUrl: "https://chatgpt.com/"
    });
    expect(shown).toEqual(["chatgpt"]);
  });

  it("answers with the address to open when no tab can be shown", async () => {
    delete process.env["NODETOOL_BROWSER_TRANSPORT"];
    await expect(caller.extension.showProviderTab({ provider: "chatgpt" })).resolves.toEqual({
      shown: false,
      openUrl: "https://chatgpt.com/"
    });
  });

  it("refuses a provider that is not a browser provider", async () => {
    await expect(caller.extension.showProviderTab({ provider: "openai" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(shown).toEqual([]);
  });
});
