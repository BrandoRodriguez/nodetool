/**
 * The orca transport against the real Orca app and a local test site.
 *
 * Opt in: FACTORY_ORCA_INTEGRATION=1, with Orca running, the "AI Content
 * Factory" profile created, and the factory environment exported
 * (electron/scripts/factory/dev-env.sh + factory_runtime_env).
 *
 * The first block runs NodeTool's own browser actions with
 * NODETOOL_BROWSER_TRANSPORT=orca. The second opens sessions directly and
 * records every orca command, to assert what was and was not sent.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  browserCaptureMedia,
  browserClick,
  browserConsoleExec,
  browserInput,
  browserNavigate,
  browserRestart,
  browserSelectOption,
  browserStatus,
  browserUploadAsset,
  browserView,
  closeBrowserSession
} from "@nodetool-ai/browser";
import { commandName, openOrcaSession, spawnRunner, type OrcaRunner } from "../../src/index.js";
import { startSite, type TestSite } from "../fixtures/site.js";

const enabled = process.env["FACTORY_ORCA_INTEGRATION"] === "1";
const suite = enabled ? describe : describe.skip;

let site: TestSite;
const savedEnv = { ...process.env };

beforeAll(async () => {
  if (!enabled) return;
  site = await startSite();
  process.env["NODETOOL_BROWSER_TRANSPORT"] = "orca";
  process.env["NODETOOL_BROWSER_TRANSPORT_MODULES"] = "orca=@nodetool-ai/factory-browser-orca";
  process.env["FACTORY_ORCA_ALLOWED_ORIGINS"] = site.origin;
  process.env["FACTORY_ORCA_MIN_ACTION_INTERVAL_MS"] = "50";
});

afterAll(async () => {
  if (!enabled) return;
  await closeBrowserSession();
  await site.close();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

async function indexOf(selectorText: (e: { tag: string; attributes: Record<string, string> }) => boolean): Promise<number> {
  const view = await browserView({ include_screenshot: false });
  const el = view.elements.find(selectorText);
  if (!el) throw new Error("element not indexed");
  return el.index;
}

suite("NodeTool browser actions on the orca transport", () => {
  it("reports the transport before opening a session", async () => {
    const status = await browserStatus();
    expect(status.transport).toBe("orca");
    expect(status.session_open).toBe(false);
    expect(status.hint).toMatch(/Orca built-in browser/);
  });

  it("navigates, reads the page and takes a screenshot", async () => {
    const nav = await browserNavigate({ url: `${site.origin}/` });
    expect(nav).toMatchObject({ url: `${site.origin}/`, title: "Factory Home", status: 200 });
    const view = await browserView({ include_screenshot: true });
    expect(view.elements.some((e) => e.tag === "a" && e.attributes["href"] === "/form")).toBe(true);
    expect(Buffer.from(view.screenshot_png_b64 ?? "", "base64").subarray(1, 4).toString()).toBe("PNG");
    const result = await browserConsoleExec({ javascript: "({ title: document.title, n: 2 + 2 })" });
    expect(JSON.parse(result.result_json)).toEqual({ title: "Factory Home", n: 4 });
  });

  it("fills a form, uploads a file and submits it", async () => {
    await browserNavigate({ url: `${site.origin}/form` });
    await browserInput({ index: await indexOf((e) => e.attributes["id"] === "name"), text: "Ñandú factory ✓" });
    await browserSelectOption({ index: await indexOf((e) => e.attributes["id"] === "format"), option: "square" });
    await browserClick({ index: await indexOf((e) => e.attributes["id"] === "agree") });
    const upload = await browserUploadAsset({
      index: await indexOf((e) => e.attributes["id"] === "file"),
      file_b64: Buffer.from("factory upload body").toString("base64"),
      file_name: "clip-notes.txt",
      mime_type: "text/plain"
    });
    expect(upload).toBeTruthy();
    await browserClick({ index: await indexOf((e) => e.attributes["id"] === "submit") });
    const sent = site.submissions.at(-1);
    expect(sent?.fields).toEqual({ name: "Ñandú factory ✓", format: "square", agree: "yes" });
    expect(sent?.file?.name).toBe("clip-notes.txt");
    expect(sent?.file?.bytes.toString()).toBe("factory upload body");
  });

  it("captures media behind the page's session, byte for byte", async () => {
    await browserNavigate({ url: `${site.origin}/account` });
    await browserInput({ index: await indexOf((e) => e.attributes["id"] === "user"), text: "factory-it" });
    await browserClick({ index: await indexOf((e) => e.attributes["id"] === "login") });
    const raw = await browserCaptureMedia({ url: `${site.origin}/media/private.png`, media_type: "image" });
    expect(raw.mime_type).toBe("image/png");
    expect(Buffer.from(raw.media_b64, "base64").equals(site.image)).toBe(true);
    expect(site.requests.filter((r) => r.path === "/media/private.png").at(-1)?.session).toBe(true);
  });

  it("keeps the signed-in session across a restart (new tab, same profile)", async () => {
    const restarted = await browserRestart({ url: `${site.origin}/account` });
    expect(restarted.transport).toBe("orca");
    const text = await browserConsoleExec({ javascript: "document.getElementById('state').textContent" });
    expect(JSON.parse(text.result_json)).toBe("signed-in:factory-it");
    // Sign out so the profile keeps no test session.
    await browserNavigate({ url: `${site.origin}/logout` });
  });

  it("refuses navigation outside the allowed origins", async () => {
    await expect(browserNavigate({ url: "https://example.com/" })).rejects.toMatchObject({ name: "OrcaPolicyError", code: "policy_denied" });
  });
});

suite("orca sessions opened directly", () => {
  const sent: string[] = [];
  const recording: OrcaRunner = (exe, args, opts) => {
    sent.push(commandName(args));
    return spawnRunner(exe, args, opts);
  };

  it("drives two tabs at once without crossing state", async () => {
    const [a, b] = await Promise.all([openOrcaSession({ runner: recording }), openOrcaSession({ runner: recording })]);
    try {
      expect(a.page.pageId).not.toBe(b.page.pageId);
      await Promise.all([a.page.goto(`${site.origin}/`), b.page.goto(`${site.origin}/form`)]);
      expect(await a.page.title()).toBe("Factory Home");
      expect(await b.page.title()).toBe("Factory Form");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("enforces the media size limit", async () => {
    const env = { ...process.env, FACTORY_ORCA_MAX_MEDIA_BYTES: "10000" };
    const s = await openOrcaSession({ env, runner: recording });
    try {
      await s.page.goto(`${site.origin}/`);
      await expect(s.captureMedia!({ url: `${site.origin}/media/download.png` })).rejects.toThrow(/10000-byte limit/);
    } finally {
      await s.close();
    }
  });

  it("never asked Orca for cookies, profiles of others or other workspaces", () => {
    expect(sent.length).toBeGreaterThan(5);
    expect(sent.some((c) => c.startsWith("cookie"))).toBe(false);
    expect(sent.some((c) => c === "tab list")).toBe(false);
    expect(sent.filter((c) => c.startsWith("tab profile")).every((c) => c === "tab profile list")).toBe(true);
  });
});
