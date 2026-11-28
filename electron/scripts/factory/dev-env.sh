#!/bin/bash
# AI Content Factory: environment for an isolated NodeTool development build.
#
# Source this file (`source electron/scripts/factory/dev-env.sh`). It puts the Node
# version from .nvmrc first on PATH and defines `factory_runtime_env`, which
# exports every variable that keeps a dev run away from an installed NodeTool:
# its port (7777), its data (~/.local/share/nodetool), its config
# (~/.config/nodetool), its Electron data
# (~/Library/Application Support/nodetool-electron) and its keychain master key.
#
# Override the defaults with FACTORY_DEV_ENV_DIR, FACTORY_API_PORT and
# FACTORY_WEB_PORT before sourcing.

if [[ -n "${ZSH_VERSION:-}" ]]; then
  eval 'factory_env_file="${(%):-%x}"'
else
  factory_env_file="${BASH_SOURCE[0]}"
fi
FACTORY_REPO_DIR="$(cd "$(dirname "${factory_env_file}")/../../.." && pwd)"
unset factory_env_file
export FACTORY_REPO_DIR
export FACTORY_DEV_ENV_DIR="${FACTORY_DEV_ENV_DIR:-$(cd "${FACTORY_REPO_DIR}/.." && pwd)/nodetool-dev-env}"
case "${FACTORY_DEV_ENV_DIR}/" in
  "${FACTORY_REPO_DIR}/"*)
    # Runtime data (database, keys, caches) must never land in the work tree.
    echo "ERROR: FACTORY_DEV_ENV_DIR (${FACTORY_DEV_ENV_DIR}) is inside the repository." >&2
    return 1 2>/dev/null || exit 1
    ;;
esac
export FACTORY_API_PORT="${FACTORY_API_PORT:-7778}"
# web/package.json pins Vite to 3000 with --strictPort.
export FACTORY_WEB_PORT="${FACTORY_WEB_PORT:-3000}"

export FACTORY_HOME="${FACTORY_DEV_ENV_DIR}/home"
export FACTORY_ELECTRON_USER_DATA="${FACTORY_DEV_ENV_DIR}/electron-user-data"
export FACTORY_LOG_DIR="${FACTORY_DEV_ENV_DIR}/logs"
export FACTORY_RUN_DIR="${FACTORY_DEV_ENV_DIR}/run"
export FACTORY_TMP_DIR="${FACTORY_DEV_ENV_DIR}/tmp"
# TMPDIR goes through this short link to FACTORY_TMP_DIR: macOS caps a unix
# socket path at 104 bytes, and the native bridge and tsx put sockets in TMPDIR.
export FACTORY_TMP_LINK="/tmp/nodetool-factory-$(id -u)"
FACTORY_MASTER_KEY_FILE="${FACTORY_DEV_ENV_DIR}/secrets/master.key"

FACTORY_NODE_VERSION="$(tr -d '[:space:]' < "${FACTORY_REPO_DIR}/.nvmrc")"
FACTORY_NODE_DIR="${FACTORY_DEV_ENV_DIR}/toolchain/node-v${FACTORY_NODE_VERSION}-darwin-arm64"
if [[ -x "${FACTORY_NODE_DIR}/bin/node" ]]; then
  export PATH="${FACTORY_NODE_DIR}/bin:${PATH}"
fi
# Keep npm's cache out of the user's global ~/.npm.
export npm_config_cache="${FACTORY_DEV_ENV_DIR}/npm-cache"

factory_check_node() {
  local found
  found="$(node -p 'process.versions.node + " " + process.arch' 2>/dev/null)"
  if [[ "${found}" != "${FACTORY_NODE_VERSION} arm64" ]]; then
    echo "ERROR: Node ${FACTORY_NODE_VERSION} arm64 required, found '${found}'." >&2
    echo "  Run electron/scripts/factory/install-node.sh" >&2
    return 1
  fi
}

