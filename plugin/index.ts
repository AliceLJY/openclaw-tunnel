/**
 * openclaw-tunnel — OpenClaw Plugin
 *
 * 架构（学自 HappyClaw）：
 * - /cc 命令通过 registerCommand 注册，零 agent token，零杂音
 * - CC 结果由 worker 直推 callback channel（默认兼容 Discord Bot API），不经过 agent 润色
 *
 * 用法（任意频道）：
 *   /cc <问题>        → 提交 CC 任务（自动续接上一轮）
 *   /cc-recent        → 查看最近会话列表
 *   /cc-now           → 查看当前会话
 *   /cc-new           → 重置会话
 *   /cc-new <问题>    → 重置后立即提问
 *   /cc-resume <id> <问题> → 手动指定 session 续接
 *
 * 框架限制：matchPluginCommand 用空格分割命令名和参数，
 * 所以 /cc最近（连写）匹配不到 /cc，会穿透给 agent。
 * 解决方案：子命令用独立 ASCII 命名（cc-recent 等），学 HappyClaw 模式。
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---- 运行时配置（由 register() 从 pluginConfig 注入） ----
let API_URL = "";
let API_TOKEN = "";
let CC_CHANNEL = "";
let CALLBACK_BOT_TOKEN = "";
let SESSION_STORE_PATH = path.join(process.env.HOME || "/tmp", ".openclaw-cli-bridge", "state.db");
let sessionDb: DatabaseSync | null = null;

type DispatchMode = "direct-command" | "agent-tool";

type SessionBindingRow = {
  scope: "cc";
  key: string;
  sessionId: string;
};

// ---- 工具结果 helper ----
function text(data: unknown) {
  const t = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: t }] };
}

// ---- API 请求 helper ----
async function api(method: string, path: string, body?: unknown) {
  const opts: RequestInit = {
    method,
    headers: {
      "Authorization": `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${API_URL}${path}`, opts);
}

function buildTaskBody(
  prompt: string,
  timeout: number,
  callbackChannel: string,
  dispatchMode: DispatchMode,
  entrypoint: string,
) {
  const body: Record<string, unknown> = {
    prompt,
    timeout,
    callbackChannel,
    origin: "openclaw-cli-bridge",
    dispatchMode,
    responseMode: "direct-callback",
    entrypoint,
  };
  if (CALLBACK_BOT_TOKEN) body.callbackBotToken = CALLBACK_BOT_TOKEN;
  return body;
}

// ---- 会话跟踪（按频道隔离，每个频道独立 session） ----
const channelSessions = new Map<string, string>();

function getSessionDb(log: { warn?: (msg: string) => void }) {
  if (sessionDb) return sessionDb;

  try {
    fs.mkdirSync(path.dirname(SESSION_STORE_PATH), { recursive: true });
    sessionDb = new DatabaseSync(SESSION_STORE_PATH);
    sessionDb.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        scope TEXT NOT NULL,
        session_key TEXT NOT NULL,
        session_value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, session_key)
      );
    `);
    return sessionDb;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn?.(`[cli-bridge] session db open failed: ${message}`);
    return null;
  }
}


function saveSessionStore(log: { warn?: (msg: string) => void }) {
  const db = getSessionDb(log);
  if (!db) return;

  try {
    const now = Date.now();
    const upsert = db.prepare(`
      INSERT INTO sessions (scope, session_key, session_value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope, session_key) DO UPDATE SET
        session_value = excluded.session_value,
        updated_at = excluded.updated_at
    `);
    const clearScope = db.prepare(`DELETE FROM sessions WHERE scope = ?`);

    clearScope.run("cc");
    for (const [key, value] of channelSessions.entries()) {
      upsert.run("cc", key, value, now);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn?.(`[cli-bridge] session store save failed: ${message}`);
  }
}

function loadSessionStore(log: { warn?: (msg: string) => void; info?: (msg: string) => void }) {
  channelSessions.clear();

  try {
    const db = getSessionDb(log);
    if (!db) return;

    const rows = db.prepare(`
      SELECT scope, session_key, session_value
      FROM sessions
      ORDER BY updated_at ASC
    `).all() as Array<{ scope: string; session_key: string; session_value: string }>;

    for (const row of rows) {
      if (row.scope === "cc") {
        channelSessions.set(row.session_key, row.session_value);
      }
    }
    log.info?.(`[cli-bridge] session store loaded: cc=${channelSessions.size}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn?.(`[cli-bridge] session store load failed: ${message}`);
  }
}

function setSession(map: Map<string, string>, key: string, value: string, log: { warn?: (msg: string) => void }) {
  map.set(key, value);
  saveSessionStore(log);
}

function deleteSession(map: Map<string, string>, key: string, log: { warn?: (msg: string) => void }) {
  if (map.delete(key)) {
    saveSessionStore(log);
  }
}

function getCurrentChannelKey(ctx: any) {
  return ctx.to?.replace(/^channel:/, "") || "default";
}

function collectSessionBindings(channelKey: string) {
  const current = {
    cc: channelSessions.get(channelKey) || null,
  };

  const bindings: SessionBindingRow[] = [];
  for (const [key, sessionId] of channelSessions.entries()) {
    bindings.push({ scope: "cc", key, sessionId });
  }

  return {
    sessionStorePath: SESSION_STORE_PATH,
    current,
    counts: {
      cc: channelSessions.size,
    },
    bindings,
  };
}

function formatStateText(channelKey: string) {
  const state = collectSessionBindings(channelKey);
  const lines = [
    "openclaw-tunnel 状态",
    "",
    `当前频道: \`${channelKey}\``,
    `sessionStore: \`${state.sessionStorePath}\``,
    `直连优先: 是`,
    "",
    "当前绑定:",
    `- CC: ${state.current.cc ? `\`${state.current.cc}\`` : "无"}`,
    "",
    `总绑定数: CC ${state.counts.cc}`,
  ];

  return lines.join("\n");
}

async function handleStateCommand(ctx: any): Promise<{ text: string; isError?: boolean }> {
  return {
    text: formatStateText(getCurrentChannelKey(ctx)),
  };
}

// ---- /cc 命令 handler ----
async function handleCcCommand(ctx: any): Promise<{ text: string; isError?: boolean }> {
  const log = (globalThis as any).__cliBridgeLog ?? console;
  let args = (ctx.args || "").trim();

  // 频道 key：按频道隔离 session
  const channelKey = getCurrentChannelKey(ctx);
  const lastSessionId = channelSessions.get(channelKey) || null;

  log.info(`[cli-bridge] handler called | args="${args}" | channel=${channelKey.slice(0, 8)} | session=${lastSessionId?.slice(0, 8) || 'none'}`);

  // 空命令 → 帮助
  if (!args) {
    const session = lastSessionId ? `当前会话: \`${lastSessionId}\`` : "当前无活跃会话";
    return {
      text: `📋 CLI Bridge 命令：
/cc <问题> — 提交任务（同频道自动续接，不用手动带 ID）
/cc-new — 开始全新会话
/cc-new <问题> — 开新会话并立即提问
/cc-recent — 查看最近会话列表
/cc-now — 查看当前会话 ID
/cc-resume <id> <问题> — 切到指定历史会话继续聊

💡 同一频道连着发 /cc 就是同一轮对话
${session}`
    };
  }

  // /cc最近 → 查询最近会话
  if (/^(最近|recent)/i.test(args)) {
    log.info("[cli-bridge] /cc最近: 查询会话列表");
    try {
      const res = await api("GET", "/claude/recent?limit=8");
      if (!res.ok) return { text: "❌ 查询失败", isError: true };
      const data = await res.json() as { sessions: Array<{ sessionId: string; lastModified: string; sizeKB: number; topic: string }> };
      if (!data.sessions?.length) return { text: "没有找到最近的 CC 会话。" };

      const lines = data.sessions.map((s: any, i: number) => {
        const time = new Date(s.lastModified).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
        const topic = (s.topic || "(no topic)").replace(/\s+/g, " ").trim().slice(0, 50) + (s.topic?.length > 50 ? "…" : "");
        return `${i + 1}. ${topic}\n   \`${s.sessionId}\` | ${time} | ${s.sizeKB}KB`;
      });
      const current = lastSessionId ? `\n当前: \`${lastSessionId}\`` : "\n当前无活跃会话";
      return { text: "📋 最近 CC 会话\n\n" + lines.join("\n\n") + current };
    } catch (err: unknown) {
      return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  // /cc当前 → 显示当前 session
  if (/^(当前|现在|session$)/i.test(args)) {
    return {
      text: lastSessionId
        ? `当前会话: \`${lastSessionId}\``
        : "当前无活跃会话。发 /cc <问题> 开始新会话。"
    };
  }

  // /cc新会话 [prompt] → 重置 + 可选立即提问
  if (/^(新会话|new)/i.test(args)) {
    deleteSession(channelSessions, channelKey, log);
    const prompt = args.replace(/^(新会话|new)\s*/i, "").trim();
    if (!prompt) {
      log.info("[cli-bridge] /cc新会话: 会话已重置");
      return { text: "🔄 会话已重置，下次 /cc 将开始新会话。" };
    }
    args = prompt;
  }

  // /cc接续 <sessionId> [prompt] → 手动指定 session
  const resumeMatch = args.match(/^接续\s+([a-f0-9-]{8,})\s*(.*)/i);
  if (resumeMatch) {
    setSession(channelSessions, channelKey, resumeMatch[1], log);
    const prompt = resumeMatch[2].trim();
    log.info(`[cli-bridge] /cc接续: session=${resumeMatch[1].slice(0, 8)}`);
    if (!prompt) {
      return { text: `🔗 已切换到会话 \`${resumeMatch[1]}\`\n下次 /cc <问题> 将在此会话继续。` };
    }
    args = prompt;
  }

  // 默认：提交 CC 任务
  const prompt = args;
  const currentSession = channelSessions.get(channelKey) || null;

  // 回调频道：在哪问就在哪回
  const callback = channelKey !== "default" ? channelKey : CC_CHANNEL;
  log.info(`[cli-bridge] /cc 提交: "${prompt.slice(0, 50)}..."${currentSession ? ' [session:' + currentSession.slice(0, 8) + ']' : ' [新会话]'} → callback:${callback.slice(0, 8)}`);

  const body: Record<string, unknown> = {
    ...buildTaskBody(prompt, 1200000, callback, "direct-command", "cc"),
  };
  if (currentSession) body.sessionId = currentSession;

  try {
    const res = await api("POST", "/claude", body);
    if (!res.ok) {
      const errText = await res.text();
      log.error(`[cli-bridge] 提交失败: ${res.status} ${errText}`);
      return { text: `❌ 提交失败: ${res.status}`, isError: true };
    }

    const data = await res.json() as { taskId: string; sessionId: string };
    setSession(channelSessions, channelKey, data.sessionId, log);
    log.info(`[cli-bridge] 提交成功: task=${data.taskId.slice(0, 8)}, session=${data.sessionId.slice(0, 8)}`);
    return { text: "" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[cli-bridge] 提交异常: ${msg}`);
    return { text: `❌ 无法连接 task-api: ${msg}`, isError: true };
  }
}


// ---- Plugin 注册 ----
export function register(pluginApi: any) {
  const log = pluginApi.log ?? console;
  (globalThis as any).__cliBridgeLog = log;

  // 从 pluginConfig 读取配置（openclaw.json → plugins.entries.cli-bridge）
  const cfg = pluginApi.pluginConfig ?? {};
  API_URL = cfg.apiUrl || "http://host.docker.internal:3456";
  API_TOKEN = cfg.apiToken || "";
  CC_CHANNEL = cfg.callbackChannel || cfg.defaultChannel || "";
  CALLBACK_BOT_TOKEN = cfg.callbackBotToken || "";
  SESSION_STORE_PATH = cfg.sessionStorePath || process.env.CLI_BRIDGE_SESSION_STORE || path.join(process.env.HOME || "/tmp", ".openclaw-cli-bridge", "state.db");
  loadSessionStore(log);

  if (!API_TOKEN) log.warn("[cli-bridge] ⚠ apiToken not configured — API calls will fail");
  if (!CC_CHANNEL) log.warn("[cli-bridge] ⚠ callbackChannel not configured — results won't be delivered");

  // 核心：registerCommand — 零 token 直达，不经过 agent
  // /cc <问题> 主命令
  pluginApi.registerCommand({
    name: "cc",
    description: "远程控制 Claude Code（零 token，直达 task-api）",
    acceptsArgs: true,
    requireAuth: true,
    handler: handleCcCommand,
  });

  // 子命令：独立 ASCII 命名（框架要求命令名只能是字母数字连字符下划线）
  const subcommands = [
    { name: "cc-recent", inject: "最近", desc: "查看最近 CC 会话" },
    { name: "cc-now", inject: "当前", desc: "查看当前 CC 会话" },
    { name: "cc-new", inject: "新会话", desc: "重置 CC 会话（可附带问题）" },
    { name: "cc-resume", inject: "接续", desc: "手动续接指定 CC 会话" },
  ];
  for (const sub of subcommands) {
    pluginApi.registerCommand({
      name: sub.name,
      description: sub.desc,
      acceptsArgs: true,
      requireAuth: true,
      handler: (ctx: any) => handleCcCommand({ ...ctx, args: `${sub.inject} ${ctx.args || ""}`.trim() }),
    });
  }

  pluginApi.registerCommand({
    name: "cli-state",
    description: "查看 openclaw-tunnel 当前频道绑定和持久化状态",
    acceptsArgs: true,
    requireAuth: true,
    handler: handleStateCommand,
  });

  pluginApi.registerTool({
    name: "cli_bridge_state",
    label: "Inspect CLI Bridge State",
    description:
      "Read-only view into persisted CLI Bridge session bindings. " +
      "Use this when you need to inspect current cc session mappings without mutating anything.",
    parameters: {
      type: "object" as const,
      properties: {
        channel: {
          type: "string" as const,
          description: "Channel ID to inspect. Omit to inspect the default channel binding.",
        },
      },
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const channelKey = typeof params.channel === "string" && params.channel.trim()
        ? params.channel.trim()
        : "default";
      return text(formatStateText(channelKey));
    },
  }, { optional: true });

  log.info("openclaw-tunnel plugin loaded — /cc command ready");
}

export default { register };
