import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  buildEvalExpression,
  decodeEvalResult,
  openOrcaSession,
  OrcaHumanActionRequiredError,
  OrcaPolicyError,
  OrcaTabGoneError
} from "../src/index.js";
import { FakeOrca, PROFILE_ID, fakeEnv, flag } from "./fake-orca.js";

const roots: string[] = [];
function workRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-orca-test-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs a generated expression the way a page would, in an isolated context. */
async function runInPage(expression: string): Promise<string> {
  const context = vm.createContext({ JSON });
  return (await vm.runInContext(expression, context)) as string;
}

describe("evaluate marshalling", () => {
  it("passes hostile strings as data, never as code", async () => {
    const hostile = ['"); globalThis.pwned = 1; ("', "`${globalThis.pwned = 2}`", "</script><b>", "  ", "\\\"'"];
    const expression = buildEvalExpression((...args: string[]) => args, hostile);
    const context = vm.createContext({ JSON });
    const raw = (await vm.runInContext(expression, context)) as string;
    expect(decodeEvalResult<string[]>(raw)).toEqual(hostile);
    expect((context as Record<string, unknown>)["pwned"]).toBeUndefined();
  });

  it("keeps value types that Orca's string result would lose", async () => {
    expect(decodeEvalResult(await runInPage(buildEvalExpression("42", [])))).toBe(42);
    expect(decodeEvalResult(await runInPage(buildEvalExpression("'42'", [])))).toBe("42");
    expect(decodeEvalResult(await runInPage(buildEvalExpression("undefined", [])))).toBeNull();
    expect(decodeEvalResult(await runInPage(buildEvalExpression("Promise.resolve({ a: [1] })", [])))).toEqual({ a: [1] });
  });

  it("refuses a result the transport did not wrap", () => {
    expect(() => decodeEvalResult("42")).toThrow(/did not wrap/);
    expect(() => decodeEvalResult(42)).toThrow(/non-string/);
  });
});

describe("openOrcaSession", () => {
  it("opens a tab in the factory profile and workspace", async () => {
    const orca = new FakeOrca();
    const session = await openOrcaSession({ env: fakeEnv(workRoot()), runner: orca.runner });
    const create = orca.of("tab create")[0]!;
    expect(flag(create.args, "--profile")).toBe(PROFILE_ID);
    expect(flag(create.args, "--worktree")).toBe("path:/factory");
    expect(session.page.viewportSize()).toEqual({ width: 1000, height: 700 });
    // Every page command named the tab and the workspace.
    for (const call of orca.calls.filter((c) => c.args.includes("--page"))) {
      expect(flag(call.args, "--worktree")).toBe("path:/factory");
    }
  });

  it("refuses to run when only the default profile exists", async () => {
    const orca = new FakeOrca().on("tab profile list", () => ({ profiles: [{ id: "default", scope: "default", label: "Default" }] }));
    await expect(openOrcaSession({ env: fakeEnv(workRoot()), runner: orca.runner })).rejects.toThrow(/No Orca browser profile/);
    expect(orca.of("tab create")).toHaveLength(0);
  });

  it("refuses a profile that is not isolated, even when named", async () => {
    const orca = new FakeOrca();
    await expect(
      openOrcaSession({ env: fakeEnv(workRoot(), { FACTORY_ORCA_PROFILE_ID: "default" }), runner: orca.runner })
    ).rejects.toThrow(/never uses the default profile/);
  });

  it("refuses a tab that was neither opened by the factory nor authorized", async () => {
    const orca = new FakeOrca();
    orca.tabs.set("user-tab", { profileId: PROFILE_ID, url: "https://mail.example", title: "Mail" });
    await expect(
      openOrcaSession({ env: fakeEnv(workRoot(), { FACTORY_ORCA_PAGE_ID: "user-tab" }), runner: orca.runner })
    ).rejects.toThrow(/not in FACTORY_ORCA_AUTHORIZED_PAGES/);
    expect(orca.of("eval")).toHaveLength(0);
  });

  it("refuses an authorized tab that runs in another profile", async () => {
    const orca = new FakeOrca();
    orca.tabs.set("personal", { profileId: "default", url: "https://bank.example", title: "Bank" });
    await expect(
      openOrcaSession({
        env: fakeEnv(workRoot(), { FACTORY_ORCA_PAGE_ID: "personal", FACTORY_ORCA_AUTHORIZED_PAGES: "personal" }),
        runner: orca.runner
      })
    ).rejects.toThrow(/uses profile default/);
  });

  it("closes the tab it opened, and keeps it when asked", async () => {
    const orca = new FakeOrca();
    const session = await openOrcaSession({ env: fakeEnv(workRoot()), runner: orca.runner });
    await session.close();
    expect(orca.of("tab close")).toHaveLength(1);

    const keep = new FakeOrca();
    const kept = await openOrcaSession({ env: fakeEnv(workRoot(), { FACTORY_ORCA_KEEP_TABS: "1" }), runner: keep.runner });
    await kept.close();
    expect(keep.of("tab close")).toHaveLength(0);
  });

  it("declares what it cannot do", async () => {
    const session = await openOrcaSession({ env: fakeEnv(workRoot()), runner: new FakeOrca().runner });
    expect(session.capabilities).toMatchObject({ rawCdp: false, networkResponseBodies: false, downloadPath: false, consoleMessages: "polling" });
    expect(session.capabilities.limitations.join(" ")).toMatch(/Downloads folder/);
  });
});

