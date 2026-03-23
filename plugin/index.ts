/**
 * CLI Bridge — OpenClaw Plugin
 *
 * Architecture (inspired by HappyClaw):
 * - /cc commands are registered via registerCommand — zero agent tokens, zero noise
 * - CC results are pushed directly to the callback channel by the worker (Discord Bot API compatible), bypassing agent formatting
 * - cc_call and similar tools are reserved for agents in other channels
 *
 * Usage (any channel):
 *   /cc <prompt>        → Submit a CC task (auto-resumes previous session)
 *   /cc-recent          → List recent sessions
 *   /cc-now             → Show current session
 *   /cc-new             → Reset session
 *   /cc-new <prompt>    → Reset and immediately submit a prompt
 *   /cc-resume <id> <prompt> → Manually resume a specific session
 *
 * Framework constraint: matchPluginCommand splits on whitespace between command name and args,
 * so /cc最近 (no space) won't match /cc and falls through to the agent.
 * Solution: subcommands use standalone ASCII names (cc-recent, etc.), following the HappyClaw pattern.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---- Runtime config (injected by register() from pluginConfig) ----
let API_URL = "";
let API_TOKEN = "";
let CC_CHANNEL = "";
let CALLBACK_BOT_TOKEN = "";
let SESSION_STORE_PATH = path.join(process.env.HOME || "/tmp", ".openclaw-cli-bridge", "state.db");
let sessionDb: DatabaseSync | null = null;

type DispatchMode = "direct-command" | "agent-tool";

type SessionStoreData = {
  version: 1;
  channelSessions: Record<string, string>;
  cliSessions: Record<string, string>;
};

type SessionBindingRow = {
  scope: "cc" | "codex" | "gemini";
  key: string;
  sessionId: string;
};

// ---- Tool result helper ----
function text(data: unknown) {
  const t = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: t }] };
}

// ---- API request helper ----
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

// ---- Session tracking (isolated per channel, each channel has its own session) ----
const channelSessions = new Map<string, string>();
const cliSessions = new Map<string, string>(); // "endpoint:channelKey" → sessionId

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

    clearScope.run("cli");
    for (const [key, value] of cliSessions.entries()) {
      upsert.run("cli", key, value, now);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn?.(`[cli-bridge] session store save failed: ${message}`);
  }
}

function loadSessionStore(log: { warn?: (msg: string) => void; info?: (msg: string) => void }) {
  channelSessions.clear();
  cliSessions.clear();

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
      } else if (row.scope === "cli") {
        cliSessions.set(row.session_key, row.session_value);
      }
    }
    log.info?.(`[cli-bridge] session store loaded: cc=${channelSessions.size}, cli=${cliSessions.size}`);
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
    codex: cliSessions.get(`/codex:${channelKey}`) || null,
    gemini: cliSessions.get(`/gemini:${channelKey}`) || null,
  };

  const bindings: SessionBindingRow[] = [];
  for (const [key, sessionId] of channelSessions.entries()) {
    bindings.push({ scope: "cc", key, sessionId });
  }
  for (const [key, sessionId] of cliSessions.entries()) {
    if (key.startsWith("/codex:")) {
      bindings.push({ scope: "codex", key: key.slice("/codex:".length), sessionId });
    } else if (key.startsWith("/gemini:")) {
      bindings.push({ scope: "gemini", key: key.slice("/gemini:".length), sessionId });
    }
  }

  return {
    sessionStorePath: SESSION_STORE_PATH,
    current,
    counts: {
      cc: channelSessions.size,
      cli: cliSessions.size,
      total: channelSessions.size + cliSessions.size,
    },
    bindings,
  };
}

function formatStateText(channelKey: string, includeAll: boolean) {
  const state = collectSessionBindings(channelKey);
  const lines = [
    "CLI Bridge Status",
    "",
    `Current channel: \`${channelKey}\``,
    `sessionStore: \`${state.sessionStorePath}\``,
    `Direct mode: yes`,
    `Delegated mode: only used when planning/orchestration is needed`,
    "",
    "Current bindings:",
    `- CC: ${state.current.cc ? `\`${state.current.cc}\`` : "none"}`,
    `- Codex: ${state.current.codex ? `\`${state.current.codex}\`` : "none"}`,
    `- Gemini: ${state.current.gemini ? `\`${state.current.gemini}\`` : "none"}`,
    "",
    `Total bindings: CC ${state.counts.cc} / CLI ${state.counts.cli} / All ${state.counts.total}`,
  ];

  if (includeAll) {
    const recent = state.bindings.slice(0, 20);
    lines.push("");
    lines.push(`Recent bindings (up to 20, ${state.bindings.length} total):`);
    if (recent.length === 0) {
      lines.push("- none");
    } else {
      for (const row of recent) {
        lines.push(`- ${row.scope} | ${row.key} | \`${row.sessionId}\``);
      }
    }
  }

  return lines.join("\n");
}

async function handleStateCommand(ctx: any): Promise<{ text: string; isError?: boolean }> {
  const includeAll = /^(all|全部|全部绑定)$/i.test((ctx.args || "").trim());
  return {
    text: formatStateText(getCurrentChannelKey(ctx), includeAll),
  };
}

// ---- /cc command handler ----
async function handleCcCommand(ctx: any): Promise<{ text: string; isError?: boolean }> {
  const log = (globalThis as any).__cliBridgeLog ?? console;
  let args = (ctx.args || "").trim();

  // Channel key: sessions are isolated per channel
  const channelKey = getCurrentChannelKey(ctx);
  const lastSessionId = channelSessions.get(channelKey) || null;

  log.info(`[cli-bridge] handler called | args="${args}" | channel=${channelKey.slice(0, 8)} | session=${lastSessionId?.slice(0, 8) || 'none'}`);

  // Empty command → show help
  if (!args) {
    const session = lastSessionId ? `Current session: \`${lastSessionId}\`` : "No active session";
    return {
      text: `📋 CLI Bridge commands:
/cc <prompt> — Submit a task (auto-resumes in the same channel, no need to pass an ID)
/cc-new — Start a fresh session
/cc-new <prompt> — Start a fresh session and submit a prompt immediately
/cc-recent — List recent sessions
/cc-now — Show current session ID
/cc-resume <id> <prompt> — Switch to a specific session and continue

💡 Consecutive /cc calls in the same channel share the same session
${session}`
    };
  }

  // /cc recent → list recent sessions
  if (/^(最近|recent)/i.test(args)) {
    log.info("[cli-bridge] /cc-recent: listing sessions");
    try {
      const res = await api("GET", "/claude/recent?limit=8");
      if (!res.ok) return { text: "❌ Query failed", isError: true };
      const data = await res.json() as { sessions: Array<{ sessionId: string; lastModified: string; sizeKB: number; topic: string }> };
      if (!data.sessions?.length) return { text: "No recent CC sessions found." };

      const lines = data.sessions.map((s: any, i: number) => {
        const time = new Date(s.lastModified).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
        const topic = (s.topic || "(no topic)").replace(/\s+/g, " ").trim().slice(0, 50) + (s.topic?.length > 50 ? "…" : "");
        return `${i + 1}. ${topic}\n   \`${s.sessionId}\` | ${time} | ${s.sizeKB}KB`;
      });
      const current = lastSessionId ? `\nCurrent: \`${lastSessionId}\`` : "\nNo active session";
      return { text: "📋 Recent CC sessions\n\n" + lines.join("\n\n") + current };
    } catch (err: unknown) {
      return { text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  // /cc now → show current session
  if (/^(当前|现在|session$)/i.test(args)) {
    return {
      text: lastSessionId
        ? `Current session: \`${lastSessionId}\``
        : "No active session. Send /cc <prompt> to start a new one."
    };
  }

  // /cc new [prompt] → reset session + optionally submit a prompt
  if (/^(新会话|new)/i.test(args)) {
    deleteSession(channelSessions, channelKey, log);
    const prompt = args.replace(/^(新会话|new)\s*/i, "").trim();
    if (!prompt) {
      log.info("[cli-bridge] /cc-new: session reset");
      return { text: "🔄 Session reset. Next /cc will start a new session." };
    }
    args = prompt;
  }

  // /cc resume <sessionId> [prompt] → manually specify a session
  const resumeMatch = args.match(/^接续\s+([a-f0-9-]{8,})\s*(.*)/i);
  if (resumeMatch) {
    setSession(channelSessions, channelKey, resumeMatch[1], log);
    const prompt = resumeMatch[2].trim();
    log.info(`[cli-bridge] /cc-resume: session=${resumeMatch[1].slice(0, 8)}`);
    if (!prompt) {
      return { text: `🔗 Switched to session \`${resumeMatch[1]}\`\nNext /cc <prompt> will continue in this session.` };
    }
    args = prompt;
  }

  // Default: submit a CC task
  const prompt = args;
  const currentSession = channelSessions.get(channelKey) || null;

  // Callback channel: respond in the same channel the request came from
  const callback = channelKey !== "default" ? channelKey : CC_CHANNEL;
  log.info(`[cli-bridge] /cc submit: "${prompt.slice(0, 50)}..."${currentSession ? ' [session:' + currentSession.slice(0, 8) + ']' : ' [new session]'} → callback:${callback.slice(0, 8)}`);

  const body: Record<string, unknown> = {
    ...buildTaskBody(prompt, 1200000, callback, "direct-command", "cc"),
  };
  if (currentSession) body.sessionId = currentSession;

  try {
    const res = await api("POST", "/claude", body);
    if (!res.ok) {
      const errText = await res.text();
      log.error(`[cli-bridge] submit failed: ${res.status} ${errText}`);
      return { text: `❌ Submit failed: ${res.status}`, isError: true };
    }

    const data = await res.json() as { taskId: string; sessionId: string };
    setSession(channelSessions, channelKey, data.sessionId, log);
    log.info(`[cli-bridge] submitted: task=${data.taskId.slice(0, 8)}, session=${data.sessionId.slice(0, 8)}`);
    return { text: "" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[cli-bridge] submit error: ${msg}`);
    return { text: `❌ Cannot connect to task-api: ${msg}`, isError: true };
  }
}

// ---- Generic handler for /codex and /gemini (with session resumption) ----

async function handleGenericCLI(
  ctx: any,
  endpoint: string,
  label: string,
): Promise<{ text: string; isError?: boolean }> {
  const log = (globalThis as any).__cliBridgeLog ?? console;
  let prompt = (ctx.args || "").trim();

  const channelKey = getCurrentChannelKey(ctx);
  const sessionKey = `${endpoint}:${channelKey}`;
  let currentSession = cliSessions.get(sessionKey) || null;

  if (/^(当前|现在|session)$/i.test(prompt)) {
    return {
      text: currentSession
        ? `${label} current session: \`${currentSession}\``
        : `${label} has no active session. Send /${label.toLowerCase()} <prompt> to start a new one.`,
    };
  }

  // /codex new / /gemini new → reset session
  if (/^(新会话|new)/i.test(prompt)) {
    deleteSession(cliSessions, sessionKey, log);
    currentSession = null;
    prompt = prompt.replace(/^(新会话|new)\s*/i, "").trim();
    if (!prompt) {
      return { text: `🔄 ${label} session reset. Next prompt will start a new session.` };
    }
  }

  // /codex resume <sessionId> [prompt] → manually specify a session
  const resumeMatch = prompt.match(/^接续\s+([a-f0-9-]{8,})\s*(.*)/i);
  if (resumeMatch) {
    setSession(cliSessions, sessionKey, resumeMatch[1], log);
    currentSession = resumeMatch[1];
    log.info(`[cli-bridge] /${label.toLowerCase()} resume: session=${resumeMatch[1].slice(0, 8)}`);
    prompt = resumeMatch[2].trim();
    if (!prompt) {
      return { text: `🔗 Switched to ${label} session \`${resumeMatch[1]}\`\nNext /${label.toLowerCase()} <prompt> will continue in this session.` };
    }
  }

  if (!prompt) {
    return {
      text: currentSession
        ? `${label} current session: \`${currentSession}\`\nSend /${label.toLowerCase()} <prompt> to continue\nSend /${label.toLowerCase()} new to reset\nSend /${label.toLowerCase()} resume <sessionId> to restore manually`
        : `Usage: /${label.toLowerCase()} <prompt>`
    };
  }

  const callback = channelKey !== "default" ? channelKey : CC_CHANNEL;
  log.info(`[cli-bridge] /${label.toLowerCase()} submit: "${prompt.slice(0, 50)}..."${currentSession ? ' [session:' + currentSession.slice(0, 8) + ']' : ' [new session]'} → callback:${callback.slice(0, 8)}`);

  const body: Record<string, unknown> = {
    ...buildTaskBody(prompt, 300000, callback, "direct-command", label.toLowerCase()),
  };
  if (currentSession) {
    body.sessionId = currentSession;
    if (endpoint === "/gemini") body.resumeLatest = true;
  }

  try {
    const res = await api("POST", endpoint, body);
    if (!res.ok) {
      const errText = await res.text();
      log.error(`[cli-bridge] ${label} submit failed: ${res.status} ${errText}`);
      return { text: `❌ ${label} submit failed: ${res.status}`, isError: true };
    }

    const data = await res.json() as { taskId: string; sessionId?: string };
    if (data.sessionId) {
      setSession(cliSessions, sessionKey, data.sessionId, log);
      log.info(`[cli-bridge] ${label} session bound: ${data.sessionId.slice(0, 8)}`);
    }
    log.info(`[cli-bridge] ${label} submitted: task=${data.taskId.slice(0, 8)}`);

    return { text: "" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[cli-bridge] ${label} submit error: ${msg}`);
    return { text: `❌ Cannot connect to task-api: ${msg}`, isError: true };
  }
}

// ---- cc_call tool (for agents in other channels) ----
const ccCallTool = {
  name: "cc_call",
  label: "Call Claude Code",
  description:
    "Submit a task to Claude Code via task-api. Returns immediately. " +
    "CC's output will be delivered DIRECTLY to the callback channel via callback (not through you). " +
    "IMPORTANT: Always pass 'channel' so the result is delivered to the CURRENT channel. " +
    "For NEW tasks: provide 'prompt' and 'channel'. " +
    "For FOLLOW-UP in an existing session: also provide 'sessionId'. " +
    "After calling this tool, tell the user 'Submitted, waiting for CC callback' and STOP.",
  parameters: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string" as const,
        description: "The task or message to send to Claude Code",
      },
      channel: {
        type: "string" as const,
        description: "Callback channel ID where the result should be delivered (use the current channel ID)",
      },
      sessionId: {
        type: "string" as const,
        description: "Session ID from a previous cc_call (omit for new tasks)",
      },
      timeout: {
        type: "number" as const,
        description: "Timeout in ms (default: 1200000 = 20 min)",
      },
    },
    required: ["prompt"],
  },
  async execute(_id: string, params: Record<string, unknown>) {
    const callback = (params.channel as string) || CC_CHANNEL;
    const body: Record<string, unknown> = {
      ...buildTaskBody(
        String(params.prompt ?? ""),
        (params.timeout as number) || 1200000,
        callback,
        "agent-tool",
        "cc_call",
      ),
    };
    if (params.sessionId) body.sessionId = params.sessionId;

    try {
      const res = await api("POST", "/claude", body);
      if (!res.ok) return text(`❌ ${res.status} ${await res.text()}`);
      await res.json();
      return text("✓");
    } catch (err: unknown) {
      return text(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---- codex_call tool (agent delegates to Codex CLI) ----
const codexCallTool = {
  name: "codex_call",
  label: "Call Codex CLI",
  description:
    "Submit a task to OpenAI Codex CLI via task-api. Returns immediately. " +
    "Codex's output will be delivered DIRECTLY to the callback channel via callback (not through you). " +
    "IMPORTANT: Always pass 'channel' so the result is delivered to the CURRENT channel. " +
    "After calling this tool, tell the user 'Submitted, waiting for Codex callback' and STOP.",
  parameters: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string" as const,
        description: "The task or message to send to Codex CLI",
      },
      channel: {
        type: "string" as const,
        description: "Callback channel ID where the result should be delivered (use the current channel ID)",
      },
      sessionId: {
        type: "string" as const,
        description: "Session ID from a previous codex_call (omit for new tasks)",
      },
      timeout: {
        type: "number" as const,
        description: "Timeout in ms (default: 300000 = 5 min)",
      },
    },
    required: ["prompt"],
  },
  async execute(_id: string, params: Record<string, unknown>) {
    const callback = (params.channel as string) || CC_CHANNEL;
    const body: Record<string, unknown> = {
      ...buildTaskBody(
        String(params.prompt ?? ""),
        (params.timeout as number) || 300000,
        callback,
        "agent-tool",
        "codex_call",
      ),
    };
    if (params.sessionId) body.sessionId = params.sessionId;

    try {
      const res = await api("POST", "/codex", body);
      if (!res.ok) return text(`❌ ${res.status} ${await res.text()}`);
      await res.json();
      return text("✓");
    } catch (err: unknown) {
      return text(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---- gemini_call tool (agent delegates to Gemini CLI) ----
const geminiCallTool = {
  name: "gemini_call",
  label: "Call Gemini CLI",
  description:
    "Submit a task to Google Gemini CLI via task-api. Returns immediately. " +
    "Gemini's output will be delivered DIRECTLY to the callback channel via callback (not through you). " +
    "IMPORTANT: Always pass 'channel' so the result is delivered to the CURRENT channel. " +
    "After calling this tool, tell the user 'Submitted, waiting for Gemini callback' and STOP.",
  parameters: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string" as const,
        description: "The task or message to send to Gemini CLI",
      },
      channel: {
        type: "string" as const,
        description: "Callback channel ID where the result should be delivered (use the current channel ID)",
      },
      sessionId: {
        type: "string" as const,
        description: "Logical session ID from a previous gemini_call (Gemini resumes the latest linked session under the hood)",
      },
      timeout: {
        type: "number" as const,
        description: "Timeout in ms (default: 300000 = 5 min)",
      },
    },
    required: ["prompt"],
  },
  async execute(_id: string, params: Record<string, unknown>) {
    const callback = (params.channel as string) || CC_CHANNEL;
    const body: Record<string, unknown> = {
      ...buildTaskBody(
        String(params.prompt ?? ""),
        (params.timeout as number) || 300000,
        callback,
        "agent-tool",
        "gemini_call",
      ),
    };
    if (params.sessionId) body.sessionId = params.sessionId;

    try {
      const res = await api("POST", "/gemini", body);
      if (!res.ok) return text(`❌ ${res.status} ${await res.text()}`);
      await res.json();
      return text("✓");
    } catch (err: unknown) {
      return text(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---- Plugin registration ----
export function register(pluginApi: any) {
  const log = pluginApi.log ?? console;
  (globalThis as any).__cliBridgeLog = log;

  // Read config from pluginConfig (openclaw.json → plugins.entries.cli-bridge)
  const cfg = pluginApi.pluginConfig ?? {};
  API_URL = cfg.apiUrl || "http://host.docker.internal:3456";
  API_TOKEN = cfg.apiToken || "";
  CC_CHANNEL = cfg.callbackChannel || cfg.defaultChannel || "";
  CALLBACK_BOT_TOKEN = cfg.callbackBotToken || "";
  SESSION_STORE_PATH = cfg.sessionStorePath || process.env.CLI_BRIDGE_SESSION_STORE || path.join(process.env.HOME || "/tmp", ".openclaw-cli-bridge", "state.db");
  loadSessionStore(log);

  if (!API_TOKEN) log.warn("[cli-bridge] ⚠ apiToken not configured — API calls will fail");
  if (!CC_CHANNEL) log.warn("[cli-bridge] ⚠ callbackChannel not configured — results won't be delivered");

  // Core: registerCommand — zero tokens, bypasses agent entirely
  // /cc <prompt> main command
  pluginApi.registerCommand({
    name: "cc",
    description: "Remote-control Claude Code (zero tokens, direct to task-api)",
    acceptsArgs: true,
    requireAuth: true,
    handler: handleCcCommand,
  });

  // Subcommands: standalone ASCII names (framework requires alphanumeric/hyphen/underscore names)
  const subcommands = [
    { name: "cc-recent", inject: "最近", desc: "List recent CC sessions" },
    { name: "cc-now", inject: "当前", desc: "Show current CC session" },
    { name: "cc-new", inject: "新会话", desc: "Reset CC session (optionally with a prompt)" },
    { name: "cc-resume", inject: "接续", desc: "Manually resume a specific CC session" },
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

  // /codex and /gemini commands (with session resumption)
  pluginApi.registerCommand({
    name: "codex",
    description: "Call OpenAI Codex CLI (direct mode, supports session resumption; /codex new to reset)",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => handleGenericCLI(ctx, "/codex", "Codex"),
  });
  for (const sub of [
    { name: "codex-now", inject: "当前", desc: "Show current Codex session" },
    { name: "codex-new", inject: "新会话", desc: "Reset Codex session (optionally with a prompt)" },
    { name: "codex-resume", inject: "接续", desc: "Manually resume a specific Codex session" },
  ]) {
    pluginApi.registerCommand({
      name: sub.name,
      description: sub.desc,
      acceptsArgs: true,
      requireAuth: true,
      handler: (ctx: any) => handleGenericCLI({ ...ctx, args: `${sub.inject} ${ctx.args || ""}`.trim() }, "/codex", "Codex"),
    });
  }

  pluginApi.registerCommand({
    name: "gemini",
    description: "Call Google Gemini CLI (direct mode; supports session resumption via resume-latest under the hood)",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => handleGenericCLI(ctx, "/gemini", "Gemini"),
  });
  for (const sub of [
    { name: "gemini-now", inject: "当前", desc: "Show current Gemini session" },
    { name: "gemini-new", inject: "新会话", desc: "Reset Gemini session (optionally with a prompt)" },
    { name: "gemini-resume", inject: "接续", desc: "Manually resume a specific Gemini session" },
  ]) {
    pluginApi.registerCommand({
      name: sub.name,
      description: sub.desc,
      acceptsArgs: true,
      requireAuth: true,
      handler: (ctx: any) => handleGenericCLI({ ...ctx, args: `${sub.inject} ${ctx.args || ""}`.trim() }, "/gemini", "Gemini"),
    });
  }

  pluginApi.registerCommand({
    name: "cli-state",
    description: "View CLI Bridge channel bindings and persisted state (append 'all' for global summary)",
    acceptsArgs: true,
    requireAuth: true,
    handler: handleStateCommand,
  });

  pluginApi.registerTool({
    name: "cli_bridge_state",
    label: "Inspect CLI Bridge State",
    description:
      "Read-only view into persisted CLI Bridge session bindings. " +
      "Use this when you need to inspect current cc/codex/gemini session mappings without mutating anything.",
    parameters: {
      type: "object" as const,
      properties: {
        channel: {
          type: "string" as const,
          description: "Channel ID to inspect. Omit to inspect the default channel binding.",
        },
        includeAll: {
          type: "boolean" as const,
          description: "Whether to include a recent global binding summary.",
        },
      },
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const channelKey = typeof params.channel === "string" && params.channel.trim()
        ? params.channel.trim()
        : "default";
      return text(formatStateText(channelKey, Boolean(params.includeAll)));
    },
  }, { optional: true });

  // Register tools for agents in other channels
  pluginApi.registerTool(ccCallTool, { optional: true });
  pluginApi.registerTool(codexCallTool, { optional: true });
  pluginApi.registerTool(geminiCallTool, { optional: true });

  log.info("[cli-bridge] Plugin registered: direct commands (/cc /codex /gemini) + delegated tools (cc_call / codex_call / gemini_call)");
}

export default { register };
