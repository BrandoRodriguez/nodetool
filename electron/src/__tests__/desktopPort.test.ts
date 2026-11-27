import { getDesktopBasePort } from "../desktopPort";

describe("getDesktopBasePort", () => {
  it("defaults to 7777", () => {
    expect(getDesktopBasePort({})).toBe(7777);
  });

  it("reads NODETOOL_DESKTOP_PORT", () => {
    expect(getDesktopBasePort({ NODETOOL_DESKTOP_PORT: "7778" })).toBe(7778);
  });

  it.each(["abc", "0", "65536", "7778.5", "-1"])("rejects %s", (value) => {
    expect(() => getDesktopBasePort({ NODETOOL_DESKTOP_PORT: value })).toThrow(
      "NODETOOL_DESKTOP_PORT must be a TCP port"
    );
  });
});

describe("serverState initial port", () => {
  const previous = process.env.NODETOOL_DESKTOP_PORT;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.NODETOOL_DESKTOP_PORT;
    } else {
      process.env.NODETOOL_DESKTOP_PORT = previous;
    }
  });

  it("starts on the configured port, so no probe reaches another app's 7777", async () => {
    process.env.NODETOOL_DESKTOP_PORT = "7778";
    await jest.isolateModulesAsync(async () => {
      const { serverState } = await import("../state");
      expect(serverState.serverPort).toBe(7778);
      expect(serverState.initialURL).toBe("http://127.0.0.1:7778");
    });
  });
});