describe("OrcaPage actions", () => {
  async function open(extra: NodeJS.ProcessEnv = {}) {
    const orca = new FakeOrca();
    const root = workRoot();
    const session = await openOrcaSession({ env: fakeEnv(root, extra), runner: orca.runner });
    return { orca, page: session.page, root };
  }

  it("sends fill values through stdin, never argv", async () => {
    const { orca, page } = await open();
    await page.fill("#password", "hunter2");
    const call = orca.of("fill")[0]!;
    expect(call.stdin).toBe("hunter2");
    expect(call.args.join(" ")).not.toContain("hunter2");
  });

  it("refuses unsafe navigation before calling Orca", async () => {
    const { orca, page } = await open();
    await expect(page.goto("file:///etc/passwd")).rejects.toBeInstanceOf(OrcaPolicyError);
    expect(orca.of("goto")).toHaveLength(0);
  });

  it("follows the URL and title an action reports", async () => {
    const { orca, page } = await open();
    orca.on("click", () => ({ clicked: "#a", effects: { url: "https://x.test/next", title: "Next" } }));
    await page.click("#a");
    expect(page.url()).toBe("https://x.test/next");
    await expect(page.title()).resolves.toBe("Next");
  });

  it("stops and hands over when the page asks for a passkey", async () => {
    const { orca, page } = await open();
    orca.on("click", () => ({ effects: { passkeyRequest: { origin: "https://id.test" } } }));
    await expect(page.click("#sign-in")).rejects.toBeInstanceOf(OrcaHumanActionRequiredError);
  });

  it("uploads only from the work and temp directories, never the rest of the environment", async () => {
    // As in the factory environment: TMPDIR is one folder of it, the secrets another.
    const envRoot = workRoot();
    const tmp = path.join(envRoot, "tmp");
    fs.mkdirSync(tmp);
    const spy = vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
    onTestFinished(() => spy.mockRestore());
    const orca = new FakeOrca();
    const { page } = await openOrcaSession({ env: fakeEnv(envRoot), runner: orca.runner });
    const root = envRoot;
    const workDir = path.join(root, "factory-browser-orca");
    const inside = path.join(workDir, "clip.mp4");
    fs.writeFileSync(inside, "x");
    await page.setFileInputFiles("#file", [inside]);
    expect(flag(orca.of("upload")[0]!.args, "--files")).toBe(inside);

    // The environment's secrets sit next to the work directory, not inside it.
    fs.mkdirSync(path.join(root, "secrets"));
    const secret = path.join(root, "secrets", "master.key");
    fs.writeFileSync(secret, "key");
    await expect(page.setFileInputFiles("#file", [secret])).rejects.toThrow(/temp or work directory/);
    // A link inside the work directory cannot reach it either.
    const link = path.join(workDir, "innocent.mp4");
    fs.symlinkSync(secret, link);
    await expect(page.setFileInputFiles("#file", [link])).rejects.toThrow(/temp or work directory/);
    await expect(page.setFileInputFiles("#file", [path.join(os.homedir(), ".ssh", "id_rsa")])).rejects.toThrow(/temp or work directory/);

    const comma = path.join(workDir, "a,b.mp4");
    fs.writeFileSync(comma, "x");
    await expect(page.setFileInputFiles("#file", [comma])).rejects.toThrow(/comma/);
    expect(orca.of("upload")).toHaveLength(1);
  });

  it("refuses caller script text unless page scripts are allowed", async () => {
    const { orca, page } = await open();
    await expect(page.evaluate("localStorage.getItem('token')")).rejects.toThrow(/FACTORY_ORCA_ALLOW_PAGE_SCRIPTS/);
    expect(orca.calls.filter((c) => c.command === "eval" && flag(c.args, "--expression")?.includes("localStorage"))).toHaveLength(0);
    // NodeTool's own page functions still run.
    orca.on("eval", () => ({ result: JSON.stringify({ v: 3 }) }));
    await expect(page.evaluate((a: number) => a + 1, 2)).resolves.toBe(3);

    const allowed = await open({ FACTORY_ORCA_ALLOW_PAGE_SCRIPTS: "1" });
    allowed.orca.on("eval", () => ({ result: JSON.stringify({ v: "ok" }) }));
    await expect(allowed.page.evaluate("document.title")).resolves.toBe("ok");
  });

  it("stops on HTTP 429 and keeps the origin blocked", async () => {
    const { orca, page } = await open({ FACTORY_ORCA_RATE_LIMIT_COOLDOWN_MS: "60000" });
    orca.on("goto", (args) => ({ url: flag(args, "--url"), title: "Too many requests" }));
    orca.on("eval", () => ({ result: JSON.stringify({ v: 429 }) }));
    await expect(page.goto("https://provider.test/create")).rejects.toMatchObject({ code: "rate_limited", origin: "https://provider.test" });
    const gotos = orca.of("goto").length;
    await expect(page.goto("https://provider.test/again")).rejects.toMatchObject({ code: "rate_limited" });
    await expect(page.click("#generate")).rejects.toMatchObject({ code: "rate_limited" });
    expect(orca.of("goto")).toHaveLength(gotos);
    expect(orca.of("click")).toHaveLength(0);
  });

  it("reports a tab the user closed", async () => {
    const { orca, page } = await open();
    orca.on("eval", () => {
      throw { code: "browser_tab_not_found", message: "gone" };
    });
    await expect(page.evaluate(() => 1)).rejects.toBeInstanceOf(OrcaTabGoneError);
  });

  it("clicks by coordinates with move, down and up", async () => {
    const { orca, page } = await open();
    await page.mouse.click(10.4, 20.6);
    expect(orca.calls.filter((c) => c.command.startsWith("mouse")).map((c) => c.command)).toEqual(["mouse move", "mouse down", "mouse up"]);
    expect(flag(orca.of("mouse move")[0]!.args, "--x")).toBe("10");
  });
});
