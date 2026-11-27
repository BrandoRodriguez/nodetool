import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserPage } from "@nodetool-ai/browser";
import { MediaCapture, OrcaPolicy, OrcaPolicyError, retryAfterSeconds } from "../src/index.js";

/** Runs page functions in this process, with `window` and `fetch` stubbed. */
function fakePage(url = "https://gen.test/result"): BrowserPage & { evals: number; window: Record<string, unknown> } {
  const win: Record<string, unknown> = {};
  const page = {
    evals: 0,
    window: win,
    url: () => url,
    async evaluate<T>(fn: unknown, ...args: unknown[]): Promise<T> {
      page.evals += 1;
      vi.stubGlobal("window", win);
      // Round-trip through JSON, as the real transport does.
      const out = await (fn as (...a: unknown[]) => unknown)(...(JSON.parse(JSON.stringify(args)) as unknown[]));
      return JSON.parse(JSON.stringify(out ?? null)) as T;
    }
  };
  return page as unknown as BrowserPage & { evals: number; window: Record<string, unknown> };
}

function serve(bytes: Uint8Array, headers: Record<string, string> = {}, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(status === 200 ? bytes : null, { status, headers: { "content-type": "video/mp4", ...headers } }))
  );
}

const bytesOf = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 256);

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MediaCapture", () => {
  it("transfers media in chunks and frees the page copy", async () => {
    const data = bytesOf(10_000);
    serve(data);
    const page = fakePage();
    const raw = await new MediaCapture({ maxBytes: 1_000_000, chunkBytes: 4_096 }).capture(page, { url: "/files/clip.mp4" });
    expect(Buffer.from(raw.media_b64, "base64").equals(Buffer.from(data))).toBe(true);
    expect(raw).toMatchObject({ mime_type: "video/mp4", source_url: "https://gen.test/files/clip.mp4", via: "in_page_fetch" });
    // stage + 3 chunks + release
    expect(page.evals).toBe(5);
    const store = page.window["__factoryOrcaMedia"] as Map<string, unknown>;
    expect(store.size).toBe(0);
  });

  it("refuses media above the limit before reading its body", async () => {
    serve(bytesOf(10), { "content-length": "999999999" });
    const page = fakePage();
    await expect(new MediaCapture({ maxBytes: 1_000, chunkBytes: 512 }).capture(page, { url: "/big.mp4" })).rejects.toBeInstanceOf(
      OrcaPolicyError
    );
  });

  it("refuses media above the limit when the length is not declared", async () => {
    serve(bytesOf(2_000));
    await expect(new MediaCapture({ maxBytes: 1_000, chunkBytes: 512 }).capture(fakePage(), { url: "/big.mp4" })).rejects.toThrow(
      /above the 1000-byte limit/
    );
  });

  it("refuses schemes that are not web media", async () => {
    await expect(new MediaCapture({ maxBytes: 1_000, chunkBytes: 512 }).capture(fakePage(), { url: "file:///etc/hosts" })).rejects.toThrow(
      /file: URLs/
    );
  });

  it("reports an HTTP failure from the page", async () => {
    serve(new Uint8Array(), {}, 403);
    await expect(new MediaCapture({ maxBytes: 1_000, chunkBytes: 512 }).capture(fakePage(), { url: "/x.mp4" })).rejects.toThrow(/HTTP 403/);
  });

  it("stops on HTTP 429, honours Retry-After, and fetches nothing while blocked", async () => {
    serve(new Uint8Array(), { "retry-after": "120" }, 429);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const policy = new OrcaPolicy({ worktree: "path:/f", allowedOrigins: [], minActionIntervalMs: 0, maxNavigationsPerMinute: 10 });
    const media = new MediaCapture({ maxBytes: 1_000, chunkBytes: 512, rateLimit: policy });
    const before = Date.now();
    const err = await media.capture(fakePage(), { url: "/v.mp4" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "rate_limited", origin: "https://gen.test" });
    expect((err as { retryAt: number }).retryAt).toBeGreaterThanOrEqual(before + 119_000);
    await expect(media.capture(fakePage(), { url: "/other.mp4" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterSeconds("30", now)).toBe(30);
    expect(retryAfterSeconds("Thu, 01 Jan 2026 00:01:00 GMT", now)).toBe(60);
    expect(retryAfterSeconds("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBe(0);
    expect(retryAfterSeconds("soon", now)).toBeNull();
    expect(retryAfterSeconds(null, now)).toBeNull();
  });

  it("shares one fetch between identical captures in flight", async () => {
    serve(bytesOf(100));
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const media = new MediaCapture({ maxBytes: 1_000, chunkBytes: 512 });
    const page = fakePage();
    const [a, b] = await Promise.all([media.capture(page, { url: "/a.mp4" }), media.capture(page, { url: "/a.mp4" })]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("frees the page copy when a chunk read fails", async () => {
    serve(bytesOf(3_000));
    const page = fakePage();
    const original = page.evaluate.bind(page);
    let n = 0;
    page.evaluate = (async (fn: unknown, ...args: unknown[]) => {
      n += 1;
      if (n === 3) throw new Error("tab navigated away");
      return original(fn as never, ...args);
    }) as typeof page.evaluate;
    await expect(new MediaCapture({ maxBytes: 10_000, chunkBytes: 1_000 }).capture(page, { url: "/v.mp4" })).rejects.toThrow(/navigated/);
    expect((page.window["__factoryOrcaMedia"] as Map<string, unknown>).size).toBe(0);
  });
});
