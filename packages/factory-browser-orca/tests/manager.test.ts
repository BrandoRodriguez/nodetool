import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openOrcaSignInTab, orcaTransportStatus } from "../src/index.js";
import { FakeOrca, PROFILE_ID, fakeEnv, flag } from "./fake-orca.js";

const roots: string[] = [];
function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-manager-"));
  roots.push(dir);
  return fakeEnv(dir, extra);
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const READ_ONLY = new Set(["status", "tab profile list", "tab show"]);

describe("orcaTransportStatus", () => {
  it("reports each provider tab by profile and host, using read-only commands", async () => {
    const orca = new FakeOrca();
    orca.tabs.set("gpt", { profileId: PROFILE_ID, url: "https://chatgpt.com/c/1", title: "ChatGPT" });
    orca.tabs.set("wrong-host", { profileId: PROFILE_ID, url: "https://example.com/", title: "x" });
    orca.tabs.set("default-profile", { profileId: "default", url: "https://chatgpt.com/", title: "x" });

    const status = await orcaTransportStatus(
      {
        chatgpt: { pageId: "gpt", host: "chatgpt.com" },
        other: { pageId: "wrong-host", host: "chatgpt.com" },
        shared: { pageId: "default-profile", host: "chatgpt.com" },
        gone: { pageId: "missing", host: "chatgpt.com" }
      },
      { env: env(), runner: orca.runner }
    );

    expect(status.connected).toBe(true);
    expect(status.tabs["chatgpt"]).toEqual({ exists: true, onHost: true });
    expect(status.tabs["other"]).toMatchObject({ exists: true, onHost: false, detail: expect.stringContaining("example.com") });
    expect(status.tabs["shared"]).toMatchObject({ exists: false, detail: expect.stringContaining("profile") });
    expect(status.tabs["gone"]).toMatchObject({ exists: false });
    // Nothing that changes a tab or reads a page.
    expect(orca.calls.every((call) => READ_ONLY.has(call.command))).toBe(true);
  });

  it("is not connected when Orca is not ready or the workspace is not set", async () => {
    const orca = new FakeOrca().on("status", () => ({ app: { running: false } }));
    const down = await orcaTransportStatus({ chatgpt: { pageId: "gpt", host: "chatgpt.com" } }, { env: env(), runner: orca.runner });
    expect(down).toMatchObject({ connected: false, tabs: { chatgpt: { exists: false } } });

    const noWorkspace = await orcaTransportStatus({}, { env: { ...env(), FACTORY_ORCA_WORKTREE: "" }, runner: new FakeOrca().runner });
    expect(noWorkspace.connected).toBe(false);
  });

  it("is not connected without the isolated factory profile", async () => {
    const orca = new FakeOrca().on("tab profile list", () => ({ profiles: [{ id: "default", scope: "default", label: "Default" }] }));
    const status = await orcaTransportStatus({}, { env: env(), runner: orca.runner });
    expect(status).toMatchObject({ connected: false, detail: expect.stringContaining("AI Content Factory") });
  });
});

describe("openOrcaSignInTab", () => {
  it("opens a focused tab in the factory profile and workspace", async () => {
    const orca = new FakeOrca();
    const pageId = await openOrcaSignInTab("https://chatgpt.com/", { env: env(), runner: orca.runner });
    const [create] = orca.of("tab create");
    expect(flag(create!.args, "--profile")).toBe(PROFILE_ID);
    expect(flag(create!.args, "--url")).toBe("https://chatgpt.com/");
    expect(create!.args).toContain("--focus");
    expect(orca.tabs.get(pageId)?.profileId).toBe(PROFILE_ID);
  });

  it("keeps the navigation allowlist", async () => {
    const orca = new FakeOrca();
    await expect(
      openOrcaSignInTab("https://chatgpt.com/", {
        env: env({ FACTORY_ORCA_ALLOWED_ORIGINS: "https://example.com" }),
        runner: orca.runner
      })
    ).rejects.toThrow();
    expect(orca.of("tab create")).toHaveLength(0);
  });
});
