#!/bin/bash
set -euo pipefail

# openclaw-tunnel runner installer
# Generates a macOS LaunchAgent for the runner process

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.openclaw-tunnel.runner"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_PATH="/tmp/openclaw-tunnel-runner.log"

# Load .env from parent directory if exists
ENV_FILE="${SCRIPT_DIR}/../.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

# Resolve config
WORKER_URL="${WORKER_URL:-http://localhost:3456}"
WORKER_TOKEN="${WORKER_TOKEN:-}"
CLAUDE_PATH="${CLAUDE_PATH:-claude}"
CODEX_PATH="${CODEX_PATH:-codex}"
GEMINI_PATH="${GEMINI_PATH:-gemini}"
CC_TIMEOUT="${CC_TIMEOUT:-1200000}"
NODE_PATH="$(which node 2>/dev/null || echo "/usr/local/bin/node")"

if [[ -z "$WORKER_TOKEN" ]]; then
  echo "❌ WORKER_TOKEN not set. Run setup.sh first or set it in .env"
  exit 1
fi

# Detect platform
if [[ "$(uname)" != "Darwin" ]]; then
  echo "⚠️  LaunchAgent is macOS only. On Linux, run manually:"
  echo ""
  echo "  cd ${SCRIPT_DIR}"
  echo "  WORKER_URL=${WORKER_URL} WORKER_TOKEN=\$WORKER_TOKEN node worker.js"
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
    <string>${SCRIPT_DIR}/worker.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WORKER_URL</key>
    <string>${WORKER_URL}</string>
    <key>WORKER_TOKEN</key>
    <string>${WORKER_TOKEN}</string>
    <key>CLAUDE_PATH</key>
    <string>${CLAUDE_PATH}</string>
    <key>CODEX_PATH</key>
    <string>${CODEX_PATH}</string>
    <key>GEMINI_PATH</key>
    <string>${GEMINI_PATH}</string>
    <key>CC_TIMEOUT</key>
    <string>${CC_TIMEOUT}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${SCRIPT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
PLIST

echo "✅ LaunchAgent written to ${PLIST_PATH}"
echo ""
echo "To start:"
echo "  launchctl load ${PLIST_PATH}"
echo ""
echo "To stop:"
echo "  launchctl unload ${PLIST_PATH}"
echo ""
echo "Logs: ${LOG_PATH}"
