# openclaw-tunnel

让 Docker 里的 OpenClaw 调得动宿主机上的 Claude Code / Codex / Gemini CLI。

---

## acpx vs tunnel

[acpx](https://github.com/openclaw/acpx) 是 OpenClaw 官方的 CLI 客户端，基于 [Agent Client Protocol](https://agentclientprotocol.com/)（ACP）— Zed 和 JetBrains 联合推动的开放协议。acpx 通过 stdio 直接 spawn 本地 CLI 进程，快、零开销、协议原生。如果 OpenClaw 和 Claude Code 在同一台机器上，用 acpx 就对了。

**问题在哪：** OpenClaw 跑在 Docker 里的时候，acpx 够不到宿主机上的 CLI。ACP 是 stdio 协议，没有网络传输层。`--agent` 参数只接受本地可执行文件路径，不接受 URL。远程 ACP 在协议规范里还标着"work in progress"。

**tunnel 怎么解决：** 不等远程 ACP 落地，直接用 HTTP 任务队列绕过去。插件（Docker 内）把任务推到 task-api，宿主机上的 runner 长轮询拉取任务，spawn Claude Code，结果通过 callback 直推聊天频道。不需要跨容器的 stdio。

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
Discord
   |
   | /cc <问题>
   v
OpenClaw (Docker)
   |
   | plugin: POST /claude
   v
task-api (Docker, port 3456)
   |
   | long-poll: GET /worker/poll
   v
runner (宿主机, Node.js)
   |
   | spawn claude --print
   v
Claude Code CLI (宿主机)
   |
   | 结果推回
   v
Discord channel (bot callback)
```

---

## 功能特性

**会话延续**
同一个 Discord 频道连续发 `/cc`，自动接上上一轮对话，不用手动带 session ID。会话绑定持久化到 SQLite，runner 重启不丢。

**零 token 中转**
`/cc` 走 `registerCommand` 注册，直接打 task-api，完全绕过 OpenClaw agent。CC 的输出原文推回 Discord，不经过任何模型润色，也不消耗 OpenClaw 的 token 配额。

**平台无关**
task-api 和 plugin 不依赖任何平台特定 API。回调默认走 Discord Bot API，但 `CALLBACK_API_BASE_URL` 可以换成任何兼容接口。

**一键配置**
运行 `setup.sh`，交互式填几个参数，自动生成 `.env`、更新 plugin 配置、在 macOS 上安装 LaunchAgent。

---

## 快速开始

**前置条件**：Docker 已运行，宿主机装了 Node.js >= 22.5，Claude Code CLI 已登录认证。

```bash
# 1. 克隆仓库
git clone https://github.com/AliceLJY/openclaw-tunnel.git
cd openclaw-tunnel

# 2. 运行配置向导
bash setup.sh
# 按提示填写：端口、Discord Bot Token、回调频道 ID
# setup.sh 会自动生成 .env 并安装 LaunchAgent

# 3. 启动 task-api
docker compose up -d

# 4. 把 plugin/ 目录复制到 OpenClaw 的插件目录
# 或在 openclaw.json 的 plugins 里引用它

# 5. 试一下
/cc 你好，帮我写个 hello world
```

---

## 三个组件

### task-api

跑在 Docker 里的 HTTP 服务，是整个系统的状态中心。

- 接收来自 plugin 的任务（`POST /claude`）
- 把任务存进 SQLite，等 runner 来领
- 支持长轮询（`GET /worker/poll`），runner 连上来就立刻下发
- 管理 session 状态、任务过期清理
- 暴露 `GET /health` 供健康检查

默认端口 3456，通过 `docker compose up -d` 启动。

### runner

跑在宿主机上的 Node.js 进程，是真正执行任务的一侧。

- 长轮询 task-api，有任务立刻领取
- 支持最多 5 个任务并发
- 调用 `claude --print --resume <sessionId>` 执行 CC
- CC 模型优先用 `claude-opus-4-6`，失败自动降级到 `claude-sonnet-4-6`
- 执行完把结果直推 Discord callback channel
- 支持短 session ID 前缀匹配（`/cc-recent` 显示的 8 位截断 ID 可以直接用来 resume）

macOS 用 LaunchAgent 开机自启。Linux 手动跑或配 systemd。

### plugin

装在 OpenClaw 里的 TypeScript 插件，负责接收 `/cc` 命令、提交任务、管理 session 绑定。

注册了以下命令：

| 命令 | 说明 |
|------|------|
| `/cc <问题>` | 提交 CC 任务，同频道自动续接上一轮 |
| `/cc-new` | 重置当前频道的 session |
| `/cc-new <问题>` | 重置后立即提问 |
| `/cc-recent` | 查看最近 8 个 CC 会话 |
| `/cc-now` | 查看当前频道绑定的 session ID |
| `/cc-resume <id> <问题>` | 切到指定历史 session 继续聊 |
| `/cli-state` | 查看插件内部状态（session 绑定、持久化路径等） |

---

## 会话命令参考

```
/cc 帮我分析这段代码                 # 提交任务，自动续接同频道上一轮
/cc-new                              # 重置，下次 /cc 开新会话
/cc-new 从头来，先给我讲一下需求      # 重置并立即提问
/cc-recent                           # 列出最近会话，带话题摘要
/cc-now                              # 查当前 session ID（前 8 位）
/cc-resume a1b2c3d4 继续上次的任务   # 用 8 位前缀切换到历史会话
```

---

## 配置说明

`setup.sh` 生成的 `.env` 文件，所有参数都在这里：

```env
# task-api（Docker 内）
WORKER_TOKEN=<自动生成的随机 token>
PORT=3456
CALLBACK_BOT_TOKEN=<Discord Bot Token>
CALLBACK_API_BASE_URL=https://discord.com/api/v10

# runner（宿主机）
WORKER_URL=http://localhost:3456
CLAUDE_PATH=claude
CC_TIMEOUT=1200000
```

plugin 的配置在 `plugin/openclaw.plugin.json` 的 `config` 字段里，`setup.sh` 会自动写入：

```json
{
  "config": {
    "apiUrl": "http://host.docker.internal:3456",
    "apiToken": "<WORKER_TOKEN>",
    "callbackChannel": "<频道 ID>",
    "discordBotToken": "<Bot Token>"
  }
}
```

runner 可选环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WORKER_URL` | `http://127.0.0.1:3456` | task-api 地址 |
| `WORKER_TOKEN` | — | 认证 token，必填 |
| `POLL_INTERVAL` | `500` ms | 并发满时的轮询间隔 |
| `LONG_POLL_WAIT` | `30000` ms | 长轮询等待窗口 |
| `MAX_CONCURRENT` | `5` | 最大并发任务数 |
| `CALLBACK_BOT_TOKEN` | — | Discord Bot Token |
| `DISCORD_PROXY` | `http://127.0.0.1:7897` | HTTPS 代理（国内用户） |

---

## Linux 运行

macOS 用 LaunchAgent，Linux 没有这个机制，手动起 runner：

```bash
cd runner
WORKER_URL=http://localhost:3456 \
WORKER_TOKEN=你的token \
node worker.js
```

或者配 systemd 单元文件持久运行：

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

---

## 前置条件

- Docker（已运行）
- Node.js >= 22.5（runner 用了 `node:sqlite` 内置模块，22.5 以下不支持）
- Claude Code CLI，已完成登录认证（`claude auth login`）
- OpenClaw 实例（Docker 部署），已配置 Discord Bot Token

---

## 为什么用长轮询？

最直观的方案是 runner 定时轮询 task-api，比如每秒问一次"有任务吗"。这能用，但有延迟、有无效请求。

openclaw-tunnel 用的是长轮询：runner 发起一个 `GET /worker/poll?wait=30000` 请求，task-api 收到后不立刻回，而是 hold 住连接最多 30 秒。这 30 秒内有新任务进来，立刻返回；没有任务，30 秒到了再返回 null，runner 马上发下一个请求。

效果上接近推送，实现上只需要普通 HTTP，不需要 WebSocket 或任何持久连接基础设施。对于 CC 任务这种低频、延迟不敏感的场景，够用且简单。

---

## 作者

[AliceLJY](https://github.com/AliceLJY) — 不是程序员，用 Claude Code 搭 AI agent 基础设施的野路子玩家。公众号「我的AI小木屋」记录折腾过程。

这个项目来自真实的痛：五个 OpenClaw bot 跑在 Docker 里，Claude Code / Codex / Gemini 在宿主机上，中间隔着容器边界。原版多 runner 方案在 [openclaw-worker](https://github.com/AliceLJY/openclaw-worker) 和 [openclaw-cli-bridge](https://github.com/AliceLJY/openclaw-cli-bridge)。

## 许可证

MIT
