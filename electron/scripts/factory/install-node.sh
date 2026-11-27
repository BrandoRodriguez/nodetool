#!/bin/bash
# AI Content Factory: install the Node version from .nvmrc (darwin-arm64) into
# the dev environment, verified against the release's SHASUMS256.txt. It does
# not touch Homebrew, nvm or any global Node.
set -euo pipefail

# shellcheck source=dev-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/dev-env.sh"

if [[ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]]; then
  echo "ERROR: expected macOS on Apple Silicon, found $(uname -s)-$(uname -m)." >&2
  exit 1
fi

if [[ -x "${FACTORY_NODE_DIR}/bin/node" ]]; then
  echo "Node ${FACTORY_NODE_VERSION} already installed at ${FACTORY_NODE_DIR}"
  exit 0
fi

archive="node-v${FACTORY_NODE_VERSION}-darwin-arm64.tar.xz"
downloads="${FACTORY_DEV_ENV_DIR}/downloads"
mkdir -p "${downloads}" "${FACTORY_DEV_ENV_DIR}/toolchain"
cd "${downloads}"
curl -fsSLO "https://nodejs.org/dist/v${FACTORY_NODE_VERSION}/${archive}"
curl -fsSLO "https://nodejs.org/dist/v${FACTORY_NODE_VERSION}/SHASUMS256.txt"
grep " ${archive}\$" SHASUMS256.txt | shasum -a 256 -c -
tar -xJf "${archive}" -C "${FACTORY_DEV_ENV_DIR}/toolchain"
"${FACTORY_NODE_DIR}/bin/node" -p '"Installed Node " + process.version + " " + process.arch'
