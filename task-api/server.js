/**
 * 本地任务 API 服务
 * 运行在 Docker control plane 中，配合 local runner / reconciler 使用
 */

import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const app = express();

app.use(express.json({ limit: '5mb' }));

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// ========== 配置 ==========
const AUTH_TOKEN = process.env.WORKER_TOKEN || 'change-me-to-a-secure-token';
const PORT = process.env.WORKER_PORT || 3456;
const DEFAULT_TASK_TIMEOUT_MS = 30000;
const DEFAULT_POLL_WAIT_MS = 30000;
const MAX_POLL_WAIT_MS = 60000;
const MIN_TASK_TIMEOUT_MS = 1000;
const MAX_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const TASK_DB_PATH = process.env.WORKER_TASK_DB || '/data/tasks.db';
const CALLBACK_API_BASE_URL = process.env.CALLBACK_API_BASE_URL || process.env.DISCORD_API_BASE_URL || 'https://discord.com/api/v10';
const TASK_EXPIRE_MS = parseBoundedInt(process.env.WORKER_TASK_RETENTION_MS, 20 * 60 * 1000, {
  min: 60 * 1000,
  max: 7 * 24 * 60 * 60 * 1000,
});
const RESULT_EXPIRE_MS = parseBoundedInt(process.env.WORKER_RESULT_RETENTION_MS, 30 * 60 * 1000, {
  min: 60 * 1000,
  max: 7 * 24 * 60 * 60 * 1000,
});
const SESSION_EXPIRE_MS = parseBoundedInt(process.env.WORKER_SESSION_RETENTION_MS, 30 * 60 * 1000, {
  min: 60 * 1000,
  max: 30 * 24 * 60 * 60 * 1000,
});

// 启动强检（学自 Star-Office-UI security_utils）：弱 token 直接拒绝启动，不 warn 继续跑
if (!AUTH_TOKEN || AUTH_TOKEN === 'change-me-to-a-secure-token' || AUTH_TOKEN.length < 16) {
  console.error('❌ FATAL: WORKER_TOKEN 未设置或过弱（需 ≥16 位，不能用默认值）');
  console.error('   请在 docker-compose.yml 或 .env 中设置 WORKER_TOKEN');
  process.exit(1);
}

// ========== 持久化任务状态 ==========
let taskDb = null;

