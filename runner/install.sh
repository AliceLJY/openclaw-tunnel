#!/bin/bash
set -euo pipefail
umask 077

# openclaw-tunnel runner installer
# Generates a macOS LaunchAgent for the runner process

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.openclaw-tunnel.runner"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_PATH="/tmp/openclaw-tunnel-runner.log"

# Keep credentials in the ignored private env file. The LaunchAgent receives only
# its path; bearer and callback tokens are not copied into the plist.
ENV_FILE="${OPENCLAW_TUNNEL_ENV_FILE:-${SCRIPT_DIR}/../.runtime/runner.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ Private runtime config not found: ${ENV_FILE}"
  echo "   Run setup.sh first or create it from runner/runtime-config.example."
  exit 1
fi
chmod 600 "$ENV_FILE"

NODE_PATH="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_PATH" ]]; then
  echo "❌ Node.js not found in PATH."
  exit 1
fi

if ! "$NODE_PATH" --env-file="$ENV_FILE" -e 'process.exit(process.env.WORKER_TOKEN ? 0 : 1)'; then
  echo "❌ WORKER_TOKEN is empty in ${ENV_FILE}. Run setup.sh again."
  exit 1
fi

# Detect platform
if [[ "$(uname)" != "Darwin" ]]; then
  echo "⚠️  LaunchAgent is macOS only. On Linux, run manually:"
  echo ""
  echo "  cd ${SCRIPT_DIR}"
  echo "  node --env-file=${ENV_FILE} worker.js"
  echo ""
  echo "Or create a systemd unit — see README for an example."
  exit 0
fi

# Generate plist
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>--env-file=${ENV_FILE}</string>
    <string>${SCRIPT_DIR}/worker.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${SCRIPT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
PLIST
chmod 600 "$PLIST_PATH"

echo "✅ LaunchAgent written to ${PLIST_PATH}"
echo "   Credentials remain in ${ENV_FILE}; the plist stores only that file path."
echo ""
echo "To start:"
echo "  launchctl load ${PLIST_PATH}"
echo ""
echo "To stop:"
echo "  launchctl unload ${PLIST_PATH}"
echo ""
echo "Logs: ${LOG_PATH}"
