import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoCredentials, openOrcaProviderTab, OrcaPolicyError, parseProviderTabs } from "../src/index.js";
import { FakeOrca, PROFILE_ID, fakeEnv, flag } from "./fake-orca.js";

const roots: string[] = [];
function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-provider-tab-"));
  roots.push(dir);
  return fakeEnv(dir, extra);
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const spec = (automated: boolean) => ({ providerId: "chatgpt", host: "chatgpt.com", automated });

function orcaWithTab(url = "https://chatgpt.com/", profileId = PROFILE_ID): FakeOrca {
  const orca = new FakeOrca();
  orca.tabs.set("gpt-tab", { profileId, url, title: "ChatGPT" });
  return orca;
}

describe("parseProviderTabs", () => {
  it("reads provider=page pairs and rejects malformed ones", () => {
    expect([...parseProviderTabs(" chatgpt=a , gemini_web=b ")]).toEqual([
      ["chatgpt", "a"],
      ["gemini_web", "b"]
    ]);
    expect(() => parseProviderTabs("chatgpt")).toThrow(/provider=pageId/);
  });
});

describe("openOrcaProviderTab", () => {
  it("needs a tab authorized for that provider, and says how to get one", async () => {
    const orca = orcaWithTab();
    await expect(openOrcaProviderTab(spec(false), { env: env(), runner: orca.runner })).rejects.toThrow(
      /FACTORY_ORCA_PROVIDER_TABS=chatgpt=/
    );
    // A tab authorized for the agent browser is not a provider tab.
    await expect(
      openOrcaProviderTab(spec(false), { env: env({ FACTORY_ORCA_AUTHORIZED_PAGES: "gpt-tab" }), runner: orca.runner })
    ).rejects.toThrow(/No Orca tab is authorized for chatgpt/);
  });

  it("refuses a tab on another host or in another profile", async () => {
    await expect(
      openOrcaProviderTab(spec(false), {
        env: env({ FACTORY_ORCA_PROVIDER_TABS: "chatgpt=gpt-tab" }),
        runner: orcaWithTab("https://evil.example/").runner
      })
    ).rejects.toThrow(/is on evil.example, not chatgpt.com/);
    await expect(
      openOrcaProviderTab(spec(false), {
        env: env({ FACTORY_ORCA_PROVIDER_TABS: "chatgpt=gpt-tab" }),
        runner: orcaWithTab("https://chatgpt.com/", "default").runner
      })
    ).rejects.toThrow(/uses profile default/);
  });

  it("in assisted mode only shows the tab: no script, no navigation", async () => {
    const orca = orcaWithTab();
    const tab = await openOrcaProviderTab(spec(false), { env: env({ FACTORY_ORCA_PROVIDER_TABS: "chatgpt=gpt-tab" }), runner: orca.runner });
    const evalsBefore = orca.of("eval").length;
    await expect(tab.evaluate("1")).rejects.toThrow(/assisted mode/);
    await expect(tab.navigate("https://chatgpt.com/c/x")).rejects.toThrow(/assisted mode/);
    expect(orca.of("eval")).toHaveLength(evalsBefore);
    expect(orca.of("goto")).toHaveLength(0);
    await tab.focus?.();
    const sw = orca.of("tab switch")[0]!;
    expect(flag(sw.args, "--page")).toBe("gpt-tab");
    expect(sw.args).toContain("--focus");
  });

  it("in automated mode runs provider scripts host-checked, with page scripts still off for agents", async () => {
    const orca = orcaWithTab();
    let lastExpression = "";
    orca.on("eval", (args) => {
      lastExpression = flag(args, "--expression") ?? "";
      return { result: JSON.stringify({ v: { conversation: "ok" } }) };
    });
    const tab = await openOrcaProviderTab(spec(true), { env: env({ FACTORY_ORCA_PROVIDER_TABS: "chatgpt=gpt-tab" }), runner: orca.runner });
    await expect(tab.evaluate("/*nt:conversation*/ (async () => ({ conversation: 'ok' }))()")).resolves.toEqual({ conversation: "ok" });
    expect(lastExpression).toContain('location.hostname !== "chatgpt.com"');
    expect(lastExpression).toContain("/*nt:conversation*/");
  });

  it("the host check runs inside the page and stops a script on another site", async () => {
    const orca = orcaWithTab();
    let captured = "";
    orca.on("eval", (args) => {
      captured = flag(args, "--expression") ?? "";
      return { result: JSON.stringify({ v: null }) };
    });
    const tab = await openOrcaProviderTab(spec(true), { env: env({ FACTORY_ORCA_PROVIDER_TABS: "chatgpt=gpt-tab" }), runner: orca.runner });
    await tab.evaluate("document.title");
    const onOther = vm.createContext({ JSON, location: { hostname: "evil.example" }, document: { title: "x" } });
    await expect(vm.runInContext(captured, onOther)).rejects.toThrow(/NT_WRONG_HOST/);
    const onProvider = vm.createContext({ JSON, location: { hostname: "chatgpt.com" }, document: { title: "ChatGPT" } });
    await expect(vm.runInContext(captured, onProvider)).resolves.toBe(JSON.stringify({ v: "ChatGPT" }));
  });

  it("refuses a provider script result shaped like a credential", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const orca = orcaWithTab();
    orca.on("eval", () => ({ result: JSON.stringify({ v: { token: jwt } }) }));
    const tab = await openOrcaProviderTab(spec(true), { env: env({ FACTORY_ORCA_PROVIDER_TABS: "chatgpt=gpt-tab" }), runner: orca.runner });
    await expect(tab.evaluate("x")).rejects.toBeInstanceOf(OrcaPolicyError);
  });

  it("keeps navigation on the provider's host over https", async () => {
    const orca = orcaWithTab();
    orca.on("eval", () => ({ result: JSON.stringify({ v: 200 }) }));
    const tab = await openOrcaProviderTab(spec(true), { env: env({ FACTORY_ORCA_PROVIDER_TABS: "chatgpt=gpt-tab" }), runner: orca.runner });
    await expect(tab.navigate("https://evil.example/")).rejects.toThrow(/only navigate within/);
    await expect(tab.navigate("http://chatgpt.com/")).rejects.toThrow(/only navigate within/);
    expect(orca.of("goto")).toHaveLength(0);
    await tab.navigate("https://chatgpt.com/c/abc");
    expect(flag(orca.of("goto")[0]!.args, "--url")).toBe("https://chatgpt.com/c/abc");
  });
});

describe("assertNoCredentials", () => {
  it("refuses tokens, bearer headers, API keys and credential fields", () => {
    expect(() => assertNoCredentials({ path: [{ text: "hello", images: ["sediment://file_1"] }] })).not.toThrow();
    expect(() => assertNoCredentials("iVBORw0KGgoAAAANSUhEUgAA")).not.toThrow();
    expect(() => assertNoCredentials(["Bearer abcdefghijklmnopqrstuvwxyz012345"])).toThrow(OrcaPolicyError);
    expect(() => assertNoCredentials({ k: "sk-abcdefghijklmnopqrstu" })).toThrow(OrcaPolicyError);
    expect(() => assertNoCredentials({ accessToken: "x" })).toThrow(/accessToken/);
    expect(() => assertNoCredentials({ nested: { cookie: "a=b" } })).toThrow(/cookie/);
  });
});
