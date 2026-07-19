<div align="center">

# openclaw-tunnel

**随时随地运行 AI 编程 Agent — Docker、云端、混合部署**

*基于带认证的 HTTP(S) 任务队列，让 OpenClaw 跨容器边界、跨网络边界调度 Claude Code、Codex 和 Gemini CLI。*

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥22.5-339933?logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)](https://docs.docker.com/compose/)

[English](README.md) | **简体中文**

</div>

---

> **状态：维护模式。** 作者自己的部署里，OpenClaw 插件的 slash 命令路径已退役；
> 当前在用的是容器通过本机/私有网络直接调用 task-api（见下方“两种接入方式”）。
> 插件本身仍可用，对 OpenClaw 用户仍是推荐入口。

---

## 为什么需要 tunnel？

[acpx](https://github.com/openclaw/acpx) 是 OpenClaw 官方的 CLI 客户端，基于 [Agent Client Protocol](https://agentclientprotocol.com/)（ACP）。acpx 通过 stdio 直接 spawn 本地 CLI 进程，快、零开销、协议原生。如果 OpenClaw 和 Claude Code 在同一台机器上，用 acpx 就对了。

**问题在哪：** OpenClaw 跑在 Docker 或远程服务器上时，acpx 够不到另一台机器上的 CLI。ACP 是 stdio 协议，没有网络传输层。远程 ACP 在协议规范里还标着"work in progress"。

**tunnel 怎么解决：** 不等远程 ACP 落地，直接用带认证的 HTTP(S) 任务队列绕过去。插件（Docker 内）把任务推到 task-api，同机或可信加密网络内的 runner 长轮询拉取任务，spawn CLI，再把结果回传给 task-api，由服务端推回聊天频道。

| | acpx | tunnel |
|---|---|---|
| 协议 | ACP（stdio JSON-RPC） | 带认证的 HTTP(S) 任务队列 + 服务端 callback |
| 需要同一台机器 | 是 | 不需要 — 跨网络可用 |
| 会话模型 | 按 git 目录绑定 | 按聊天频道绑定 |
| token 消耗 | 零（协议层） | 零（协议层） |
| 适合场景 | OpenClaw 直接跑在宿主机 | OpenClaw 在 Docker 或云端 |

---

## 部署场景

tunnel 支持三种部署模式，按需选择：

### 场景 A：本地 Docker（默认）

OpenClaw + task-api 在本机 Docker 里，runner 在宿主机上。一台机器搞定。

```
┌──────────────────────────────────────┐
│  你的机器                             │
│                                      │
│  ┌─────────── Docker ──────────────┐ │
│  │  OpenClaw + plugin              │ │
│  │  task-api :3456                 │ │
│  └──────────────┬──────────────────┘ │
│                 │ 长轮询              │
│  ┌──────────────┴──────────────────┐ │
│  │  runner                         │ │
│  │  → Claude Code / Codex / Gemini │ │
│  └─────────────────────────────────┘ │
└──────────────────────────────────────┘
```

```bash
# runner 连本机（默认配置）
WORKER_URL=http://localhost:3456
```

### 场景 B：云端 + 本地 Runner（必须加密传输）

task-api 部署在云端服务器（AWS、GCP 或任意 VPS），runner 在本地 — CLI 留在身边，编排交给云端。

```
┌───── 云端服务器 ────┐           ┌────── 你的机器 ──────────┐
│  Docker             │           │                           │
│   OpenClaw + plugin │ HTTPS /   │  runner                   │
│   task-api :3456    │◄──────────│  → Claude Code            │
│                     │ VPN / SSH │  → Codex                  │
└─────────────────────┘           │  → Gemini                 │
                                  └───────────────────────────┘
```

```bash
# 方案 1：在 task-api 前放 TLS 反向代理
WORKER_URL=https://task-api.example.com

# 方案 2：SSH 隧道；云端 task-api 仍只绑定 loopback
ssh -N -L 3456:127.0.0.1:3456 user@task-api-host
WORKER_URL=http://127.0.0.1:3456
```

也可以使用 Tailscale 或其它 VPN，但 `task-api` 只能绑定到 VPN 接口。绝不能让 bearer token、prompt 或结果通过公网明文 HTTP 传输。

### 场景 C：全部远程

所有组件都在托管云环境，`task-api` 仍应只走 loopback 或私有网络。这种部署可以配合单位的管控要求，但“放在云端”本身不等于合规。

```
┌────────────────── 云端服务器 ─────────────────┐
│                                              │
│  ┌─────────── Docker ──────────────┐         │
│  │  OpenClaw + plugin              │         │
│  │  task-api :3456                 │         │
│  └──────────────┬──────────────────┘         │
│                 │ 长轮询（localhost）          │
│  ┌──────────────┴──────────────────┐         │
│  │  runner                         │         │
│  │  → Claude Code / Codex / Gemini │         │
│  └─────────────────────────────────┘         │
└──────────────────────────────────────────────┘
```

```bash
# runner 和 task-api 在同一台 VM
WORKER_URL=http://localhost:3456
# 在 VM 上安装 CLI，runner 用 systemd 托管
```

---

## 功能特性

| 特性 | 说明 |
|------|------|
| **三个 CLI** | `/cc` Claude Code、`/codex` Codex、`/gemini` Gemini |
| **会话延续** | 按频道自动续接，绑定持久化到 SQLite |
| **零 token 中转** | 纯协议层，不消耗 OpenClaw token 配额 |
| **平台无关** | Discord、Telegram 或任何 OpenClaw 支持的平台 |
| **引导式配置** | `setup.sh` 生成被 Git 忽略的私有运行时配置，并可安装 LaunchAgent；plugin 复制与配置合并仍需手工完成 |
| **并发执行** | 最多 5 个并行任务，可配置 Claude 模型降级 |
| **SDK + CLI 双模式** | 优先用 Agent SDK（流式输出），失败自动回退到 CLI |
| **支持远程** | 可本地 Docker、云端 VM 或混合部署；远程链路必须走 HTTPS、VPN 或 SSH 隧道 |

---

## 快速开始

```bash
git clone https://github.com/AliceLJY/openclaw-tunnel.git
cd openclaw-tunnel
./setup.sh
docker-compose up -d
# 在聊天里试试 /cc 你好
```

`setup.sh` 会：
1. 检查前置条件（Docker、Node.js、Claude Code CLI）
2. 提示输入端口、Bot Token、回调频道 ID
3. 生成 256-bit `WORKER_TOKEN`，不在终端显示；分别写入 task-api `.env` 和权限收窄的 `.runtime/runner.env`，两者都被 Git 忽略且权限为 `0600`
4. 生成权限为 `0600` 的 Git 忽略配置片段 `.runtime/openclaw-plugin-config.json`；callback bot token 只留在 task-api `.env`
5. 自动识别 Claude/Codex 会话目录，以只读方式挂载进 task-api，供最近会话命令使用
6. 可选安装 macOS LaunchAgent

配置完成后，把 `plugin/` 目录复制到 OpenClaw 插件目录（或在 `openclaw.json` 里引用），再把 `.runtime/openclaw-plugin-config.json` 合并进现有的 OpenClaw 私有配置。受 Git 跟踪的 `plugin/openclaw.plugin.json` 只保留 schema，不再写任何凭证。

---

## 三个组件

**`task-api/`** — Docker 里的 Express HTTP 服务。接收插件提交的任务，存入 SQLite，通过长轮询下发给 runner，接收执行结果，并把结果推回聊天频道。默认端口 3456。

**`runner/`** — 宿主机（或任意机器）上的 Node.js 进程。长轮询 task-api，spawn Claude Code / Codex / Gemini CLI（最多 5 个并发），并把执行结果回传给 task-api。优先使用 Agent SDK（流式输出），失败自动回退到 CLI 模式。

**`plugin/`** — OpenClaw TypeScript 插件。注册 `/cc`、`/codex`、`/gemini` 命令族，管理按频道的 session 绑定（SQLite 持久化），向 task-api 提交任务。

task-api 重启时，如果任务已被 runner 领取，会保留原来的 `running` 状态，不自动重新排队，因为命令可能已经产生副作用。仍在执行的 runner 可以正常回报结果；收不到结果时，应先检查实际影响，再人工提交替代任务。

---

## 会话命令

| Claude Code | Codex | Gemini | 说明 |
|---|---|---|---|
| `/cc <问题>` | `/codex <问题>` | `/gemini <问题>` | 提交任务，续接同频道会话 |
| `/cc-new` | `/codex-new` | `/gemini-new` | 重置会话 |
| `/cc-recent` | — | — | 查看最近会话列表 |
| `/cc-resume <id>` | `/codex-resume <id>` | `/gemini-resume <id>` | 切换到指定历史会话 |
| `/cc-now` | `/codex-now` | `/gemini-now` | 查看当前 session ID |
| `/cli-state` | `/cli-state` | `/cli-state` | 检查连接状态 |

---

## 两种接入方式

`task-api` 提供带认证的 HTTP API。本机 loopback / 私有 Docker 网络可以用 HTTP；跨主机必须使用 HTTPS、VPN 或 SSH 隧道。有两种驱动方式：

**1. OpenClaw 插件（slash 命令）** — 把 `plugin/` 装进 OpenClaw 实例，聊天里用 `/cc`、`/codex`、`/gemini` 触发（见上方命令表）。适合 OpenClaw 用户。

**2. 直接 API** — 可信客户端（脚本、bot、其它 agent）可以直接 `POST /claude`，无需插件。下面的远程示例假定前面已有 TLS 反向代理：

```bash
curl -X POST https://task-api.example.com/claude \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "你要 CC 做的事", "timeout": 600000, "callbackChannel": "<可选的回调频道ID>"}'
```

返回 `{ "taskId": "...", "sessionId": "..." }`。传了 `callbackChannel` 走异步回调推送；不传则用 `GET /tasks/<taskId>?wait=<ms>` 轮询拿结果。`/codex`、`/gemini` 用法相同。

---

## 安全与信任边界

这个项目是**可信远程执行桥，不是沙箱**。拿到 `WORKER_TOKEN`，就应视为拿到了接近 runner 宿主机当前用户权限的能力：

- 通过认证的调用方可以提交 shell 命令、在 runner 的宽泛允许目录内读写/编辑文件，并调用 Claude Code、Codex 或 Gemini。
- 命令前缀过滤器会挡住一部分不支持或明显危险的字符串，但通过后仍由宿主机 shell（Unix 使用 `SHELL`，Windows 使用 `ComSpec`）以 runner 用户身份解释执行。前缀匹配不是 shell 解析、隔离机制，也不能承担恶意用户鉴权。
- 三个 CLI 路径有意使用较宽的自动执行模式。若 prompt injection 成功或 bearer token 被盗，影响范围会接近 runner 用户账号本身。
- runner 会从 shell 命令和 AI CLI 子进程环境中移除 `WORKER_TOKEN`、callback bot token 和 hook token。这能减少凭证意外暴露，但不等于给子进程加了沙箱。

传输与部署规则：

- 明文 HTTP 只用于 loopback 或明确的私有 Docker 网络。
- 跨主机必须使用 HTTPS 反向代理、绑定私有接口的 VPN/Tailscale，或 SSH 隧道。`WORKER_TOKEN` 只能认证请求，不能加密 prompt、结果或凭证。
- Compose 默认只把 `task-api` 发布到 `127.0.0.1`。VPN 场景把 `TASK_API_BIND` 设为具体 VPN 接口地址，不要发布到公网通配地址。
- `.env`、`.runtime/runner.env`、`.runtime/openclaw-plugin-config.json`、OpenClaw 配置、任务数据库和 runner 日志都应保持私有。runner/plugin 配置暴露时轮换 worker token；task-api `.env` 暴露时再同时轮换 callback token。
- 云端或容器化不自动等于合规；仍需按实际要求核对身份、传输加密、宿主机防护、留存和模型供应商的数据处理。

---

<details>
<summary><strong>配置说明</strong></summary>

优先使用 `setup.sh`，它会拆分 task-api 与 runner 配置，避免 callback bot token 被 runner 子进程继承。手工配置时，`.env.example` 列出全部变量，`runner/runtime-config.example` 是权限收窄的 runner 模板。

| 变量 | 使用位置 | 说明 |
|------|---------|------|
| `WORKER_TOKEN` | task-api + runner | 共享认证密钥（≥16 字符；setup 默认生成 256-bit 随机值） |
| `PORT` | task-api | 监听端口（默认 `3456`） |
| `TASK_API_BIND` | Docker Compose | 宿主机发布接口（默认 `127.0.0.1`；VPN 场景填具体 VPN 地址） |
| `CALLBACK_BOT_TOKEN` | task-api | 用于推送结果的 Bot Token |
| `CALLBACK_API_BASE_URL` | task-api | Bot API 地址（默认 Discord） |
| `CALLBACK_CHANNEL` | task-api | 可选兜底频道/子区 ID，任务没有 callbackChannel 时使用 |
| `CLAUDE_PROJECTS_DIR` | Compose + runner | 宿主机 Claude 项目/会话目录；setup 默认识别 `~/.claude/projects`，Compose 只读挂载 |
| `CODEX_SESSIONS_DIR` | Compose + runner | 宿主机 Codex 会话目录；setup 默认识别 `~/.codex/sessions`，Compose 只读挂载 |
| `WORKER_URL` | runner | task-api 地址（默认 `http://localhost:3456`） |
| `CLAUDE_PATH` | runner | `claude` 二进制路径（默认 `claude`） |
| `CODEX_PATH` | runner | `codex` 二进制路径（默认 `codex`） |
| `GEMINI_PATH` | runner | `gemini` 二进制路径（默认 `gemini`） |
| `CC_TIMEOUT` | runner | 任务未自带 timeout 时的兜底执行上限（默认 `1200000` ms） |
| `CC_MODELS` | runner | 可选 Claude 模型列表，逗号分隔。留空表示使用 Claude Code 默认模型 |
| `RUNNER_SESSION_CACHE_FILE` | runner | 可选 session cache 路径。留空使用系统临时目录 |
| `CC_LOG_PATH` | runner | 可选 Claude live log 路径。留空使用系统临时目录 |
| `MAX_CONCURRENT` | runner | 最大并发数（默认 `5`） |
| `POLL_INTERVAL` | runner | 并发满时轮询间隔（默认 `500` ms） |
| `LONG_POLL_WAIT` | runner | 长轮询等待窗口（默认 `30000` ms） |
| `WORKER_DIRECT_CALLBACK` | runner | 旧路径开关：是否让 runner 直接调用 callback API。Windows / 云端部署保持 `false` |
| `WORKER_SHELL` | runner | 可选 shell 覆盖；默认使用 `SHELL`/标准 Unix shell，Windows 使用 `ComSpec` |
| `DISCORD_PROXY` | runner | 旧路径的 HTTPS 代理（可选） |

受 Git 跟踪的 `plugin/openclaw.plugin.json` 只定义 schema。运行时配置应放在私有 OpenClaw 配置的 `plugins.entries.cli-bridge.config` 下。`setup.sh` 生成的 `.runtime/openclaw-plugin-config.json` 只含 worker API token 与 callback channel。schema 仍保留可选 `callbackBotToken` 供旧版/手工部署使用，但 setup 不会把它复制到 plugin 或 runner。

</details>

<details>
<summary><strong>Linux / 云端运行</strong></summary>

`setup.sh` 可选安装 macOS LaunchAgent。Linux 或云端服务器手动运行：

```bash
cd runner
node --env-file=../.runtime/runner.env worker.js
```

Windows 上可以直接运行：

```bat
cd runner
node --env-file=..\.runtime\runner.env worker.js
```

runner 在 Windows 上默认用 `%TEMP%` 保存 session cache 和 live log。命令默认由 `ComSpec`（通常是 `cmd.exe`）执行，也可用 `WORKER_SHELL` 选择 cmd 兼容 shell 或 PowerShell。保持 `WORKER_DIRECT_CALLBACK=false`，让 Windows 只把结果回传给 task-api，由服务端负责推送聊天 callback。

或配 systemd 持久运行：

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

部署场景 B 时，在私有 `.runtime/runner.env` 中把 `WORKER_URL` 设为 HTTPS 地址；或者保留 loopback 地址并建立前文的 SSH 隧道。VPN 场景只使用 VPN 地址/接口。

</details>

<details>
<summary><strong>为什么用长轮询？</strong></summary>

runner 在宿主机或远程机器上，可能在 NAT 后面，task-api 没法主动推送。与其让 runner 暴露端口，runner 主动维持一个长轮询连接等待任务——有任务立刻返回，没任务 30 秒超时后重连。不需要开放 runner 入站端口或 WebSocket；同一套流程可用于本机，也可承载在加密的远程链路上。

</details>

<details>
<summary><strong>前置条件</strong></summary>

- Docker（已运行，含 Docker Compose）
- Node.js >= 22.5（runner 用了 `node:sqlite` 内置模块）
- 至少安装一个 CLI 并完成认证：Claude Code、Codex 或 Gemini
- OpenClaw 实例（Docker 部署）

</details>

---

## 作者

[AliceLJY](https://github.com/AliceLJY) — 不是程序员，用 Claude Code 搭 AI Agent 基础设施的野路子玩家。公众号「我的AI小木屋」记录折腾过程。

这个项目来自真实的痛：五个 OpenClaw bot 跑在 Docker 里，Claude Code / Codex / Gemini 在宿主机上，中间隔着容器边界。

## 许可证

MIT
