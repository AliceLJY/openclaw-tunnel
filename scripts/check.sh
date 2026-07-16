#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

bash -n setup.sh
bash -n runner/install.sh
node --check scripts/write-runtime-config.mjs
node --check runner/worker.js
node --check task-api/server.js
