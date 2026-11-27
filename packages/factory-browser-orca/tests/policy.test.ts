import { describe, expect, it } from "vitest";
import { OrcaPolicy, OrcaPolicyError } from "../src/index.js";

const W = "path:/factory";
const page = ["--page", "p1", "--worktree", W];

function policy(extra: Partial<ConstructorParameters<typeof OrcaPolicy>[0]> = {}): OrcaPolicy {
  return new OrcaPolicy({
    worktree: W,
    allowedOrigins: [],
    minActionIntervalMs: 0,
    maxNavigationsPerMinute: 30,
    ...extra
  });
}

describe("OrcaPolicy.checkCommand", () => {
  it("allows page commands pinned to the factory tab and workspace", () => {
    expect(() => policy().checkCommand(["click", "--element", "#a", ...page])).not.toThrow();
    expect(() => policy().checkCommand(["tab", "show", ...page])).not.toThrow();
  });

  it.each([
    [["cookie", "get", ...page], "cookie"],
    [["tab", "profile", "create", "--label", "x"], "tab profile create"],
    [["tab", "profile", "delete", "--id", "x"], "tab profile delete"],
    [["download", "--selector", "a", ...page], "download"],
    [["terminal", "create"], "terminal"],
    [["tab", "list", "--worktree", W], "tab list"]
  ])("refuses %j", (args, name) => {
    expect(() => policy().checkCommand(args)).toThrow(new RegExp(name));
  });

  it("refuses page commands without --page or --worktree", () => {
    expect(() => policy().checkCommand(["click", "--element", "#a", "--worktree", W])).toThrow(/--page/);
    expect(() => policy().checkCommand(["click", "--element", "#a", "--page", "p1"])).toThrow(/--worktree/);
  });

  it("refuses other workspaces and wildcards", () => {
    expect(() => policy().checkCommand(["eval", "--expression", "1", "--page", "p", "--worktree", "path:/other"])).toThrow(
      /not the factory workspace/
    );
    expect(() => policy().checkCommand(["eval", "--expression", "1", "--page", "p", "--worktree", "all"])).toThrow(/all/);
  });

  it("only lets exec run read subcommands", () => {
    expect(() => policy().checkCommand(["exec", "--command", "get text #a", ...page])).not.toThrow();
    for (const sub of ["cookies", "storage local", "download a /tmp/x", "screenshot #a /tmp/x.png", "eval 1"]) {
      expect(() => policy().checkCommand(["exec", "--command", sub, ...page])).toThrow(OrcaPolicyError);
    }
  });

  it("requires the factory profile on tab create", () => {
    expect(() => policy().checkCommand(["tab", "create", "--url", "about:blank", "--worktree", W])).toThrow(/--profile/);
    expect(() =>
      policy().checkCommand(["tab", "create", "--url", "about:blank", "--worktree", W, "--profile", "p"])
    ).not.toThrow();
  });
});

describe("OrcaPolicy.checkNavigationUrl", () => {
  it("allows http, https and about:blank only", () => {
    const p = policy();
    expect(() => p.checkNavigationUrl("https://example.com/a")).not.toThrow();
    expect(() => p.checkNavigationUrl("about:blank")).not.toThrow();
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "data:text/html,x", "nope"]) {
      expect(() => p.checkNavigationUrl(bad)).toThrow(OrcaPolicyError);
    }
  });

  it("applies the origin allow-list, including https wildcards", () => {
    const p = policy({ allowedOrigins: ["http://127.0.0.1:8765", "*.example.com"] });
    expect(() => p.checkNavigationUrl("http://127.0.0.1:8765/x")).not.toThrow();
    expect(() => p.checkNavigationUrl("https://app.example.com/")).not.toThrow();
    expect(() => p.checkNavigationUrl("http://app.example.com/")).toThrow(/ALLOWED_ORIGINS/);
    expect(() => p.checkNavigationUrl("https://evil.com/")).toThrow(/ALLOWED_ORIGINS/);
  });
});

describe("OrcaPolicy.pace", () => {
  it("spaces actions on one origin", async () => {
    let now = 1_000;
    const p = policy({ minActionIntervalMs: 40, now: () => now });
    await p.pace("https://a.test", false);
    const start = Date.now();
    now += 10;
    await p.pace("https://a.test", false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it("refuses a navigation burst instead of hiding it", async () => {
    const p = policy({ maxNavigationsPerMinute: 2 });
    await p.pace("https://a.test", true);
    await p.pace("https://a.test", true);
    await expect(p.pace("https://a.test", true)).rejects.toThrow(/navigations/);
    // Another origin has its own budget.
    await expect(p.pace("https://b.test", true)).resolves.toBeUndefined();
  });
});
