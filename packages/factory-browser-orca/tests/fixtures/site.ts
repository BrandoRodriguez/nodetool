/**
 * A local test site for the integration suite: a form with a file input, a
 * sign-in that sets an HttpOnly cookie, media behind that session, and a
 * download link. Loopback only; nothing leaves the machine.
 */

import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (crcTable[(c ^ byte) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A gradient PNG, large enough to need several transfer chunks. */
export function testPng(w = 320, h = 180): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.floor((x * 255) / w);
      raw[o + 1] = Math.floor((y * 255) / h);
      raw[o + 2] = (x * y) % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function cookies(req: http.IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(/;\s*/)
      .filter(Boolean)
      .map((c) => c.split("=") as [string, string])
  );
}

export interface TestSite {
  origin: string;
  image: Buffer;
  /** Every submitted form, as the server parsed it. */
  submissions: Array<{ fields: Record<string, string>; file: { name: string; bytes: Buffer } | null }>;
  /** Requests seen, for asserting what the browser actually sent. */
  requests: Array<{ path: string; session: boolean }>;
  close(): Promise<void>;
}

export async function startSite(): Promise<TestSite> {
  const image = testPng();
  const submissions: TestSite["submissions"] = [];
  const requests: TestSite["requests"] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://site");
    const session = cookies(req)["session"];
    requests.push({ path: url.pathname, session: Boolean(session) });
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    switch (url.pathname) {
      case "/":
        return send(200, "text/html", page("Factory Home", `<h1>Factory test site</h1><a href="/form">form</a>`));
      case "/form":
        return send(
          200,
          "text/html",
          page(
            "Factory Form",
            `<form method="post" action="/submit" enctype="multipart/form-data">
              <input id="name" name="name" placeholder="name">
              <select id="format" name="format"><option value="vertical">Vertical</option><option value="square">Square</option></select>
              <input type="checkbox" id="agree" name="agree" value="yes">
              <input type="file" id="file" name="file">
              <button id="submit" type="submit">Send</button>
            </form>`
          )
        );
      case "/submit": {
        const parts: Buffer[] = [];
        req.on("data", (d: Buffer) => parts.push(d));
        req.on("end", () => {
          const body = Buffer.concat(parts);
          const boundary = /boundary=(.+)$/.exec(req.headers["content-type"] ?? "")?.[1] ?? "";
          const fields: Record<string, string> = {};
          let file: { name: string; bytes: Buffer } | null = null;
          for (const part of body.toString("latin1").split(`--${boundary}`).slice(1, -1)) {
            const split = part.indexOf("\r\n\r\n");
            const head = part.slice(0, split);
            const value = part.slice(split + 4, -2);
            const name = /name="([^"]+)"/.exec(head)?.[1];
            const filename = /filename="([^"]*)"/.exec(head)?.[1];
            if (filename) file = { name: filename, bytes: Buffer.from(value, "latin1") };
            else if (name) fields[name] = Buffer.from(value, "latin1").toString("utf8");
          }
          submissions.push({ fields, file });
          send(200, "text/html", page("Factory Result", `<pre id="result">received</pre>`));
        });
        return;
      }
      case "/account":
        return send(
          200,
          "text/html",
          page(
            "Factory Account",
            session
              ? `<p id="state">signed-in:${decodeURIComponent(session)}</p><img id="private" src="/media/private.png">`
              : `<p id="state">anonymous</p><form method="post" action="/login"><input id="user" name="user"><button id="login">Sign in</button></form>`
          )
        );
      case "/login": {
        let raw = "";
        req.on("data", (d: Buffer) => (raw += d.toString()));
        req.on("end", () => {
          const user = new URLSearchParams(raw).get("user") ?? "anon";
          send(302, "text/plain", "", {
            "set-cookie": `session=${encodeURIComponent(user)}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`,
            location: "/account"
          });
        });
        return;
      }
      case "/logout":
        return send(302, "text/plain", "", { "set-cookie": "session=; Path=/; Max-Age=0", location: "/account" });
      case "/media/private.png":
        return session ? send(200, "image/png", image) : send(401, "text/plain", "sign in first");
      case "/media/download.png":
        return send(200, "image/png", image, { "content-disposition": 'attachment; filename="factory.png"' });
      default:
        return send(404, "text/plain", "not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    image,
    submissions,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