# Creates the isolated directories and a master key owned by this environment.
factory_prepare_dirs() {
  mkdir -p "${FACTORY_HOME}/.config" "${FACTORY_HOME}/.local/share" "${FACTORY_HOME}/.cache" \
    "${FACTORY_ELECTRON_USER_DATA}" "${FACTORY_LOG_DIR}" "${FACTORY_RUN_DIR}" \
    "$(dirname "${FACTORY_MASTER_KEY_FILE}")"
  chmod 700 "$(dirname "${FACTORY_MASTER_KEY_FILE}")"
  if [[ ! -s "${FACTORY_MASTER_KEY_FILE}" ]]; then
    (umask 077 && node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' \
      > "${FACTORY_MASTER_KEY_FILE}")
  fi
  mkdir -p "${FACTORY_TMP_DIR}"
  chmod 700 "${FACTORY_TMP_DIR}"
  # A link of ours left pointing at a folder that moved (the project folder was
  # renamed) is repointed here. A link someone else owns is never touched.
  if [[ -L "${FACTORY_TMP_LINK}" && "$(stat -f %u "${FACTORY_TMP_LINK}")" == "$(id -u)" \
        && "$(readlink "${FACTORY_TMP_LINK}")" != "${FACTORY_TMP_DIR}" \
        && "$(readlink "${FACTORY_TMP_LINK}")" == */nodetool-dev-env/tmp \
        && ! -d "$(readlink "${FACTORY_TMP_LINK}")" ]]; then
    rm "${FACTORY_TMP_LINK}"
  fi
  if [[ ! -e "${FACTORY_TMP_LINK}" && ! -L "${FACTORY_TMP_LINK}" ]]; then
    ln -s "${FACTORY_TMP_DIR}" "${FACTORY_TMP_LINK}"
  fi
  # Trust the link only if it is ours and points at our directory: /tmp is
  # shared, and another account could have planted it first.
  if [[ ! -L "${FACTORY_TMP_LINK}" || "$(stat -f %u "${FACTORY_TMP_LINK}")" != "$(id -u)" \
        || "$(readlink "${FACTORY_TMP_LINK}")" != "${FACTORY_TMP_DIR}" ]]; then
    echo "ERROR: ${FACTORY_TMP_LINK} is not this environment's temp link. Remove it and retry." >&2
    return 1
  fi
}

# Exports the runtime isolation. Call it in the shell that starts the servers.
# The Orca workspace of this project. Inside an Orca terminal, Orca names it in
# ORCA_WORKTREE_ID (<repo-id>::<path>); that one is used when its folder is
# this project's root, even under an earlier name of the folder that now
# resolves here. Elsewhere the root folder's path selects it.
factory_orca_worktree() {
  local root id_path
  root="$(cd "$(dirname "${FACTORY_REPO_DIR}")" && pwd -P)"
  if [[ -n "${ORCA_WORKTREE_ID:-}" && "${ORCA_WORKTREE_ID}" == *::/* ]]; then
    id_path="${ORCA_WORKTREE_ID#*::}"
    if [[ -d "${id_path}" && "$(cd "${id_path}" && pwd -P)" == "${root}" ]]; then
      printf 'id:%s' "${ORCA_WORKTREE_ID}"
      return
    fi
  fi
  printf 'path:%s' "${root}"
}

factory_runtime_env() {
  # HOME moves every ~/.config/nodetool and ~/.local/share/nodetool lookup
  # (settings.yaml, packs.json, users.json, MCP config, database, assets,
  # workspaces, logs) into the dev environment.
  export FACTORY_REAL_HOME="${FACTORY_REAL_HOME:-${HOME}}"
  export HOME="${FACTORY_HOME}"
  export XDG_CONFIG_HOME="${FACTORY_HOME}/.config"
  export XDG_DATA_HOME="${FACTORY_HOME}/.local/share"
  export XDG_CACHE_HOME="${FACTORY_HOME}/.cache"
  local data_dir="${XDG_DATA_HOME}/nodetool"
  export DB_PATH="${data_dir}/nodetool.sqlite3"
  export VECTORSTORE_DB_PATH="${data_dir}/vectorstore.db"
  export ASSET_FOLDER="${data_dir}/assets"
  export NODETOOL_WORKSPACES_DIR="${data_dir}/workspaces"
  export NODETOOL_CACHE_DIR="${XDG_CACHE_HOME}/nodetool"

  # Backend port for `npm run dev:server`, the Electron launcher and Vite.
  export PORT="${FACTORY_API_PORT}"
  export NODETOOL_DESKTOP_PORT="${FACTORY_API_PORT}"
  export PROXY_API_TARGET="http://127.0.0.1:${FACTORY_API_PORT}"
  export NT_WEB_DEV_SERVER_URL="http://127.0.0.1:${FACTORY_WEB_PORT}"

  # A key of our own, so keytar never reads the installed app's
  # "nodetool/secrets_master_key" keychain entry.
  SECRETS_MASTER_KEY="$(cat "${FACTORY_MASTER_KEY_FILE}")"
  export SECRETS_MASTER_KEY

  # Temp files and sockets stay in the environment. This also keeps the
  # extension bridge apart: its sockets live in TMPDIR, so a dev backend never
  # finds the native host the installed app's Chrome extension started.
  export TMPDIR="${FACTORY_TMP_LINK}/"

  # Browser transport: `local` (headless Chrome, fresh profile) unless the
  # caller chose another. `orca` drives the Orca built-in browser in the
  # isolated "AI Content Factory" profile (packages/factory-browser-orca).
  export NODETOOL_BROWSER_TRANSPORT="${NODETOOL_BROWSER_TRANSPORT:-local}"
  export NODETOOL_BROWSER_TRANSPORT_MODULES="${NODETOOL_BROWSER_TRANSPORT_MODULES:-orca=@nodetool-ai/factory-browser-orca}"
  export FACTORY_ORCA_WORKTREE="${FACTORY_ORCA_WORKTREE:-$(factory_orca_worktree)}"
  export FACTORY_ORCA_PROFILE_LABEL="${FACTORY_ORCA_PROFILE_LABEL:-AI Content Factory}"
  # Media providers that drive a consumer website honour that site's terms:
  # where they forbid automated use (ChatGPT), the provider hands the step to
  # the user instead of sending anything. FACTORY_ORCA_PROVIDER_TABS names the
  # tab each provider may use (providerId=browserPageId).
  export NODETOOL_BROWSER_PROVIDER_POLICY="${NODETOOL_BROWSER_PROVIDER_POLICY:-terms}"
  export ELECTRON_ENABLE_LOGGING=1
}
