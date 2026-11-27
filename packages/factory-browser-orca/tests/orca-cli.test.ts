import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OrcaAbortError,
  OrcaCli,
  OrcaError,
  OrcaPolicy,
  OrcaPolicyError,
  OrcaProtocolError,
  OrcaTabGoneError,
  OrcaTimeoutError,
  OrcaUnavailableError,
  spawnRunner,
  type OrcaRunner
} from "../src/index.js";

const W = "path:/factory";
const page = (id = "p1"): string[] => ["--page", id, "--worktree", W];
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-orca-bin.mjs");

function cli(runner: OrcaRunner, maxConcurrent = 4): OrcaCli {
  return new OrcaCli({
    executable: "orca",
    policy: new OrcaPolicy({ worktree: W, allowedOrigins: [], minActionIntervalMs: 0, maxNavigationsPerMinute: 100 }),
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 1024 * 1024,
    maxConcurrent,
    runner,
    retryDelayMs: 1
  });
}

const ok = (result: unknown) => ({ stdout: JSON.stringify({ ok: true, result }), exitCode: 0 });
const fail = (code: string, message = "x") => ({ stdout: JSON.stringify({ ok: false, error: { code, message } }), exitCode: 1 });
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("OrcaCli", () => {
  it("adds --json and returns the result", async () => {
    let seen: string[] = [];
    const c = cli(async (_e, args) => {
      seen = args;
      return ok({ result: "1" });
    });
    await expect(c.run(["eval", "--expression", "1", ...page()])).resolves.toEqual({ result: "1" });
    expect(seen.at(-1)).toBe("--json");
  });

  it("checks the policy before running anything", async () => {
    let ran = false;
    const c = cli(async () => {
      ran = true;
      return ok({});
    });
    await expect(c.run(["cookie", "get", ...page()])).rejects.toBeInstanceOf(OrcaPolicyError);
    expect(ran).toBe(false);
  });

  it("maps Orca errors to typed errors", async () => {
    await expect(cli(async () => fail("browser_tab_not_found")).run(["eval", "--expression", "1", ...page("gone")])).rejects.toBeInstanceOf(
      OrcaTabGoneError
    );
    await expect(cli(async () => fail("browser_error", "Element not found")).run(["click", "--element", "#x", ...page()])).rejects.toMatchObject({
      code: "browser_error",
      message: "Element not found"
    });
    await expect(cli(async () => ({ stdout: "garbage", exitCode: 1 })).run(["status"])).rejects.toBeInstanceOf(OrcaProtocolError);
  });

  it("shares an identical read already in flight", async () => {
    let calls = 0;
    const c = cli(async () => {
      calls += 1;
      await tick();
      return ok({ result: "same" });
    });
    const args = ["eval", "--expression", "document.title", ...page()];
    const [a, b] = await Promise.all([c.run(args), c.run(args)]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    await c.run(args);
    expect(calls).toBe(2);
  });

  it("never merges or repeats actions", async () => {
    let calls = 0;
    const c = cli(async () => {
      calls += 1;
      return calls === 1 ? fail("runtime_unavailable") : ok({});
    });
    const click = ["click", "--element", "#submit", ...page()];
    await expect(c.run(click)).rejects.toBeInstanceOf(OrcaUnavailableError);
    expect(calls).toBe(1);
    await Promise.all([c.run(click), c.run(click)]);
    expect(calls).toBe(3);
  });

  it("retries a read when Orca reports a busy runtime", async () => {
    let calls = 0;
    const c = cli(async () => {
      calls += 1;
      return calls < 3 ? fail("runtime_unavailable") : ok({ fine: true });
    });
    await expect(c.run(["status"])).resolves.toEqual({ fine: true });
    expect(calls).toBe(3);
  });

  it("runs one tab's commands in order and other tabs in parallel", async () => {
    const order: string[] = [];
    const c = cli(async (_e, args) => {
      const id = args[args.indexOf("--page") + 1];
      const el = args[args.indexOf("--element") + 1];
      order.push(`start ${id}${el}`);
      await new Promise((r) => setTimeout(r, el === "#slow" ? 30 : 1));
      order.push(`end ${id}${el}`);
      return ok({});
    });
    await Promise.all([
      c.run(["click", "--element", "#slow", ...page("A")]),
      c.run(["click", "--element", "#fast", ...page("A")]),
      c.run(["click", "--element", "#other", ...page("B")])
    ]);
    expect(order.indexOf("end A#slow")).toBeLessThan(order.indexOf("start A#fast"));
    expect(order.indexOf("end B#other")).toBeLessThan(order.indexOf("end A#slow"));
  });

  it("limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    const c = cli(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      return ok({});
    }, 2);
    await Promise.all(["A", "B", "C", "D", "E"].map((id) => c.run(["click", "--element", "#x", ...page(id)])));
    expect(peak).toBe(2);
  });

  it("keeps a tab's queue moving after a failure", async () => {
    let n = 0;
    const c = cli(async () => (++n === 1 ? fail("browser_error") : ok({ n })));
    await expect(c.run(["click", "--element", "#a", ...page()])).rejects.toBeInstanceOf(OrcaError);
    await expect(c.run(["click", "--element", "#b", ...page()])).resolves.toEqual({ n: 2 });
  });
});

describe("spawnRunner", () => {
  const opts = { timeoutMs: 2_000, maxOutputBytes: 1024 * 1024, env: process.env };

  it("sends stdin and keeps it out of argv", async () => {
    const r = await spawnRunner(process.execPath, [BIN, "stdin", "fill", "--value-stdin"], { ...opts, stdin: "s3cret" });
    const parsed = JSON.parse(r.stdout) as { result: { received: string; argv: string[] } };
    expect(parsed.result.received).toBe("s3cret");
    expect(parsed.result.argv.join(" ")).not.toContain("s3cret");
  });

  it("kills a command past its deadline", async () => {
    const start = Date.now();
    await expect(spawnRunner(process.execPath, [BIN, "hang"], { ...opts, timeoutMs: 300 })).rejects.toBeInstanceOf(OrcaTimeoutError);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("stops on cancellation", async () => {
    const ac = new AbortController();
    const pending = spawnRunner(process.execPath, [BIN, "hang"], { ...opts, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(pending).rejects.toBeInstanceOf(OrcaAbortError);
    const pre = new AbortController();
    pre.abort();
    await expect(spawnRunner(process.execPath, [BIN, "hang"], { ...opts, signal: pre.signal })).rejects.toBeInstanceOf(OrcaAbortError);
  });

  it("refuses output past the cap instead of buffering it", async () => {
    await expect(spawnRunner(process.execPath, [BIN, "flood"], { ...opts, maxOutputBytes: 64 * 1024 })).rejects.toMatchObject({
      code: "output_too_large"
    });
  });

  it("reports a missing executable as Orca unavailable", async () => {
    await expect(spawnRunner("/nonexistent/orca", ["status"], opts)).rejects.toBeInstanceOf(OrcaUnavailableError);
  });
});
