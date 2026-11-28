/**
 * The provider-tab channel against the real Orca app and the local test
 * site, acting as a simulated provider (host 127.0.0.1). No real provider is
 * contacted. Opt in with FACTORY_ORCA_INTEGRATION=1.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrcaCli, openOrcaProviderTab, openOrcaSession, readOrcaTransportConfig, TabScope } from "../../src/index.js";
import { startSite, type TestSite } from "../fixtures/site.js";

const enabled = process.env["FACTORY_ORCA_INTEGRATION"] === "1";
const suite = enabled ? describe : describe.skip;
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWN0b3J5LXRlc3QifQ.c2lnbmF0dXJlLWZvci10ZXN0cw";

let site: TestSite;
let scope: TabScope;
let pageId = "";
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  if (!enabled) return;
  site = await startSite();
  const config = readOrcaTransportConfig();
  scope = new TabScope(createOrcaCli(config), {
    worktree: config.worktree,
    profileId: config.profileId,
    profileLabel: config.profileLabel,
    authorizedPageIds: []
  });
  pageId = await scope.openTab(`${site.origin}/account`);
  env = { ...process.env, FACTORY_ORCA_PROVIDER_TABS: `simulated=${pageId}`, FACTORY_ORCA_MIN_ACTION_INTERVAL_MS: "0" };
});

afterAll(async () => {
  if (!enabled) return;
  await scope.closeTab(pageId);
  await site.close();
});

suite("provider tabs on Orca with a simulated provider", () => {
  it("runs the provider's own script with the page's session, host-checked", async () => {
    const tab = await openOrcaProviderTab({ providerId: "simulated", host: "127.0.0.1", automated: true }, { env });
    const state = await tab.evaluate(`/*nt:state*/ (async () => {
      const r = await fetch("/account", { credentials: "include" });
      return { status: r.status, anonymous: (await r.text()).includes("anonymous") };
    })()`);
    expect(state).toEqual({ status: 200, anonymous: true });
  });

  it("refuses a script result that carries a token from the page", async () => {
    const tab = await openOrcaProviderTab({ providerId: "simulated", host: "127.0.0.1", automated: true }, { env });
    await expect(
      tab.evaluate(`(() => { localStorage.setItem("t", ${JSON.stringify(FAKE_JWT)}); return { leaked: localStorage.getItem("t") }; })()`)
    ).rejects.toMatchObject({ name: "OrcaPolicyError" });
    // The page keeps it; only the way out is closed.
    await expect(tab.evaluate(`(() => { const had = !!localStorage.getItem("t"); localStorage.removeItem("t"); return had; })()`)).resolves.toBe(true);
  });

  it("refuses a provider whose authorized tab is on another host", async () => {
    await expect(
      openOrcaProviderTab({ providerId: "simulated", host: "chatgpt.com", automated: true }, { env })
    ).rejects.toThrow(/is on 127.0.0.1, not chatgpt.com/);
  });

  it("in assisted mode shows the tab and runs nothing", async () => {
    const tab = await openOrcaProviderTab({ providerId: "simulated", host: "127.0.0.1", automated: false }, { env });
    await expect(tab.evaluate("1")).rejects.toThrow(/assisted mode/);
    await expect(tab.focus?.()).resolves.toBeUndefined();
  });

  it("keeps agent script text blocked in the same tab", async () => {
    const session = await openOrcaSession({ env: { ...env, FACTORY_ORCA_PAGE_ID: pageId, FACTORY_ORCA_AUTHORIZED_PAGES: pageId } });
    try {
      await expect(session.page.evaluate("document.cookie")).rejects.toThrow(/FACTORY_ORCA_ALLOW_PAGE_SCRIPTS/);
    } finally {
      await session.close();
    }
  });
});
