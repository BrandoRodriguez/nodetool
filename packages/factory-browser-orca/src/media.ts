/**
 * Media capture over the Orca transport, bounded in size and memory.
 *
 * Orca exposes no response bodies, so the bytes come from a `fetch` inside the
 * page: it runs with the page's own session and permissions, the same request
 * the page could make itself. The bytes stay in the page under a random key
 * and cross to Node in chunks, so no single CLI answer holds the whole file.
 *
 * Memory: the page holds at most `maxBytes`; Node holds the chunks (≤ maxBytes)
 * and then their base64 (≈ 1.34 × maxBytes). Larger media is refused before
 * its body is read when the server declares a length, and after otherwise.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { BrowserCaptureMediaInput, BrowserCaptureMediaRaw, BrowserPage } from "@nodetool-ai/browser";
import { OrcaPolicyError } from "./errors.js";

export interface MediaCaptureOptions {
  maxBytes: number;
  chunkBytes: number;
}

interface StagedMedia {
  ok: boolean;
  size: number;
  mime: string;
  error?: string;
}

const MEDIA_SCHEMES = new Set(["http:", "https:", "blob:", "data:"]);

/** The page-side key prefix under which staged bytes live. */
const STORE = "__factoryOrcaMedia";

function fallbackMime(mediaType: BrowserCaptureMediaInput["media_type"]): string {
  if (mediaType === "video") return "video/mp4";
  if (mediaType === "audio") return "audio/mpeg";
  if (mediaType === "image") return "image/png";
  return "application/octet-stream";
}

/** The URL behind an indexed element, preferring the variant actually loaded. */
async function sourceOfIndex(page: BrowserPage, index: number): Promise<string | null> {
  return page.evaluate<string | null>((idx: number) => {
    const el = document.querySelector(`[data-nt-idx="${idx}"]`);
    if (!el) return null;
    const media = el as HTMLMediaElement & HTMLImageElement;
    const src = media.currentSrc || media.src || el.getAttribute("src");
    if (src) return src;
    const nested = el.querySelector("video, audio, img, source");
    if (!nested) return null;
    return (
      (nested as HTMLMediaElement).currentSrc ||
      (nested as HTMLImageElement).src ||
      nested.getAttribute("src")
    );
  }, index);
}

export class MediaCapture {
  private readonly opts: MediaCaptureOptions;
  private readonly inflight = new Map<string, Promise<BrowserCaptureMediaRaw>>();

  constructor(opts: MediaCaptureOptions) {
    this.opts = opts;
  }

  /** Captures one media source. Two identical captures in flight share one fetch. */
  capture(page: BrowserPage, input: BrowserCaptureMediaInput): Promise<BrowserCaptureMediaRaw> {
    const key = JSON.stringify([page.url(), input.index ?? null, input.url ?? null, input.resource_url ?? null]);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = this.captureOnce(page, input).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private async captureOnce(page: BrowserPage, input: BrowserCaptureMediaInput): Promise<BrowserCaptureMediaRaw> {
    const source =
      input.index !== undefined
        ? await sourceOfIndex(page, input.index)
        : (input.url ?? input.resource_url ?? null);
    if (!source) {
      throw new OrcaPolicyError("No media source: give an element index, url or resource_url");
    }
    const absolute = new URL(source, page.url());
    if (!MEDIA_SCHEMES.has(absolute.protocol)) {
      throw new OrcaPolicyError(`Media from ${absolute.protocol} URLs is not captured`);
    }

    const token = randomUUID();
    let staged: StagedMedia;
    try {
      staged = await page.evaluate<StagedMedia>(
        async (target: string, store: string, key: string, max: number) => {
          const w = window as unknown as Record<string, Map<string, { bytes: Uint8Array; mime: string }>>;
          w[store] ??= new Map();
          const res = await fetch(target, { credentials: "include" });
          if (!res.ok) return { ok: false, size: 0, mime: "", error: `HTTP ${res.status}` };
          const declared = Number(res.headers.get("content-length") ?? "0");
          if (declared > max) {
            await res.body?.cancel();
            return { ok: false, size: declared, mime: "", error: "too_large" };
          }
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.length > max) return { ok: false, size: bytes.length, mime: "", error: "too_large" };
          const mime = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
          w[store].set(key, { bytes, mime });
          return { ok: true, size: bytes.length, mime };
        },
        absolute.href,
        STORE,
        token,
        this.opts.maxBytes
      );
    } catch (err) {
      await this.release(page, token);
      throw err;
    }
    if (!staged.ok) {
      if (staged.error === "too_large") {
        throw new OrcaPolicyError(
          `Media is ${staged.size} bytes, above the ${this.opts.maxBytes}-byte limit (FACTORY_ORCA_MAX_MEDIA_BYTES)`
        );
      }
      throw new Error(`Fetching ${absolute.href} in the page failed: ${staged.error ?? "unknown error"}`);
    }

    const chunks: Buffer[] = [];
    try {
      for (let offset = 0; offset < staged.size; offset += this.opts.chunkBytes) {
        const b64 = await page.evaluate<string>(
          (store: string, key: string, start: number, length: number) => {
            const entry = (window as unknown as Record<string, Map<string, { bytes: Uint8Array }>>)[store]?.get(key);
            if (!entry) throw new Error("staged media is gone");
            const view = entry.bytes.subarray(start, start + length);
            let binary = "";
            for (let i = 0; i < view.length; i += 0x8000) {
              binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
            }
            return btoa(binary);
          },
          STORE,
          token,
          offset,
          this.opts.chunkBytes
        );
        chunks.push(Buffer.from(b64, "base64"));
      }
    } finally {
      await this.release(page, token);
    }

    const bytes = Buffer.concat(chunks);
    if (bytes.length !== staged.size) {
      throw new Error(`Media transfer was incomplete: ${bytes.length} of ${staged.size} bytes`);
    }
    return {
      media_b64: bytes.toString("base64"),
      mime_type: staged.mime || fallbackMime(input.media_type),
      source_url: absolute.href,
      via: "in_page_fetch"
    };
  }

  /** Drops the staged bytes from the page. Never throws: the tab may be gone. */
  private async release(page: BrowserPage, token: string): Promise<void> {
    try {
      await page.evaluate(
        (store: string, key: string) => {
          (window as unknown as Record<string, Map<string, unknown>>)[store]?.delete(key);
          return true;
        },
        STORE,
        token
      );
    } catch {
      // Best effort: a closed tab or a navigation already freed the memory.
    }
  }
}
