const DEFAULT_DESKTOP_PORT = 7777;

/**
 * The port the desktop app gives its backend, and the port it probes for an
 * existing NodeTool server. `NODETOOL_DESKTOP_PORT` moves it, so a development
 * build can run beside an installed app that owns 7777. Point Vite at the same
 * port with `PROXY_API_TARGET`.
 */
export function getDesktopBasePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NODETOOL_DESKTOP_PORT;
  if (!raw) {
    return DEFAULT_DESKTOP_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`NODETOOL_DESKTOP_PORT must be a TCP port, got "${raw}"`);
  }
  return port;
}
