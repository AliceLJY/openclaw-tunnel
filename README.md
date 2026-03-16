# openclaw-tunnel

Run Claude Code from your chat app, even when OpenClaw lives in Docker and your CLI lives on the host.

---

## Why not acpx?

[acpx](https://docs.openclaw.io/plugins/acpx) is the standard OpenClaw plugin for calling Claude Code. It works by spawning the CLI as a child process — which requires the CLI and OpenClaw to be on the same machine with access to the same filesystem.

When OpenClaw runs in Docker, that assumption breaks. A container cannot stdio-spawn a process on the host. openclaw-tunnel solves this with a lightweight task queue: the plugin (inside Docker) enqueues tasks over HTTP, and a runner on the host picks them up and executes Claude Code for real.

---

## Architecture

```
┌─────────────────────────────────┐
│  Docker                         │
│  ┌───────────┐  ┌────────────┐  │
│  │ OpenClaw  │  │  task-api  │  │
│  │  + plugin │──│  :3456     │  │
│  └───────────┘  └─────┬──────┘  │
└───────────────────────┼─────────┘
                        │ long-poll
┌───────────────────────┼─────────┐
│  Host                 │         │
│              ┌────────┴───────┐ │
│              │  runner        │ │
│              │  → Claude Code │ │
│              └────────────────┘ │
└─────────────────────────────────┘
```

The plugin submits tasks to `task-api` (running in Docker alongside OpenClaw). The runner on the host long-polls for pending tasks, executes Claude Code CLI, and posts results back directly to your chat channel via bot callback.

---

## Features

**Session continuity** — each chat channel maintains its own Claude Code session. `/cc` automatically continues the previous conversation. `/cc-new`, `/cc-resume`, and `/cc-recent` give you full session control.

**Zero-token relay** — the tunnel is a protocol layer only. No LLM calls happen in the plugin or the runner. The only tokens consumed are Claude Code's own.

**Platform agnostic** — works with Discord, Telegram, or any platform that OpenClaw supports. The callback mechanism uses a standard bot token.

**One-command setup** — `./setup.sh` walks you through configuration, writes `.env`, updates the plugin manifest, and optionally installs a macOS LaunchAgent for the runner.

---

## Quick Start

```bash
git clone https://github.com/AliceLJY/openclaw-tunnel.git
cd openclaw-tunnel
./setup.sh
docker-compose up -d
# Try /cc hello in your chat
```

`setup.sh` will:
1. Check prerequisites (Docker, Node.js, Claude Code CLI)
2. Prompt for port, bot token, and callback channel
3. Generate a `WORKER_TOKEN` and write `.env`
4. Update `plugin/openclaw.plugin.json` with your values
5. Offer to install the macOS LaunchAgent for the runner

After setup, copy the `plugin/` directory into your OpenClaw plugins folder (or reference it in your `openclaw.json` plugins config).

---

## Components

**`task-api/`** — Express HTTP server that runs in Docker. Accepts tasks from the plugin, stores them in SQLite, and serves them to the runner over long-polling. Posts results back to your chat via bot callback.

**`runner/`** — Node.js worker that runs on the host. Long-polls `task-api` for pending tasks, spawns Claude Code CLI as a child process, and reports results back. Supports up to 5 concurrent tasks.

**`plugin/`** — OpenClaw plugin (TypeScript). Registers the `/cc` command family, manages per-channel session bindings in a local SQLite store, and submits tasks to `task-api`.

---

## Session Commands

| Command | Description |
|---|---|
| `/cc <prompt>` | Submit a task, continuing the current session for this channel |
| `/cc-new` | Start a fresh session |
| `/cc-new <prompt>` | Start a fresh session and submit a task immediately |
| `/cc-recent` | List recent sessions for this channel |
| `/cc-resume <id> <prompt>` | Resume a specific session by ID |
| `/cc-now` | Show the active session ID for this channel |
| `/cli-state` | Check runner connectivity and task-api health |

---

## Configuration

Copy `.env.example` to `.env` (or let `setup.sh` generate it). Key variables:

| Variable | Where used | Description |
|---|---|---|
| `WORKER_TOKEN` | task-api + runner | Shared secret for API authentication (min 16 chars) |
| `PORT` | task-api | Port task-api listens on (default: `3456`) |
| `CALLBACK_BOT_TOKEN` | task-api | Bot token used to post results back to your chat |
| `CALLBACK_API_BASE_URL` | task-api | Bot API base URL (default: Discord `https://discord.com/api/v10`) |
| `WORKER_URL` | runner | URL the runner uses to reach task-api (default: `http://localhost:3456`) |
| `CLAUDE_PATH` | runner | Path to `claude` binary (default: `claude`) |
| `CC_TIMEOUT` | runner | Max execution time per task in ms (default: `1200000` = 20 min) |
| `MAX_CONCURRENT` | runner | Max parallel Claude Code processes (default: `5`) |

The plugin reads `apiUrl`, `apiToken`, and `callbackChannel` from `plugin/openclaw.plugin.json` — `setup.sh` populates these automatically.

---

## Runner on Linux

`setup.sh` installs a macOS LaunchAgent automatically. On Linux, run the runner manually:

```bash
cd runner
WORKER_URL=http://localhost:3456 WORKER_TOKEN=your-token node worker.js
```

For persistent operation, register it as a systemd service pointing to the same command.

---

## Prerequisites

- Node.js >= 22.5 (required for `node:sqlite` built-in)
- Docker (with Docker Compose)
- Claude Code CLI installed and authenticated on the host
- OpenClaw instance (self-hosted or subscribed)

---

## Why Long-Polling?

The runner sits on the host behind NAT — `task-api` inside Docker cannot push to it. Rather than requiring the runner to expose a port or set up a reverse tunnel, the runner holds an open HTTP connection to `task-api` waiting for work. When a task arrives, `task-api` responds immediately and the runner begins execution. This keeps the setup simple: no inbound firewall rules, no WebSocket server to maintain, and the runner works identically on macOS, Linux, or a remote machine pointing at the same `WORKER_URL`.

---

## Author

Built by [AliceLJY](https://github.com/AliceLJY) — a non-programmer who builds AI agent infrastructure with Claude Code. Writes about the journey at WeChat public account "我的AI小木屋" (My AI Cabin).

This project grew out of real-world pain: running five OpenClaw bots in Docker while needing Claude Code, Codex, and Gemini on the host. The original multi-runner setup lives in [openclaw-worker](https://github.com/AliceLJY/openclaw-worker) and [openclaw-cli-bridge](https://github.com/AliceLJY/openclaw-cli-bridge).

## License

MIT