// ========== 认证中间件 ==========
function parseBearerToken(headerValue) {
  if (typeof headerValue !== 'string') return '';
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function parseBoundedInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalString(value) {
  const trimmed = normalizeString(value);
  return trimmed || null;
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeOptionalString(value);
  return normalized && allowed.has(normalized) ? normalized : fallback;
}

function parseTaskTimeout(value, fallback) {
  return parseBoundedInt(value, fallback, { min: MIN_TASK_TIMEOUT_MS, max: MAX_TASK_TIMEOUT_MS });
}

function previewText(text, max = 50) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function extractDispatchMeta(body, defaultEntrypoint) {
  return {
    origin: normalizeOptionalString(body?.origin) || 'unknown',
    dispatchMode: normalizeEnum(body?.dispatchMode, new Set(['direct-command', 'agent-tool']), 'unspecified'),
    responseMode: normalizeEnum(body?.responseMode, new Set(['direct-callback']), 'direct-callback'),
    entrypoint: normalizeOptionalString(body?.entrypoint) || defaultEntrypoint,
  };
}


function getTaskDb() {
  if (taskDb) return taskDb;

  fs.mkdirSync(path.dirname(TASK_DB_PATH), { recursive: true });
  taskDb = new DatabaseSync(TASK_DB_PATH);
  taskDb.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      session_key TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_results (
      task_id TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS active_sessions (
      session_id TEXT PRIMARY KEY,
      cli_type TEXT NOT NULL,
      callback_channel TEXT,
      task_count INTEGER NOT NULL,
      last_activity INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at ON tasks(status, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_tasks_session_key_status ON tasks(session_key, status, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at ASC);
    CREATE INDEX IF NOT EXISTS idx_task_results_created_at ON task_results(created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_active_sessions_last_activity ON active_sessions(last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_active_sessions_cli_type ON active_sessions(cli_type, last_activity DESC);
  `);
  return taskDb;
}

function safeParseJson(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function deriveTaskType(task) {
  return normalizeOptionalString(task?.type) || 'command';
}

function deriveSessionKey(task) {
  if (!task?.sessionId) return null;
  const type = deriveTaskType(task);
  if (type !== 'claude-cli') {
    return null;
  }
  return `${type}:${task.sessionId}`;
}

function hydrateTaskRow(row) {
  if (!row) return null;
  const payload = safeParseJson(row.payload_json, {});
  return {
    ...payload,
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? payload.startedAt ?? null,
    completedAt: row.completed_at ?? payload.completedAt ?? null,
  };
}

function saveTask(task) {
  const db = getTaskDb();
  const type = deriveTaskType(task);
  const sessionKey = deriveSessionKey({ ...task, type });
  const updatedAt = Date.now();
  db.prepare(`
    INSERT INTO tasks (
      id, type, status, session_key, payload_json,
      created_at, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      status = excluded.status,
      session_key = excluded.session_key,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at
  `).run(
    task.id,
    type,
    task.status,
    sessionKey,
    JSON.stringify({ ...task, type }),
    task.createdAt,
    task.startedAt ?? null,
    task.completedAt ?? null,
    updatedAt,
  );
  return { ...task, type };
}

function saveTaskResult(taskId, result) {
  getTaskDb().prepare(`
    INSERT INTO task_results (task_id, result_json, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      result_json = excluded.result_json,
      created_at = excluded.created_at
  `).run(taskId, JSON.stringify(result), Date.now());
}

function getTask(taskId) {
  const row = getTaskDb().prepare(`
    SELECT id, type, status, payload_json, created_at, started_at, completed_at
    FROM tasks
    WHERE id = ?
  `).get(taskId);
  return hydrateTaskRow(row);
}

function getTaskResult(taskId) {
  const row = getTaskDb().prepare(`
    SELECT result_json
    FROM task_results
    WHERE task_id = ?
  `).get(taskId);
  return row ? safeParseJson(row.result_json, null) : null;
}

function getQueueStats() {
  const db = getTaskDb();
  const taskRows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM tasks
    GROUP BY status
  `).all();
  const resultRow = db.prepare(`SELECT COUNT(*) AS count FROM task_results`).get();
  const tasksByStatus = Object.fromEntries(
    taskRows.map((row) => [row.status, Number(row.count || 0)]),
  );
  const totalTasks = Object.values(tasksByStatus).reduce((sum, value) => sum + Number(value || 0), 0);

  return {
    total: totalTasks,
    byStatus: tasksByStatus,
    unconsumedResults: Number(resultRow?.count || 0),
    path: TASK_DB_PATH,
  };
}

function getSessionCliType(taskType) {
  if (taskType === 'claude-cli') return 'claude';
  return 'unknown';
}

function touchSession(sessionId, {
  cliType = 'unknown',
  callbackChannel = null,
  incrementTaskCount = false,
  timestamp = Date.now(),
} = {}) {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) return null;

  const db = getTaskDb();
  const existing = db.prepare(`
    SELECT task_count, callback_channel, created_at
    FROM active_sessions
    WHERE session_id = ?
  `).get(normalizedSessionId);
  const nextTaskCount = Number(existing?.task_count || 0) + (incrementTaskCount ? 1 : 0);
  const nextCallbackChannel = normalizeOptionalString(callbackChannel) || existing?.callback_channel || null;
  const createdAt = existing?.created_at || timestamp;

  db.prepare(`
    INSERT INTO active_sessions (
      session_id, cli_type, callback_channel, task_count,
      last_activity, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      cli_type = excluded.cli_type,
      callback_channel = COALESCE(excluded.callback_channel, active_sessions.callback_channel),
      task_count = excluded.task_count,
      last_activity = excluded.last_activity,
      updated_at = excluded.updated_at
  `).run(
    normalizedSessionId,
    cliType,
    nextCallbackChannel,
    nextTaskCount,
    timestamp,
    createdAt,
    timestamp,
  );

  return {
    sessionId: normalizedSessionId,
    cliType,
    callbackChannel: nextCallbackChannel,
    taskCount: nextTaskCount,
    lastActivity: timestamp,
    createdAt,
  };
}

function listActiveSessions({ limit = 50, cliType = null } = {}) {
  const params = [];
  const where = [];
  if (cliType) {
    where.push('cli_type = ?');
    params.push(cliType);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = getTaskDb().prepare(`
    SELECT session_id, cli_type, callback_channel, task_count, last_activity, created_at
    FROM active_sessions
    ${whereClause}
    ORDER BY last_activity DESC
    LIMIT ?
  `).all(...params, limit);

  return rows.map((row) => ({
    sessionId: row.session_id,
    cliType: row.cli_type,
    callbackChannel: row.callback_channel,
    taskCount: Number(row.task_count || 0),
    lastActivity: Number(row.last_activity || 0),
    createdAt: Number(row.created_at || 0),
  }));
}

function getSessionStats() {
  const db = getTaskDb();
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count, MIN(last_activity) AS oldest_last_activity, MAX(last_activity) AS newest_last_activity
    FROM active_sessions
  `).get();
  const byTypeRows = db.prepare(`
    SELECT cli_type, COUNT(*) AS count
    FROM active_sessions
    GROUP BY cli_type
    ORDER BY count DESC, cli_type ASC
  `).all();
  return {
    path: TASK_DB_PATH,
    active: Number(totalRow?.count || 0),
    oldestLastActivity: totalRow?.oldest_last_activity ?? null,
    newestLastActivity: totalRow?.newest_last_activity ?? null,
    retentionMs: SESSION_EXPIRE_MS,
    byType: byTypeRows.map((row) => ({
      cliType: row.cli_type,
      count: Number(row.count || 0),
    })),
  };
}

function cleanupExpiredSessions() {
  const cutoff = Date.now() - SESSION_EXPIRE_MS;
  const deleted = getTaskDb().prepare(`
    DELETE FROM active_sessions
    WHERE last_activity < ?
  `).run(cutoff).changes;
  return deleted;
}

function resetStaleRunningTasks() {
  const db = getTaskDb();
  const now = Date.now();
  const staleRows = db.prepare(`
    SELECT id, payload_json
    FROM tasks
    WHERE status = 'running'
  `).all();

  for (const row of staleRows) {
    const task = hydrateTaskRow({
      ...row,
      type: safeParseJson(row.payload_json, {}).type || 'command',
      status: 'running',
      created_at: safeParseJson(row.payload_json, {}).createdAt || now,
      started_at: safeParseJson(row.payload_json, {}).startedAt || null,
      completed_at: null,
    });
    if (!task) continue;
    task.status = 'pending';
    task.startedAt = null;
    saveTask(task);
  }

  return staleRows.length;
}


function enqueueTask(payload) {
  const task = saveTask({
    id: crypto.randomUUID(),
    status: 'pending',
    createdAt: Date.now(),
    ...payload
  });
  return task;
}

function getSerializedSessionKey(task) {
  return deriveSessionKey(task);
}

function consumeTaskResult(taskId) {
  const result = getTaskResult(taskId);
  if (!result) return null;
  const db = getTaskDb();
  db.prepare(`DELETE FROM task_results WHERE task_id = ?`).run(taskId);
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
  return result;
}

function claimNextPendingTask() {
  const db = getTaskDb();
  const rows = db.prepare(`
    SELECT id, type, status, payload_json, created_at, started_at, completed_at
    FROM tasks
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `).all();

  for (const row of rows) {
    const task = hydrateTaskRow(row);
    if (!task) continue;

    const sessionKey = getSerializedSessionKey(task);
    if (sessionKey) {
      const runningSibling = db.prepare(`
        SELECT id
        FROM tasks
        WHERE status = 'running' AND session_key = ? AND id != ?
        LIMIT 1
      `).get(sessionKey, task.id);
      if (runningSibling) continue;
    }

    task.status = 'running';
    task.startedAt = Date.now();
    saveTask(task);
    console.log(`[Worker] Picked up: ${task.id}`);
    return task;
  }

  return null;
}

async function loadSessionModules() {
  const [fs, path, readline] = await Promise.all([
    import('fs'),
    import('path'),
    import('readline'),
  ]);
  return {
    fs: fs.default,
    path: path.default,
    readline: readline.default,
  };
}

function parseRecentLimit(value) {
  return parseBoundedInt(value, 10, { min: 1, max: 20 });
}

function extractUserText(content) {
  if (Array.isArray(content)) {
    const textBlock = content.find(item => item?.type === 'text' && typeof item.text === 'string');
    return textBlock?.text ? textBlock.text.slice(0, 150) : '';
  }
  if (typeof content === 'string') {
    return content.slice(0, 150);
  }
  return '';
}

async function extractSessionTopic(filePath, fs, readline, resolver) {
  let topic = '';
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    for await (const line of rl) {
      try {
        const parsed = JSON.parse(line);
        const candidate = resolver(parsed);
        if (candidate) {
          topic = candidate;
          break;
        }
      } catch {
        // skip malformed lines
      }
    }
    rl.close();
    stream.destroy();
  } catch {
    // skip unreadable files
  }
  return topic || '(no topic)';
}

function auth(req, res, next) {
  const token = parseBearerToken(req.headers['authorization']);
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  return next(err);
});

// ========== API 路由 ==========

// 健康检查
app.get('/health', (req, res) => {
  const queue = getQueueStats();
  const sessions = getSessionStats();
  res.json({
    status: 'ok',
    tasks: queue.total,
    results: queue.unconsumedResults,
    activeSessions: sessions.active,
    taskDb: {
      path: queue.path,
      byStatus: queue.byStatus,
      resultRetentionMs: RESULT_EXPIRE_MS,
      taskRetentionMs: TASK_EXPIRE_MS,
    },
    sessionDb: {
      path: sessions.path,
      retentionMs: sessions.retentionMs,
      byType: sessions.byType,
    },
  });
});


// [云端 OpenClaw 调用] 提交任务
app.post('/tasks', auth, (req, res) => {
  const { command, timeout = DEFAULT_TASK_TIMEOUT_MS } = req.body || {};
  const normalizedCommand = normalizeString(command);

  if (!normalizedCommand) {
    return res.status(400).json({ error: 'command is required' });
  }

  const task = enqueueTask({
    command: normalizedCommand,
    timeout: parseTaskTimeout(timeout, DEFAULT_TASK_TIMEOUT_MS)
  });
  console.log(`[Task] Created: ${task.id} - ${normalizedCommand}`);

  res.json({ taskId: task.id, message: 'Task created, waiting for reconciler' });
});


app.get('/sessions/state', auth, (req, res) => {
  const limit = parseBoundedInt(req.query.limit, 50, { min: 1, max: 500 });
  const cliType = normalizeOptionalString(req.query.cliType);
  res.json({
    sessions: listActiveSessions({ limit, cliType }),
  });
});

// [云端 OpenClaw 调用] 查询结果（带等待窗口）
app.get('/tasks/:taskId', auth, async (req, res) => {
  const { taskId } = req.params;
  const waitMs = parseBoundedInt(req.query.wait, 0, { min: 0, max: MAX_POLL_WAIT_MS }); // 最多等待多少毫秒

  const startTime = Date.now();

  // 等待窗口内检查结果
  while (Date.now() - startTime < waitMs) {
    const result = consumeTaskResult(taskId);
    if (result) {
      return res.json(result);
    }
    await new Promise(r => setTimeout(r, 500)); // 每 500ms 检查一次
  }

  // 超时或不等待，返回当前状态
  const result = consumeTaskResult(taskId);
  if (result) {
    return res.json(result);
  }

  const task = getTask(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  res.json({ status: task.status, message: 'Result not ready yet' });
});

// [本地 runner / reconciler 调用] 获取待执行任务（长连接领取）
app.get('/worker/poll', auth, async (req, res) => {
  const waitMs = parseBoundedInt(req.query.wait, DEFAULT_POLL_WAIT_MS, { min: 1000, max: MAX_POLL_WAIT_MS });

  // 先立即检查一次
  const initialTask = claimNextPendingTask();
  if (initialTask) {
    return res.json(initialTask);
  }

  // 长连接等待：hold 住连接，每 500ms 检查一次
  const startTime = Date.now();
  while (Date.now() - startTime < waitMs) {
    await new Promise(r => setTimeout(r, 500));
    const pendingTask = claimNextPendingTask();
    if (pendingTask) {
      return res.json(pendingTask);
    }
  }

  res.json(null); // 超时，没有任务
});

// [本地 Worker 调用] 上报结果
app.post('/worker/result', auth, (req, res) => {
  const { taskId, stdout, stderr, exitCode, error, metadata } = req.body || {};

  if (!taskId) {
    return res.status(400).json({ error: 'taskId is required' });
  }

  const result = {
    taskId,
    stdout: stdout || '',
    stderr: stderr || '',
    exitCode: exitCode ?? -1,
    error: error || null,
    completedAt: Date.now()
  };

  const task = getTask(taskId);
  const baseMetadata = {
    origin: task?.origin || 'unknown',
    dispatchMode: task?.dispatchMode || 'unspecified',
    responseMode: task?.responseMode || 'direct-callback',
    entrypoint: task?.entrypoint || null,
  };
  if (metadata || Object.values(baseMetadata).some(Boolean)) {
    result.metadata = {
      ...baseMetadata,
      ...(metadata || {}),
    };
  }
  if (task) {
    task.status = result.exitCode === 0 ? 'completed' : 'failed';
    task.completedAt = result.completedAt;
    saveTask(task);
  }

  saveTaskResult(taskId, result);
  console.log(`[Worker] Result: ${taskId} - exit ${exitCode}`);
  if (metadata?.screenshotPath) {
    console.log(`[Worker] Screenshot: ${metadata.screenshotPath}`);
  }

  // 更新会话跟踪
  if (metadata?.sessionId) {
    touchSession(metadata.sessionId, {
      cliType: getSessionCliType(task?.type),
      callbackChannel: task?.callbackChannel || null,
      incrementTaskCount: false,
      timestamp: Date.now(),
    });
  }

  res.json({ success: true });
});



// ========== Claude CLI API（调用本地 Claude Code） ==========

// [云端 OpenClaw 调用] 执行本地 Claude Code CLI
app.post('/claude', auth, (req, res) => {
  const { prompt, timeout = 120000, sessionId, callbackChannel, callbackBotToken } = req.body || {};
  const promptText = typeof prompt === 'string' ? prompt : '';
  const requestedSessionId = normalizeOptionalString(sessionId);
  const dispatchMeta = extractDispatchMeta(req.body, 'cc');

  if (!promptText.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // 自动生成 sessionId：确保每轮 CC 都有可追踪的 session，支持后续 --resume
  const effectiveSessionId = requestedSessionId || crypto.randomUUID();
  const task = enqueueTask({
    type: 'claude-cli',
    prompt: promptText,
    timeout: parseTaskTimeout(timeout, 120000),
    sessionId: effectiveSessionId,
    callbackChannel: normalizeOptionalString(callbackChannel),
    callbackBotToken: normalizeOptionalString(callbackBotToken),
    ...dispatchMeta,
  });

  // 更新会话跟踪
  touchSession(effectiveSessionId, {
    cliType: 'claude',
    callbackChannel: task.callbackChannel,
    incrementTaskCount: true,
    timestamp: Date.now(),
  });

  const isResume = Boolean(requestedSessionId);
  console.log(`[Claude] Task: ${task.id} [mode:${task.dispatchMode}] [session:${effectiveSessionId.slice(0, 8)}${isResume ? ',resume' : ',new'}]${task.callbackChannel ? ' [callback:' + task.callbackChannel + ']' : ''}${task.entrypoint ? ' [via:' + task.entrypoint + ']' : ''} - ${previewText(promptText)}`);

  res.json({ taskId: task.id, sessionId: effectiveSessionId, message: 'Claude CLI task created' });
});


// ========== Bot callback push (current compatibility path defaults to Discord API) ==========

// 让 bridge / hook 通过 task-api 代发 bot callback（当前默认兼容 Discord channel message API）
app.post('/notify', auth, async (req, res) => {
  const channel = normalizeString(req.body?.channel);
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  if (!channel || !message.trim()) {
    return res.status(400).json({ error: 'channel and message are required' });
  }
  const callbackBotToken = process.env.CALLBACK_BOT_TOKEN;
  if (!callbackBotToken) {
    return res.status(500).json({ error: 'CALLBACK_BOT_TOKEN not set' });
  }
  try {
    const callbackApiBase = CALLBACK_API_BASE_URL.endsWith('/') ? CALLBACK_API_BASE_URL : `${CALLBACK_API_BASE_URL}/`;
    const callbackUrl = new URL(`channels/${channel}/messages`, callbackApiBase).toString();
    const resp = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${callbackBotToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: message.slice(0, 2000) }),
    });
    if (resp.ok) {
      res.json({ ok: true });
    } else {
      const text = await resp.text();
      res.status(502).json({ error: `Callback API ${resp.status}: ${text}` });
    }
  } catch (err) {
    res.status(502).json({ error: errorMessage(err) });
  }
});

// ========== 会话管理 API ==========

// [云端 OpenClaw 调用] 列出活跃会话
app.get('/claude/sessions', auth, (req, res) => {
  const sessions = listActiveSessions({ limit: 200, cliType: 'claude' }).map((session) => ({
    sessionId: session.sessionId,
    lastActivity: session.lastActivity,
    taskCount: session.taskCount,
    callbackChannel: session.callbackChannel,
  }));
  res.json({ sessions });
});

// [本地调用] 列出最近的 CC 会话（含话题摘要）
app.get('/claude/recent', auth, async (req, res) => {
  const limit = parseRecentLimit(req.query.limit);
  const { fs, path, readline } = await loadSessionModules();

  // 扫描 CC session 文件（容器内挂载路径，宿主机 ~/.claude/projects）
  const projectsDir = '/host-claude-projects';
  const sessions = [];

  try {
    const projectDirs = fs.readdirSync(projectsDir).filter(d =>
      fs.statSync(path.join(projectsDir, d)).isDirectory()
    );

    for (const dir of projectDirs) {
      const fullDir = path.join(projectsDir, dir);
      const files = fs.readdirSync(fullDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fp = path.join(fullDir, f);
          const stat = fs.statSync(fp);
          return { file: f, path: fp, mtime: stat.mtimeMs, size: stat.size, project: dir };
        });
      sessions.push(...files);
    }
  } catch (e) {
    return res.json({ sessions: [], error: errorMessage(e) });
  }

  // 按修改时间倒序，取最近 N 个
  sessions.sort((a, b) => b.mtime - a.mtime);
  const recent = sessions.slice(0, limit);

  // 提取每个会话的第一条 user 消息作为话题
  const results = [];
  for (const s of recent) {
    const topic = await extractSessionTopic(s.path, fs, readline, (record) => {
      if (record.message?.role !== 'user') return '';
      return extractUserText(record.message.content);
    });

    results.push({
      sessionId: s.file.replace('.jsonl', ''),
      project: s.project,
      lastModified: new Date(s.mtime).toISOString(),
      sizeKB: Math.round(s.size / 1024),
      topic,
    });
  }

  res.json({ sessions: results });
});


// ========== 清理过期任务 ==========
setInterval(() => {
  const now = Date.now();
  const db = getTaskDb();
  const expiredResults = db.prepare(`
    SELECT t.id
    FROM tasks t
    INNER JOIN task_results r ON r.task_id = t.id
    WHERE r.created_at < ?
  `).all(now - RESULT_EXPIRE_MS);
  for (const row of expiredResults) {
    db.prepare(`DELETE FROM task_results WHERE task_id = ?`).run(row.id);
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(row.id);
    console.log(`[Cleanup] Result expired (unfetched): ${row.id}`);
  }

  const expiredTasks = db.prepare(`
    SELECT id
    FROM tasks
    WHERE id NOT IN (SELECT task_id FROM task_results)
      AND created_at < ?
  `).all(now - TASK_EXPIRE_MS);
  for (const row of expiredTasks) {
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(row.id);
    console.log(`[Cleanup] Task expired (no result): ${row.id}`);
  }

  cleanupExpiredSessions();
}, 60000);

// ========== 启动 ==========
app.listen(PORT, '0.0.0.0', () => {
  const requeued = resetStaleRunningTasks();
  const queue = getQueueStats();
  console.log(`✅ Task API running on :${PORT}`);
  console.log(`   Token : ${AUTH_TOKEN.slice(0, 4)}${'*'.repeat(AUTH_TOKEN.length - 4)}`);
  console.log(`   Notify: ${process.env.CALLBACK_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN ? '✓ CALLBACK_BOT_TOKEN/DISCORD_BOT_TOKEN set' : '✗ no CALLBACK_BOT_TOKEN or DISCORD_BOT_TOKEN'}`);
  console.log(`   Tasks : ${TASK_DB_PATH} | total=${queue.total} | results=${queue.unconsumedResults}`);
  if (requeued > 0) {
    console.log(`   Requeue: reset ${requeued} stale running task(s) to pending`);
  }
});
