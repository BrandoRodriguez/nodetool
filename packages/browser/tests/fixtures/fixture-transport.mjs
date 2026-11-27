// A transport module as NODETOOL_BROWSER_TRANSPORT_MODULES would load it.
export const browserTransport = {
  id: "fixture",
  describe: () => "fixture transport",
  open: async () => {
    throw new Error("not opened in tests");
  }
};
