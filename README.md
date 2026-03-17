<div align="center">

# openclaw-tunnel

**Bridge Docker OpenClaw to Host CLIs**

*Run Claude Code, Codex, and Gemini from your chat app — even when OpenClaw is in Docker and your CLIs are on the host.*

An HTTP task-queue bridge that lets OpenClaw (inside Docker) dispatch tasks to Claude Code, Codex, and Gemini CLI on the host, with per-channel session continuity and zero-token relay.

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥22.5-339933?logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)](https://docs.docker.com/compose/)

**English** | [简体中文](README_CN.md)

</div>

---

## acpx vs tunnel

[acpx](https://github.com/openclaw/acpx) is the official OpenClaw CLI client built on the [Agent Client Protocol](https://agentclientprotocol.com/) (ACP). It spawns the CLI as a local child process over stdio. If OpenClaw and Claude Code are on the same machine, acpx is the right choice.

**The problem:** when OpenClaw runs in Docker, acpx cannot reach a CLI on the host. ACP is a stdio protocol with no network transport. Remote ACP is still "work in progress" in the spec.

**What tunnel does:** instead of waiting for remote ACP, tunnel bridges the gap with an HTTP task queue. The plugin (inside Docker) enqueues tasks to `task-api`. A runner on the host long-polls for tasks, spawns the CLI, and posts results back to your chat channel via callback.

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

The plugin submits tasks to `task-api` (Docker). The runner on the host long-polls for pending tasks, spawns the requested CLI, and posts results back to your chat channel via bot callback.

---

## Features

| Feature | Description |
|---------|-------------|
| **Three CLIs** | `/cc` for Claude Code, `/codex` for Codex, `/gemini` for Gemini |
| **Session continuity** | Per-channel sessions with auto-resume. Bindings persisted in SQLite |
| **Zero-token relay** | Protocol layer only — no LLM calls in the plugin or runner |
| **Platform agnostic** | Discord, Telegram, or any platform OpenClaw supports |
| **One-command setup** | `setup.sh` generates `.env`, updates plugin config, installs LaunchAgent |
| **Concurrent execution** | Up to 5 parallel tasks with automatic model fallback |

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
3. Generate `WORKER_TOKEN` and write `.env`
4. Update `plugin/openclaw.plugin.json` with your values
5. Offer to install the macOS LaunchAgent for the runner

After setup, copy `plugin/` into your OpenClaw plugins folder (or reference it in `openclaw.json`).

---

## Components

**`task-api/`** — Express HTTP server in Docker. Accepts tasks from the plugin, stores them in SQLite, serves them to the runner via long-polling, and posts results back to your chat via bot callback. Default port 3456.

**`runner/`** — Node.js worker on the host. Long-polls `task-api`, spawns Claude Code / Codex / Gemini CLI as child processes (up to 5 concurrent), and reports results back. Prefers `claude-opus-4-6`, auto-fallback to `claude-sonnet-4-6`.

**`plugin/`** — OpenClaw plugin (TypeScript). Registers `/cc`, `/codex`, `/gemini` command families, manages per-channel session bindings in SQLite, and submits tasks to `task-api`.

---

## Session Commands

| Claude Code | Codex | Gemini | Description |
|---|---|---|---|
| `/cc <prompt>` | `/codex <prompt>` | `/gemini <prompt>` | Submit task, continue session |
| `/cc-new` | `/codex-new` | `/gemini-new` | Start fresh session |
| `/cc-recent` | — | — | List recent sessions |
| `/cc-resume <id>` | `/codex-resume <id>` | `/gemini-resume <id>` | Resume specific session |
| `/cc-now` | `/codex-now` | `/gemini-now` | Show active session ID |
| `/cli-state` | `/cli-state` | `/cli-state` | Check connectivity |

---

<details>
<summary><strong>Configuration</strong></summary>

Copy `.env.example` to `.env` (or let `setup.sh` generate it):

| Variable | Where used | Description |
|---|---|---|
| `WORKER_TOKEN` | task-api + runner | Shared secret for API auth (min 16 chars) |
| `PORT` | task-api | Port task-api listens on (default: `3456`) |
| `CALLBACK_BOT_TOKEN` | task-api | Bot token for posting results back |
| `CALLBACK_API_BASE_URL` | task-api | Bot API base URL (default: Discord) |
| `WORKER_URL` | runner | URL to reach task-api (default: `http://localhost:3456`) |
| `CLAUDE_PATH` | runner | Path to `claude` binary (default: `claude`) |
| `CC_TIMEOUT` | runner | Max execution time per task in ms (default: `1200000`) |
| `MAX_CONCURRENT` | runner | Max parallel tasks (default: `5`) |
| `POLL_INTERVAL` | runner | Polling interval when at capacity (default: `500` ms) |
| `LONG_POLL_WAIT` | runner | Long-poll wait window (default: `30000` ms) |
| `DISCORD_PROXY` | runner | HTTPS proxy for users behind firewalls |

The plugin reads `apiUrl`, `apiToken`, and `callbackChannel` from `plugin/openclaw.plugin.json` — `setup.sh` populates these automatically.

</details>

<details>
<summary><strong>Runner on Linux</strong></summary>

`setup.sh` installs a macOS LaunchAgent automatically. On Linux, run the runner manually:

```bash
cd runner
WORKER_URL=http://localhost:3456 WORKER_TOKEN=your-token node worker.js
```

Or register as a systemd service:

```ini
[Unit]
Description=openclaw-tunnel runner
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/runner/worker.js
Environment=WORKER_URL=http://localhost:3456
Environment=WORKER_TOKEN=your-token
Restart=always

[Install]
WantedBy=multi-user.target
```

</details>

<details>
<summary><strong>Why long-polling?</strong></summary>

The runner sits on the host behind NAT — `task-api` inside Docker cannot push to it. Rather than requiring the runner to expose a port or set up a reverse tunnel, the runner holds an open HTTP connection to `task-api` waiting for work. When a task arrives, `task-api` responds immediately. No inbound firewall rules, no WebSocket server, and the runner works identically on macOS, Linux, or a remote machine.

</details>

<details>
<summary><strong>Prerequisites</strong></summary>

- Docker (with Docker Compose)
- Node.js >= 22.5 (required for `node:sqlite` built-in)
- Claude Code CLI installed and authenticated on the host
- OpenClaw instance (Docker deployment)

</details>

---

## Author

Built by [AliceLJY](https://github.com/AliceLJY) — a non-programmer who builds AI agent infrastructure with Claude Code. Writes about the journey at WeChat public account "我的AI小木屋" (My AI Cabin).

This project grew out of real-world pain: running five OpenClaw bots in Docker while needing Claude Code, Codex, and Gemini on the host.

## License

MIT
