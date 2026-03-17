<div align="center">

# openclaw-tunnel

**Docker OpenClaw 到宿主机 CLI 的桥梁**

*让 Docker 里的 OpenClaw 调得动宿主机上的 Claude Code / Codex / Gemini CLI。*

基于 HTTP 任务队列的桥接方案，让 Docker 内的 OpenClaw 把任务分发到宿主机上的 Claude Code、Codex 和 Gemini CLI，支持按频道的会话延续和零 token 中转。

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥22.5-339933?logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)](https://docs.docker.com/compose/)

[English](README.md) | **简体中文**

</div>

---

## acpx vs tunnel

[acpx](https://github.com/openclaw/acpx) 是 OpenClaw 官方的 CLI 客户端，基于 [Agent Client Protocol](https://agentclientprotocol.com/)（ACP）。acpx 通过 stdio 直接 spawn 本地 CLI 进程，快、零开销、协议原生。如果 OpenClaw 和 Claude Code 在同一台机器上，用 acpx 就对了。

**问题在哪：** OpenClaw 跑在 Docker 里的时候，acpx 够不到宿主机上的 CLI。ACP 是 stdio 协议，没有网络传输层。远程 ACP 在协议规范里还标着"work in progress"。

**tunnel 怎么解决：** 不等远程 ACP 落地，直接用 HTTP 任务队列绕过去。插件（Docker 内）把任务推到 task-api，宿主机上的 runner 长轮询拉取任务，spawn Claude Code，结果通过 callback 直推聊天频道。

| | acpx | tunnel |
|---|---|---|
| 协议 | ACP（stdio JSON-RPC） | HTTP 任务队列 + callback |
| 需要同一台机器 | 是 | 不需要 — Docker + 宿主机 |
| 会话模型 | 按 git 目录绑定 | 按聊天频道绑定 |
| token 消耗 | 零（协议层） | 零（协议层） |
| 适合场景 | OpenClaw 直接跑在宿主机 | OpenClaw 在 Docker 里 |

---

## 架构

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
│  宿主机               │         │
│              ┌────────┴───────┐ │
│              │  runner        │ │
│              │  → Claude Code │ │
│              │  → Codex       │ │
│              │  → Gemini      │ │
│              └────────────────┘ │
└─────────────────────────────────┘
```

插件把任务提交到 task-api（Docker 内）。宿主机上的 runner 长轮询拉取任务，spawn 对应 CLI，结果通过 bot callback 直推聊天频道。

---

## 功能特性

| 特性 | 说明 |
|------|------|
| **三个 CLI** | `/cc` Claude Code、`/codex` Codex、`/gemini` Gemini |
| **会话延续** | 按频道自动续接，绑定持久化到 SQLite |
| **零 token 中转** | 纯协议层，不消耗 OpenClaw token 配额 |
| **平台无关** | Discord、Telegram 或任何 OpenClaw 支持的平台 |
| **一键配置** | `setup.sh` 生成 `.env`、更新插件配置、安装 LaunchAgent |
| **并发执行** | 最多 5 个并行任务，自动模型降级 |

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
3. 生成 `WORKER_TOKEN` 并写入 `.env`
4. 更新 `plugin/openclaw.plugin.json`
5. 可选安装 macOS LaunchAgent

配置完成后，把 `plugin/` 目录复制到 OpenClaw 插件目录（或在 `openclaw.json` 里引用）。

---

## 三个组件

**`task-api/`** — Docker 里的 Express HTTP 服务。接收插件提交的任务，存入 SQLite，通过长轮询下发给 runner，完成后把结果推回聊天频道。默认端口 3456。

**`runner/`** — 宿主机上的 Node.js 进程。长轮询 task-api，spawn Claude Code / Codex / Gemini CLI（最多 5 个并发）。模型优先 `claude-opus-4-6`，失败自动降级到 `claude-sonnet-4-6`。

**`plugin/`** — OpenClaw TypeScript 插件。注册 `/cc`、`/codex`、`/gemini` 命令族，管理按频道的 session 绑定（SQLite 持久化），向 task-api 提交任务。

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

<details>
<summary><strong>配置说明</strong></summary>

`setup.sh` 生成的 `.env` 文件：

| 变量 | 使用位置 | 说明 |
|------|---------|------|
| `WORKER_TOKEN` | task-api + runner | 共享认证密钥（≥16 字符） |
| `PORT` | task-api | 监听端口（默认 `3456`） |
| `CALLBACK_BOT_TOKEN` | task-api | 用于推送结果的 Bot Token |
| `CALLBACK_API_BASE_URL` | task-api | Bot API 地址（默认 Discord） |
| `WORKER_URL` | runner | task-api 地址（默认 `http://localhost:3456`） |
| `CLAUDE_PATH` | runner | `claude` 二进制路径（默认 `claude`） |
| `CC_TIMEOUT` | runner | 单任务最大执行时间（默认 `1200000` ms） |
| `MAX_CONCURRENT` | runner | 最大并发数（默认 `5`） |
| `POLL_INTERVAL` | runner | 并发满时轮询间隔（默认 `500` ms） |
| `LONG_POLL_WAIT` | runner | 长轮询等待窗口（默认 `30000` ms） |
| `DISCORD_PROXY` | runner | HTTPS 代理（国内用户） |

plugin 的配置在 `plugin/openclaw.plugin.json` 的 `config` 字段里，`setup.sh` 自动写入。

</details>

<details>
<summary><strong>Linux 运行</strong></summary>

macOS 用 LaunchAgent 自启。Linux 手动运行：

```bash
cd runner
WORKER_URL=http://localhost:3456 WORKER_TOKEN=你的token node worker.js
```

或配 systemd 持久运行：

```ini
[Unit]
Description=openclaw-tunnel runner
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/runner/worker.js
Environment=WORKER_URL=http://localhost:3456
Environment=WORKER_TOKEN=你的token
Restart=always

[Install]
WantedBy=multi-user.target
```

</details>

<details>
<summary><strong>为什么用长轮询？</strong></summary>

runner 在宿主机上，可能在 NAT 后面，task-api 没法主动推送。与其让 runner 暴露端口或搞反向隧道，runner 直接 hold 一个 HTTP 连接等待任务——有任务立刻返回，没任务 30 秒超时后重连。效果接近推送，实现只需要普通 HTTP。对 CLI 任务这种低频场景，够用且简单。

</details>

<details>
<summary><strong>前置条件</strong></summary>

- Docker（已运行，含 Docker Compose）
- Node.js >= 22.5（runner 用了 `node:sqlite` 内置模块）
- Claude Code CLI 已安装并认证
- OpenClaw 实例（Docker 部署）

</details>

---

## 作者

[AliceLJY](https://github.com/AliceLJY) — 不是程序员，用 Claude Code 搭 AI agent 基础设施的野路子玩家。公众号「我的AI小木屋」记录折腾过程。

这个项目来自真实的痛：五个 OpenClaw bot 跑在 Docker 里，Claude Code / Codex / Gemini 在宿主机上，中间隔着容器边界。

## 许可证

MIT
