/**
 * Registered browser transports: the registry itself, and the action loop
 * running on a registered transport while the built-in ones stay as they were.
 */

import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  browserCaptureMedia,
  browserNavigate,
  browserRestart,
  browserStatus,
  browserView,
  closeBrowserSession
} from "../src/actions.js";
import {
  loadBrowserTransport,
  parseTransportModules,
  registerBrowserTransport,
  unregisterBrowserTransport,
  type BrowserTransportFactory
} from "../src/transport-registry.js";
import type { BrowserPage } from "../src/browser-page.js";

const ENV_KEYS = ["NODETOOL_BROWSER_TRANSPORT", "NODETOOL_BROWSER_TRANSPORT_MODULES"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(async () => {
  await closeBrowserSession();
  unregisterBrowserTransport("fake");
  unregisterBrowserTransport("fixture");
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function fakePage(log: string[]): BrowserPage {
  let current = "about:blank";
  return {
    url: () => current,
    viewportSize: () => ({ width: 800, height: 600 }),
    title: async () => "Fake",
    on: () => undefined,
    goto: async (url) => {
      log.push(`goto ${url}`);
      current = url;
      return { status: 200 };
    },
    evaluate: async () => [] as never,
    click: async () => undefined,
    fill: async () => undefined,
    press: async () => undefined,
    selectOption: async () => [],
    setFileInputFiles: async () => undefined,
    screenshot: async () => Buffer.from("png"),
    mouse: { move: async () => undefined, click: async () => undefined },
    keyboard: { type: async () => undefined, press: async () => undefined }
  };
}

function fakeFactory(log: string[]): BrowserTransportFactory {
  return {
    id: "fake",
    describe: () => "A fake transport for tests.",
    open: async () => {
      log.push("open");
      return {
        page: fakePage(log),
        close: async () => {
          log.push("close");
        },
        capabilities: {
          networkResponseBodies: false,
          consoleMessages: "none",
          rawCdp: false,
          coordinateInput: false,
          downloadPath: false,
          signedInSessions: false,
          maxMediaBytes: 10,
          limitations: []
        },
        captureMedia: async (input) => ({
          media_b64: "AA==",
          mime_type: "image/png",
          source_url: input.url ?? null,
          via: "in_page_fetch"
        })
      };
    }
  };
}

describe("transport registry", () => {
  it("refuses to replace a built-in transport", () => {
    expect(() => registerBrowserTransport({ ...fakeFactory([]), id: "local" })).toThrow(/built in/);
    expect(() => registerBrowserTransport({ ...fakeFactory([]), id: "extension" })).toThrow(/built in/);
  });

  it("parses id=module entries and rejects malformed ones", () => {
    expect([...parseTransportModules(" a=@x/a , b=./b.js ")]).toEqual([
      ["a", "@x/a"],
      ["b", "./b.js"]
    ]);
    expect(parseTransportModules(undefined).size).toBe(0);
    expect(() => parseTransportModules("broken")).toThrow(/id=module/);
  });

  it("names the way out for an unknown transport", async () => {
    await expect(loadBrowserTransport("nope", {})).rejects.toThrow(/NODETOOL_BROWSER_TRANSPORT_MODULES/);
  });

  it("loads a transport module on first use and checks its id", async () => {
    const fixture = pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fixture-transport.mjs")
    ).href;
    const factory = await loadBrowserTransport("fixture", { NODETOOL_BROWSER_TRANSPORT_MODULES: `fixture=${fixture}` });
    expect(factory.describe()).toBe("fixture transport");
    await expect(
      loadBrowserTransport("other", { NODETOOL_BROWSER_TRANSPORT_MODULES: `other=${fixture}` })
    ).rejects.toThrow(/exports transport "fixture"/);
  });
});

describe("actions on a registered transport", () => {
  it("drives the registered page and reports its id", async () => {
    const log: string[] = [];
    registerBrowserTransport(fakeFactory(log));
    process.env["NODETOOL_BROWSER_TRANSPORT"] = "fake";

    const status = await browserStatus();
    expect(status).toMatchObject({ transport: "fake", session_open: false, hint: "A fake transport for tests." });

    const nav = await browserNavigate({ url: "https://site.test/" });
    expect(nav).toEqual({ url: "https://site.test/", title: "Fake", status: 200 });
    const view = await browserView({ include_screenshot: true });
    expect(view.screenshot_png_b64).toBe(Buffer.from("png").toString("base64"));
    expect(log).toEqual(["open", "goto https://site.test/"]);
  });

  it("uses the transport's own media capture", async () => {
    registerBrowserTransport(fakeFactory([]));
    process.env["NODETOOL_BROWSER_TRANSPORT"] = "fake";
    await expect(browserCaptureMedia({ url: "https://site.test/a.png" })).resolves.toMatchObject({
      media_b64: "AA==",
      source_url: "https://site.test/a.png"
    });
  });

  it("closes the registered session on restart and reopens it", async () => {
    const log: string[] = [];
    registerBrowserTransport(fakeFactory(log));
    process.env["NODETOOL_BROWSER_TRANSPORT"] = "fake";
    await browserNavigate({ url: "https://site.test/" });
    const restarted = await browserRestart({});
    expect(restarted.transport).toBe("fake");
    expect(log).toEqual(["open", "goto https://site.test/", "close", "open"]);
  });

  it("leaves local as the default transport", async () => {
    delete process.env["NODETOOL_BROWSER_TRANSPORT"];
    expect((await browserStatus()).transport).toBe("local");
    process.env["NODETOOL_BROWSER_TRANSPORT"] = "local";
    expect((await browserStatus()).transport).toBe("local");
  });

  it("reports a transport that cannot be loaded in the status hint", async () => {
    process.env["NODETOOL_BROWSER_TRANSPORT"] = "missing";
    const status = await browserStatus();
    expect(status.transport).toBe("missing");
    expect(status.hint).toMatch(/Unknown browser transport "missing"/);
  });
});
