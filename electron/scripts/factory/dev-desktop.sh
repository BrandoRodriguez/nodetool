#!/bin/bash
# AI Content Factory: start, stop and inspect the isolated NodeTool dev build.
#
#   electron/scripts/factory/dev-desktop.sh start    # Vite + Electron (Electron starts the backend)
#   electron/scripts/factory/dev-desktop.sh web      # backend + Vite for a browser, no Electron
#   electron/scripts/factory/dev-desktop.sh server   # backend only, no window
#   electron/scripts/factory/dev-desktop.sh stop
#   electron/scripts/factory/dev-desktop.sh status
#
# Every process runs with the isolation from dev-env.sh. The script never
# stops a process it did not start: stop reads the PIDs it recorded and only
# kills those processes and their children.
set -euo pipefail

# shellcheck source=dev-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/dev-env.sh"
cd "${FACTORY_REPO_DIR}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: this launcher targets macOS (Apple Silicon)." >&2
  exit 1
fi

pid_file() { echo "${FACTORY_RUN_DIR}/$1.pid"; }

is_running() {
  local file
  file="$(pid_file "$1")"
  [[ -f "${file}" ]] && kill -0 "$(cat "${file}")" 2>/dev/null
}

port_holder() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

require_free_port() {
  local holder
  holder="$(port_holder "$1")"
  if [[ -n "${holder}" ]]; then
    echo "ERROR: port $1 ($2) is held by PID ${holder}: $(ps -p "${holder}" -o command= | cut -c1-120)" >&2
    echo "  This launcher never stops processes it did not start." >&2
    exit 1
  fi
}

wait_for_url() {
  local url="$1" label="$2" tries="${3:-240}"
  for ((i = 0; i < tries; i++)); do
    if curl -sf -o /dev/null "${url}"; then
      return 0
    fi
    sleep 0.5
  done
  echo "ERROR: ${label} did not answer at ${url}. See ${FACTORY_LOG_DIR}." >&2
  return 1
}

# Kills a process and every descendant, children first.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "${pid}" 2>/dev/null || true); do
    kill_tree "${child}"
  done
  kill "${pid}" 2>/dev/null || true
}

start_detached() {
  local name="$1"
  shift
  nohup "$@" >> "${FACTORY_LOG_DIR}/${name}.log" 2>&1 &
  echo $! > "$(pid_file "${name}")"
}

preflight() {
  factory_check_node
  factory_prepare_dirs
  if is_running web || is_running electron || is_running server; then
    echo "ERROR: the dev environment is already running. Use: $0 status" >&2
    exit 1
  fi
  require_free_port "${FACTORY_API_PORT}" "backend"
  factory_runtime_env
  echo "Building stale backend workspaces..."
  node scripts/build-stale-websocket-workspaces.mjs --electron
}

# Vite on loopback only. web/package.json binds 0.0.0.0, which would expose the
# dev UI, and through its proxy the backend, to the local network.
start_vite() {
  echo "Starting Vite on ${NT_WEB_DEV_SERVER_URL} (proxy -> ${PROXY_API_TARGET})..."
  start_detached web "${FACTORY_REPO_DIR}/node_modules/.bin/vite" web \
    --host 127.0.0.1 --port "${FACTORY_WEB_PORT}" --strictPort --clearScreen false
  wait_for_url "${NT_WEB_DEV_SERVER_URL}" "Vite"
}

start_backend() {
  echo "Starting backend on ${PROXY_API_TARGET}..."
  start_detached server node scripts/dev-server.mjs
  wait_for_url "http://127.0.0.1:${FACTORY_API_PORT}/health" "backend"
}

cmd_start() {
  preflight
  require_free_port "${FACTORY_WEB_PORT}" "Vite"

  local marker="electron/dist-electron/main.js"
  if [[ ! -f "${marker}" ]] || [[ -n "$(find electron/src electron/package.json electron/vite.config.ts \
      packages/config/dist packages/node-sdk/dist packages/runtime-install/dist \
      -newer "${marker}" -print -quit 2>/dev/null)" ]]; then
    echo "Building Electron main/preload bundle..."
    npm --prefix electron run vite:build >> "${FACTORY_LOG_DIR}/electron-build.log" 2>&1
  fi

  start_vite

  echo "Starting Electron (user data: ${FACTORY_ELECTRON_USER_DATA})..."
  NT_ELECTRON_DEV_MODE=1 NODETOOL_NODE="$(command -v node)" \
    start_detached electron npm --prefix electron run start:devmode -- \
    "--user-data-dir=${FACTORY_ELECTRON_USER_DATA}"
  wait_for_url "http://127.0.0.1:${FACTORY_API_PORT}/health" "backend"
  cmd_status
}

cmd_server() {
  preflight
  start_backend
  cmd_status
}

cmd_web() {
  preflight
  require_free_port "${FACTORY_WEB_PORT}" "Vite"
  start_backend
  start_vite
  cmd_status
  echo "Open ${NT_WEB_DEV_SERVER_URL} in the browser."
}

cmd_stop() {
  local name stopped=0
  for name in electron web server; do
    if is_running "${name}"; then
      echo "Stopping ${name} (PID $(cat "$(pid_file "${name}")"))..."
      kill_tree "$(cat "$(pid_file "${name}")")"
      stopped=1
    fi
    rm -f "$(pid_file "${name}")"
  done
  sleep 1
  local holder
  holder="$(port_holder "${FACTORY_API_PORT}")"
  if [[ -n "${holder}" ]]; then
    echo "WARNING: port ${FACTORY_API_PORT} is still held by PID ${holder}: $(ps -p "${holder}" -o command= | cut -c1-120)" >&2
  fi
  [[ "${stopped}" == 1 ]] || echo "Nothing was running."
}

cmd_status() {
  local name
  for name in web electron server; do
    if is_running "${name}"; then
      echo "${name}: running (PID $(cat "$(pid_file "${name}")"))"
    else
      echo "${name}: stopped"
    fi
  done
  if curl -sf -o /dev/null "http://127.0.0.1:${FACTORY_API_PORT}/health"; then
    echo "backend: healthy on port ${FACTORY_API_PORT}"
  else
    echo "backend: not answering on port ${FACTORY_API_PORT}"
  fi
  echo "data: ${FACTORY_HOME}/.local/share/nodetool"
  echo "logs: ${FACTORY_LOG_DIR}"
}

case "${1:-}" in
  start) cmd_start ;;
  web) cmd_web ;;
  server) cmd_server ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *)
    echo "Usage: $0 {start|web|server|stop|status}" >&2
    exit 2
    ;;
esac
