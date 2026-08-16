<div align="center">

# openclaw-tunnel

**Run AI Coding Agents from Anywhere — Docker, Cloud, or Hybrid**

*An authenticated HTTP(S) task-queue bridge that lets OpenClaw dispatch tasks to Claude Code and Codex across container boundaries, network boundaries, or both.*

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥22.5-339933?logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)](https://docs.docker.com/compose/)

**English** | [简体中文](README_CN.md)

</div>

---

> **Status: Maintenance mode.** In the author's own setup the OpenClaw plugin's slash-command path is
> retired; the live path is now containers calling `task-api` directly over a local/private network
> (see "Two Ways to Connect" below). The plugin still works and remains the recommended entry point
> for OpenClaw users.

> **On the Gemini path.** Google retired the standalone `gemini` CLI for personal
> accounts (free, AI Pro, AI Ultra) on 2026-06-18; its successor is the Antigravity
> CLI (`agy`), which this runner does not spawn. The `/gemini` command family and
> `GEMINI_PATH` are kept for Code Assist Standard/Enterprise users who still have a
> working legacy binary — on a personal account that path can no longer authenticate.
> Claude Code and Codex are unaffected.

---

## Why tunnel?

[acpx](https://github.com/openclaw/acpx) is the official OpenClaw CLI client built on the [Agent Client Protocol](https://agentclientprotocol.com/) (ACP). It spawns the CLI as a local child process over stdio. If OpenClaw and Claude Code are on the same machine, acpx is the right choice.

**The problem:** when OpenClaw runs in Docker or on a remote server, acpx cannot reach a CLI on another machine. ACP is a stdio protocol with no network transport. Remote ACP is still "work in progress" in the spec.

**What tunnel does:** instead of waiting for remote ACP, tunnel bridges the gap with an authenticated HTTP(S) task queue. The plugin (inside Docker) enqueues tasks to `task-api`. A runner on the same host or a trusted, encrypted network long-polls for tasks, spawns the CLI, and reports the result back to `task-api`, which posts it to your chat channel.

| | acpx | tunnel |
|---|---|---|
| Protocol | ACP (JSON-RPC over stdio) | Authenticated HTTP(S) task queue + server callback |
| Same machine required | Yes | No — works across networks |
| Session model | By git directory | By chat channel |
| Token cost | Zero (protocol layer) | Zero (protocol layer) |
| Best for | OpenClaw on bare metal | OpenClaw in Docker or cloud |

---

## Deployment Scenarios

tunnel supports three deployment patterns. Pick the one that fits your setup:

### Scenario A: Local Docker *(default)*

OpenClaw + task-api in Docker on your machine. Runner on the host. Everything on one box.

```
┌──────────────────────────────────────┐
│  Your Machine                        │
│                                      │
│  ┌─────────── Docker ──────────────┐ │
│  │  OpenClaw + plugin              │ │
│  │  task-api :3456                 │ │
│  └──────────────┬──────────────────┘ │
│                 │ long-poll           │
│  ┌──────────────┴──────────────────┐ │
│  │  runner                         │ │
│  │  → Claude Code / Codex / Gemini │ │
│  └─────────────────────────────────┘ │
└──────────────────────────────────────┘
```

```bash
# Runner connects to localhost (default)
WORKER_URL=http://localhost:3456
```

### Scenario B: Cloud + Local Runner *(encrypted transport required)*

task-api on a cloud VM (AWS, GCP, any VPS). Runner on your local machine — your CLIs stay local, but orchestration lives in the cloud.

```
┌───── Cloud VM ──────┐           ┌────── Your Machine ──────┐
│  Docker             │           │                           │
│   OpenClaw + plugin │ HTTPS /   │  runner                   │
│   task-api :3456    │◄──────────│  → Claude Code            │
│                     │ VPN / SSH │  → Codex                  │
└─────────────────────┘           │  → Gemini                 │
                                  └───────────────────────────┘
```

```bash
# Option 1: TLS reverse proxy in front of task-api
WORKER_URL=https://task-api.example.com

# Option 2: SSH tunnel; task-api stays bound to loopback on the VM
ssh -N -L 3456:127.0.0.1:3456 user@task-api-host
WORKER_URL=http://127.0.0.1:3456
```

Tailscale or another VPN is also suitable when `task-api` is bound only to the VPN interface. Never send the bearer token, prompts, or results over plaintext public HTTP.

### Scenario C: Fully Remote

Everything on managed cloud infrastructure. Keep `task-api` on loopback or a private network. This can support organizational deployment controls, but hosting location alone does not establish compliance.

```
┌────────────────── Cloud VM ──────────────────┐
│                                              │
│  ┌─────────── Docker ──────────────┐         │
│  │  OpenClaw + plugin              │         │
│  │  task-api :3456                 │         │
│  └──────────────┬──────────────────┘         │
│                 │ long-poll (localhost)       │
│  ┌──────────────┴──────────────────┐         │
│  │  runner                         │         │
│  │  → Claude Code / Codex / Gemini │         │
│  └─────────────────────────────────┘         │
└──────────────────────────────────────────────┘
```

```bash
# Runner and task-api on the same VM
WORKER_URL=http://localhost:3456
# Install CLIs on the VM, run the runner as a systemd service
```

---

## Features

| Feature | Description |
|---------|-------------|
| **Multiple CLIs** | `/cc` for Claude Code, `/codex` for Codex. A `/gemini` family also ships, but see the Gemini note above |
| **Session continuity** | Per-channel sessions with auto-resume. Bindings persisted in SQLite |
| **Zero-token relay** | Protocol layer only — no LLM calls in the plugin or runner |
| **Platform agnostic** | Discord, Telegram, or any platform OpenClaw supports |
| **Guided setup** | `setup.sh` writes ignored private runtime config and can install a LaunchAgent; plugin copy/config merge remains manual |
| **Concurrent execution** | Up to 5 parallel tasks with configurable Claude model fallback |
| **SDK + CLI modes** | Agent SDK (streaming) with automatic fallback to CLI |
| **Remote-capable** | Local Docker, cloud VM, or hybrid when protected by HTTPS, VPN, or SSH tunneling |

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
3. Generate a 256-bit `WORKER_TOKEN` without displaying it and write the task-api `.env` plus scoped `.runtime/runner.env`, both ignored and mode `0600`
4. Write an ignored private OpenClaw config snippet to `.runtime/openclaw-plugin-config.json` with mode `0600`; the callback bot token stays only in task-api `.env`
5. Detect the local Claude/Codex session directories and mount them read-only into task-api for recent-session commands
6. Offer to install the macOS LaunchAgent for the runner

After setup, copy `plugin/` into your OpenClaw plugins folder (or reference it in `openclaw.json`), then merge `.runtime/openclaw-plugin-config.json` into your existing private OpenClaw config. The tracked `plugin/openclaw.plugin.json` remains a schema-only manifest and never receives credentials.

---

## Components

**`task-api/`** — Express HTTP server in Docker. Accepts tasks from the plugin, stores them in SQLite, serves them to the runner via long-polling, receives completed results, and posts results back to your chat via bot callback. Default port 3456.

**`runner/`** — Node.js worker on the host (or any machine). Long-polls `task-api`, spawns Claude Code / Codex / Gemini CLI as child processes (up to 5 concurrent), and reports execution results back to `task-api`. Prefers Agent SDK with streaming, auto-fallback to CLI mode.

**`plugin/`** — OpenClaw plugin (TypeScript). Registers `/cc`, `/codex`, `/gemini` command families, manages per-channel session bindings in SQLite, and submits tasks to `task-api`.

If task-api restarts while a runner owns a task, the existing `running` claim is preserved. The server never requeues it automatically because the command may already have produced side effects. A surviving runner can still report the result; otherwise inspect the effects before submitting a replacement task.

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

## Two Ways to Connect

`task-api` exposes an authenticated HTTP API. Local loopback/private-Docker HTTP is supported; any remote path must use HTTPS, a VPN, or an SSH tunnel. There are two ways to drive it:

**1. OpenClaw plugin (slash commands)** — install `plugin/` into an OpenClaw instance and trigger `/cc`, `/codex`, `/gemini` from chat (see the table above). Best for OpenClaw users.

**2. Direct API** — any trusted client (a script, a bot, another agent) can `POST /claude` directly, no plugin required. This remote example assumes a TLS reverse proxy:

```bash
curl -X POST https://task-api.example.com/claude \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "what you want CC to do", "timeout": 600000, "callbackChannel": "<optional channel id>"}'
```

Response: `{ "taskId": "...", "sessionId": "..." }`. With `callbackChannel` the result is pushed back asynchronously; without it, poll `GET /tasks/<taskId>?wait=<ms>` for the result. `/codex` and `/gemini` work the same way.

---

## Security and Trust Boundary

This project is a **trusted remote-execution bridge, not a sandbox**. Treat possession of `WORKER_TOKEN` as near-user-level access to the runner host:

- An authenticated caller can enqueue shell commands, read/write/edit files within the runner's broad allowed roots, and invoke Claude Code, Codex, or Gemini.
- The command prefix filter rejects some unsupported or obviously hazardous strings, but accepted commands still run through the host shell (`SHELL` on Unix, `ComSpec` on Windows) with the runner user's permissions. Prefix matching is not shell parsing, isolation, or hostile-user authorization.
- The CLI paths intentionally use broad automation modes. A successful prompt injection or stolen bearer token can therefore have a blast radius close to the runner's user account.
- The runner removes bridge-control secrets (`WORKER_TOKEN`, callback bot tokens, and hook tokens) from shell-command and AI-CLI child environments. This reduces accidental credential exposure; it does not make those child processes sandboxed.

Transport and deployment rules:

- Use plaintext HTTP only on loopback or an explicitly private Docker network.
- For another host, use an HTTPS reverse proxy, a VPN/Tailscale connection bound to the private interface, or an SSH tunnel. `WORKER_TOKEN` authenticates requests; it does not encrypt prompts, results, or credentials.
- Compose publishes `task-api` on `127.0.0.1` by default. For VPN access, set `TASK_API_BIND` to the specific VPN interface address—do not publish the port on a public wildcard address.
- Keep `.env`, `.runtime/runner.env`, `.runtime/openclaw-plugin-config.json`, the OpenClaw config, task databases, and runner logs private. Rotate the worker token if either runner/plugin config is exposed; rotate the callback token if task-api `.env` is exposed.
- A cloud or container deployment is not automatically compliant; evaluate identity, transport encryption, host hardening, retention, and provider data handling for your own requirements.

---

<details>
<summary><strong>Configuration</strong></summary>

Prefer `setup.sh`, which creates separate task-api and runner files so the callback bot token is not inherited by runner child processes. For manual setup, `.env.example` documents all variables and `runner/runtime-config.example` is the scoped runner template.

| Variable | Where used | Description |
|---|---|---|
| `WORKER_TOKEN` | task-api + runner | Shared secret for API auth (min 16 chars; setup generates 256 random bits) |
| `PORT` | task-api | Port task-api listens on (default: `3456`) |
| `TASK_API_BIND` | Docker Compose | Host interface for the published port (default: `127.0.0.1`; use a specific VPN address for VPN access) |
| `CALLBACK_BOT_TOKEN` | task-api | Bot token for posting results back |
| `CALLBACK_API_BASE_URL` | task-api | Bot API base URL (default: Discord) |
| `CALLBACK_CHANNEL` | task-api | Optional fallback channel/thread ID when a task has no callback channel |
| `CLAUDE_PROJECTS_DIR` | Compose + runner | Host Claude projects/session directory. Setup detects `~/.claude/projects`; Compose mounts it read-only |
| `CODEX_SESSIONS_DIR` | Compose + runner | Host Codex session directory. Setup detects `~/.codex/sessions`; Compose mounts it read-only |
| `WORKER_URL` | runner | URL to reach task-api (default: `http://localhost:3456`) |
| `CLAUDE_PATH` | runner | Path to `claude` binary (default: `claude`) |
| `CODEX_PATH` | runner | Path to `codex` binary (default: `codex`) |
| `GEMINI_PATH` | runner | Path to `gemini` binary (default: `gemini`). Legacy — see the Gemini note above |
| `CC_TIMEOUT` | runner | Fallback per-task execution cap when a task omits its own timeout, in ms (default: `1200000`) |
| `CC_MODELS` | runner | Optional comma-separated Claude model list. Empty means use Claude Code's default model |
| `RUNNER_SESSION_CACHE_FILE` | runner | Optional session cache path. Empty uses the OS temp directory |
| `CC_LOG_PATH` | runner | Optional Claude live log path. Empty uses the OS temp directory |
| `MAX_CONCURRENT` | runner | Max parallel tasks (default: `5`) |
| `POLL_INTERVAL` | runner | Polling interval when at capacity (default: `500` ms) |
| `LONG_POLL_WAIT` | runner | Long-poll wait window (default: `30000` ms) |
| `WORKER_DIRECT_CALLBACK` | runner | Legacy opt-in for runner-side callback delivery. Keep `false` for Windows/cloud setups |
| `WORKER_SHELL` | runner | Optional shell override. Defaults to `SHELL`/a standard Unix shell or `ComSpec` on Windows |
| `DISCORD_PROXY` | runner | HTTPS proxy for legacy runner-side callback delivery (optional) |

The tracked `plugin/openclaw.plugin.json` defines only the plugin schema. Runtime values belong under `plugins.entries.cli-bridge.config` in your private OpenClaw config. `setup.sh` generates the correctly shaped, ignored snippet at `.runtime/openclaw-plugin-config.json` with the worker API token and callback channel. The optional `callbackBotToken` schema remains available for legacy/manual deployments, but setup deliberately keeps that token in task-api `.env` and does not copy it to the plugin or runner.

</details>

<details>
<summary><strong>Runner on Linux / Cloud</strong></summary>

`setup.sh` offers to install a macOS LaunchAgent. On Linux or cloud VMs, run the runner manually:

```bash
cd runner
node --env-file=../.runtime/runner.env worker.js
```

On Windows, run:

```bat
cd runner
node --env-file=..\.runtime\runner.env worker.js
```

The runner uses `%TEMP%` for the session cache and live log by default on Windows. Commands use `ComSpec` (normally `cmd.exe`); `WORKER_SHELL` may select a cmd-compatible shell or PowerShell. Leave `WORKER_DIRECT_CALLBACK=false` so Windows only reports results to `task-api`; the server sends the chat callback.

Or register as a systemd service for always-on operation:

```ini
[Unit]
Description=openclaw-tunnel runner
After=network.target

[Service]
EnvironmentFile=/path/to/openclaw-tunnel/.runtime/runner.env
ExecStart=/usr/bin/node /path/to/runner/worker.js
Restart=always

[Install]
WantedBy=multi-user.target
```

For Scenario B, set `WORKER_URL` in the private `.runtime/runner.env` to an HTTPS endpoint, or keep the loopback URL and establish the documented SSH tunnel. For VPN access, use only the VPN address/interface.

</details>

<details>
<summary><strong>Why long-polling?</strong></summary>

The runner sits on the host (or a remote machine) behind NAT — `task-api` inside Docker cannot push to it. Rather than requiring the runner to expose a port, the runner holds an outbound long-poll connection to `task-api` waiting for work. When a task arrives, `task-api` responds immediately. No inbound runner port or WebSocket server is needed; the same flow works on localhost and across an encrypted remote transport.

</details>

<details>
<summary><strong>Prerequisites</strong></summary>

- Docker (with Docker Compose)
- Node.js >= 22.5 (required for `node:sqlite` built-in)
- At least one CLI installed and authenticated: Claude Code or Codex
- OpenClaw instance (Docker deployment)

</details>

---

## Author

Built by [AliceLJY](https://github.com/AliceLJY) — a non-programmer who builds AI agent infrastructure with Claude Code. Writes about the journey on WeChat: "My AI Cabin".

This project grew out of real-world pain: running five OpenClaw bots in Docker while needing Claude Code, Codex, and (at the time) Gemini CLI on the host.

## Ecosystem

Part of the **小试AI** open-source AI workflow:

| Project | Description |
|---------|-------------|
| [recallnest](https://github.com/AliceLJY/recallnest) | MCP memory workbench (LanceDB + Jina v5) |
| [digital-clone-skill](https://github.com/AliceLJY/digital-clone-skill) | Build digital clones from corpus data |
| [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge) | Telegram bots for Claude, Codex, Agy, and Kimi |
| [claude-code-studio](https://github.com/AliceLJY/claude-code-studio) | Multi-session collaboration platform for Claude Code |
| cc-empire *(private)* | Complete Claude Code workflow scaffold |

## License

MIT
