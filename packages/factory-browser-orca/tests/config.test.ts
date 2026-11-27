import path from "node:path";
import { describe, expect, it } from "vitest";
import { MEDIA_BYTES_CEILING, readOrcaTransportConfig, resolveOrcaExecutable } from "../src/index.js";

const base = { FACTORY_ORCA_WORKTREE: "path:/factory", FACTORY_DEV_ENV_DIR: "/tmp/factory-env" };

describe("readOrcaTransportConfig", () => {
  it("needs one named workspace", () => {
    expect(() => readOrcaTransportConfig({})).toThrow(/FACTORY_ORCA_WORKTREE/);
    for (const wide of ["all", "active", "current"]) {
      expect(() => readOrcaTransportConfig({ ...base, FACTORY_ORCA_WORKTREE: wide })).toThrow(/one workspace/);
    }
  });

  it("keeps the work directory inside the factory environment", () => {
    expect(readOrcaTransportConfig(base).workDir).toBe(path.join("/tmp/factory-env", "factory-browser-orca"));
    expect(() => readOrcaTransportConfig({ ...base, FACTORY_ORCA_WORK_DIR: "/Users/someone/Desktop" })).toThrow(
      /must be inside/
    );
    expect(() => readOrcaTransportConfig({ ...base, FACTORY_ORCA_WORK_DIR: "/tmp/factory-env/../escape" })).toThrow(
      /must be inside/
    );
  });

  it("caps media size at the hard ceiling", () => {
    expect(readOrcaTransportConfig(base).maxMediaBytes).toBe(64 * 1024 * 1024);
    expect(() => readOrcaTransportConfig({ ...base, FACTORY_ORCA_MAX_MEDIA_BYTES: String(MEDIA_BYTES_CEILING + 1) })).toThrow(
      /FACTORY_ORCA_MAX_MEDIA_BYTES/
    );
    expect(() => readOrcaTransportConfig({ ...base, FACTORY_ORCA_COMMAND_TIMEOUT_MS: "abc" })).toThrow(/integer/);
  });

  it("parses the authorized tabs and origins", () => {
    const config = readOrcaTransportConfig({
      ...base,
      FACTORY_ORCA_AUTHORIZED_PAGES: " a , b ,",
      FACTORY_ORCA_ALLOWED_ORIGINS: "https://x.test"
    });
    expect(config.authorizedPageIds).toEqual(["a", "b"]);
    expect(config.allowedOrigins).toEqual(["https://x.test"]);
  });
});

describe("resolveOrcaExecutable", () => {
  it("prefers the explicit setting, then the session CLI", () => {
    expect(resolveOrcaExecutable({ FACTORY_ORCA_CLI: "/x/orca", ORCA_CLI_COMMAND: "/y/orca" })).toBe("/x/orca");
    expect(resolveOrcaExecutable({ ORCA_CLI_COMMAND: "/y/orca" })).toBe("/y/orca");
    expect(resolveOrcaExecutable({})).toBe(process.platform === "linux" ? "orca-ide" : "orca");
  });
});
