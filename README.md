# openclaw-tunnel

Run Claude Code, Codex, and Gemini from your chat app, even when OpenClaw lives in Docker and your CLIs live on the host.

---

## acpx vs tunnel

[acpx](https://github.com/openclaw/acpx) is the official OpenClaw CLI client built on the [Agent Client Protocol](https://agentclientprotocol.com/) (ACP) — a standard co-developed by Zed and JetBrains for connecting editors and orchestrators to AI coding agents. acpx works by spawning the CLI as a local child process over stdio. If OpenClaw and Claude Code are on the same machine, acpx is the right choice: fast, zero-overhead, protocol-native.

**The problem:** when OpenClaw runs in Docker, acpx cannot reach a CLI on the host. ACP is a stdio protocol — there is no network transport. The `--agent` flag only accepts local executable paths, not URLs. Remote ACP is still listed as "work in progress" in the protocol spec.

**What tunnel does:** instead of waiting for remote ACP support, tunnel bridges the gap with a task queue. The plugin (inside Docker) enqueues tasks over HTTP to a `task-api` service. A runner on the host long-polls for tasks, spawns Claude Code, and posts results back to your chat channel via callback. No stdio required across the container boundary.

| | acpx | tunnel |
|---|---|---|
| Protocol | ACP (JSON-RPC over stdio) | HTTP task queue + callback |
| Requires same machine | Yes | No — Docker + host |
| Session model | By git directory | By chat channel |
| Token cost | Zero (protocol layer) | Zero (protocol layer) |
| Best for | OpenClaw on host | OpenClaw in Docker |

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
│              │  → Codex       │ │
│              │  → Gemini      │ │
│              └────────────────┘ │
└─────────────────────────────────┘
```

The plugin submits tasks to `task-api` (running in Docker alongside OpenClaw). The runner on the host long-polls for pending tasks, executes the requested CLI (Claude Code, Codex, or Gemini), and posts results back directly to your chat channel via bot callback.

---

## Features

**Three CLIs** — `/cc` for Claude Code, `/codex` for Codex, `/gemini` for Gemini. Each with full session management.

**Session continuity** — each chat channel maintains its own session per CLI. `/cc` automatically continues the previous conversation. `/cc-new`, `/cc-resume`, and `/cc-recent` give you full session control. Same for `/codex-*` and `/gemini-*`.

**Zero-token relay** — the tunnel is a protocol layer only. No LLM calls happen in the plugin or the runner. The only tokens consumed are the CLIs' own.

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

**`runner/`** — Node.js worker that runs on the host. Long-polls `task-api` for pending tasks, spawns Claude Code / Codex / Gemini CLI as child processes, and reports results back. Supports up to 5 concurrent tasks.

**`plugin/`** — OpenClaw plugin (TypeScript). Registers `/cc`, `/codex`, `/gemini` command families, manages per-channel session bindings in a local SQLite store, and submits tasks to `task-api`.

---

## Session Commands

Each CLI has the same command pattern:

| Claude Code | Codex | Gemini | Description |
|---|---|---|---|
| `/cc <prompt>` | `/codex <prompt>` | `/gemini <prompt>` | Submit task, continue session |
| `/cc-new` | `/codex-new` | `/gemini-new` | Start fresh session |
| `/cc-recent` | — | — | List recent sessions |
| `/cc-resume <id>` | `/codex-resume <id>` | `/gemini-resume <id>` | Resume specific session |
| `/cc-now` | `/codex-now` | `/gemini-now` | Show active session ID |
| `/cli-state` | `/cli-state` | `/cli-state` | Check connectivity |

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
