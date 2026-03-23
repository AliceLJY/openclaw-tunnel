/**
 * Local Task API Server
 * Runs in the Docker control plane, used with the local runner / reconciler
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

// ========== Configuration ==========
const AUTH_TOKEN = process.env.WORKER_TOKEN || 'change-me-to-a-secure-token';
const PORT = process.env.WORKER_PORT || 3456;
const DEFAULT_TASK_TIMEOUT_MS = 30000;
const DEFAULT_POLL_WAIT_MS = 30000;
const MAX_POLL_WAIT_MS = 60000;
const MIN_TASK_TIMEOUT_MS = 1000;
const MAX_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = parseBoundedInt(process.env.WORKER_MAX_EVENTS, 2000, { min: 100, max: 500000 });
const EVENT_RETENTION_DAYS = parseBoundedInt(process.env.WORKER_EVENT_RETENTION_DAYS, 14, { min: 1, max: 3650 });
const EVENT_DB_PATH = process.env.WORKER_EVENT_DB || '/data/events.db';
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

// Startup security check: reject weak tokens immediately instead of warning and continuing
if (!AUTH_TOKEN || AUTH_TOKEN === 'change-me-to-a-secure-token' || AUTH_TOKEN.length < 16) {
  console.error('❌ FATAL: WORKER_TOKEN is not set or too weak (must be >= 16 chars, cannot use default)');
  console.error('   Set WORKER_TOKEN in docker-compose.yml or .env');
  process.exit(1);
}

// ========== Persistent Task State ==========
let eventDb = null;
let taskDb = null;

// ========== Auth Middleware ==========
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

function getEventDb() {
  if (eventDb) return eventDb;

  fs.mkdirSync(path.dirname(EVENT_DB_PATH), { recursive: true });
  eventDb = new DatabaseSync(EVENT_DB_PATH);
  eventDb.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      task_id TEXT,
      task_type TEXT,
      task_status TEXT,
      session_id TEXT,
      origin TEXT,
      dispatch_mode TEXT,
      response_mode TEXT,
      entrypoint TEXT,
      details_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, created_at DESC);
  `);
  return eventDb;
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
  if (type !== 'claude-cli' && type !== 'codex-cli' && type !== 'gemini-cli') {
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
  if (taskType === 'codex-cli') return 'codex';
  if (taskType === 'gemini-cli') return 'gemini';
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

function appendEvent(type, task, extra = {}) {
  const event = {
    id: crypto.randomUUID(),
    type,
    createdAt: Date.now(),
    taskId: task?.id || extra.taskId || null,
    taskType: task?.type || extra.taskType || null,
    taskStatus: task?.status || extra.taskStatus || null,
    sessionId: task?.sessionId || extra.sessionId || null,
    origin: task?.origin || extra.origin || 'unknown',
    dispatchMode: task?.dispatchMode || extra.dispatchMode || 'unspecified',
    responseMode: task?.responseMode || extra.responseMode || 'direct-callback',
    entrypoint: task?.entrypoint || extra.entrypoint || null,
    details: extra.details || null,
  };

  const db = getEventDb();
  db.prepare(`
    INSERT INTO events (
      id, type, created_at, task_id, task_type, task_status, session_id,
      origin, dispatch_mode, response_mode, entrypoint, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.type,
    event.createdAt,
    event.taskId,
    event.taskType,
    event.taskStatus,
    event.sessionId,
    event.origin,
    event.dispatchMode,
    event.responseMode,
    event.entrypoint,
    event.details ? JSON.stringify(event.details) : null
  );

  trimEvents();

  return event;
}

function countEvents() {
  const row = getEventDb().prepare(`SELECT COUNT(*) AS count FROM events`).get();
  return Number(row?.count || 0);
}

function getEventDbSizeBytes() {
  try {
    return fs.statSync(EVENT_DB_PATH).size;
  } catch {
    return 0;
  }
}

function trimEvents() {
  const db = getEventDb();
  const cutoff = Date.now() - (EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deletedExpired = db.prepare(`DELETE FROM events WHERE created_at < ?`).run(cutoff).changes;

  const countRow = db.prepare(`SELECT COUNT(*) AS count FROM events`).get();
  const count = Number(countRow?.count || 0);
  const deletedOverflow = count > MAX_EVENTS
    ? db.prepare(`
      DELETE FROM events
      WHERE id IN (
        SELECT id FROM events
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      )
    `).run(MAX_EVENTS).changes
    : 0;

  return {
    cutoff,
    deletedExpired,
    deletedOverflow,
    count: countEvents(),
  };
}

function vacuumEvents() {
  getEventDb().exec('VACUUM');
}

function getEventStats() {
  const db = getEventDb();
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS count,
      MIN(created_at) AS oldest_created_at,
      MAX(created_at) AS newest_created_at
    FROM events
  `).get();
  const byTypeRows = db.prepare(`
    SELECT type, COUNT(*) AS count
    FROM events
    GROUP BY type
    ORDER BY count DESC, type ASC
  `).all();
  const byStatusRows = db.prepare(`
    SELECT COALESCE(task_status, 'unknown') AS task_status, COUNT(*) AS count
    FROM events
    GROUP BY COALESCE(task_status, 'unknown')
    ORDER BY count DESC, task_status ASC
  `).all();

  return {
    path: EVENT_DB_PATH,
    sizeBytes: getEventDbSizeBytes(),
    count: Number(totals?.count || 0),
    oldestCreatedAt: totals?.oldest_created_at ?? null,
    newestCreatedAt: totals?.newest_created_at ?? null,
    retentionDays: EVENT_RETENTION_DAYS,
    maxEvents: MAX_EVENTS,
    byType: byTypeRows.map((row) => ({
      type: row.type,
      count: Number(row.count || 0),
    })),
    byStatus: byStatusRows.map((row) => ({
      taskStatus: row.task_status,
      count: Number(row.count || 0),
    })),
  };
}

function runEventMaintenance({ vacuum = false } = {}) {
  const before = getEventStats();
  const trim = trimEvents();
  if (vacuum) {
    vacuumEvents();
  }
  const after = getEventStats();
  return {
    vacuumed: vacuum,
    trim,
    before,
    after,
  };
}

function listEvents({ limit, taskId, type }) {
  const conditions = [];
  const params = [];

  if (taskId) {
    conditions.push('task_id = ?');
    params.push(taskId);
  }
  if (type) {
    conditions.push('type = ?');
    params.push(type);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = getEventDb().prepare(`
    SELECT
      id,
      type,
      created_at,
      task_id,
      task_type,
      task_status,
      session_id,
      origin,
      dispatch_mode,
      response_mode,
      entrypoint,
      details_json
    FROM events
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit);

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    createdAt: row.created_at,
    taskId: row.task_id,
    taskType: row.task_type,
    taskStatus: row.task_status,
    sessionId: row.session_id,
    origin: row.origin,
    dispatchMode: row.dispatch_mode,
    responseMode: row.response_mode,
    entrypoint: row.entrypoint,
    details: row.details_json ? JSON.parse(row.details_json) : null,
  }));
}

function enqueueTask(payload) {
  const task = saveTask({
    id: crypto.randomUUID(),
    status: 'pending',
    createdAt: Date.now(),
    ...payload
  });
  appendEvent('task.created', task);
  return task;
}

function getSerializedSessionKey(task) {
  return deriveSessionKey(task);
}

function consumeTaskResult(taskId) {
  const result = getTaskResult(taskId);
  if (!result) return null;
  const task = getTask(taskId);
  appendEvent('task.reconciled', task, {
    taskId,
    taskStatus: task?.status || null,
    sessionId: result?.metadata?.sessionId || task?.sessionId || null,
    details: {
      exitCode: result?.exitCode ?? null,
      reconciledBy: 'task-result-fetch',
    },
  });
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
    appendEvent('task.started', task);
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

// ========== API Routes ==========

// Health check
app.get('/health', (req, res) => {
  const queue = getQueueStats();
  const sessions = getSessionStats();
  res.json({
    status: 'ok',
    tasks: queue.total,
    results: queue.unconsumedResults,
    activeSessions: sessions.active,
    events: countEvents(),
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
    eventDb: {
      path: EVENT_DB_PATH,
      retentionDays: EVENT_RETENTION_DAYS,
      maxEvents: MAX_EVENTS,
      sizeBytes: getEventDbSizeBytes(),
    },
  });
});

app.get('/events', auth, (req, res) => {
  const limit = parseBoundedInt(req.query.limit, 50, { min: 1, max: 500 });
  const taskId = normalizeOptionalString(req.query.taskId);
  const type = normalizeOptionalString(req.query.type);

  res.json({
    events: listEvents({ limit, taskId, type }),
  });
});

app.get('/events/stats', auth, (req, res) => {
  res.json({
    stats: getEventStats(),
  });
});

app.post('/events/maintenance', auth, (req, res) => {
  const vacuum = Boolean(req.body?.vacuum);
  const result = runEventMaintenance({ vacuum });
  res.json(result);
});

// [Cloud OpenClaw] Submit task
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

app.get('/tasks/stats', auth, (req, res) => {
  res.json({
    queue: {
      ...getQueueStats(),
      taskRetentionMs: TASK_EXPIRE_MS,
      resultRetentionMs: RESULT_EXPIRE_MS,
    },
  });
});

app.get('/sessions/stats', auth, (req, res) => {
  res.json({
    sessions: getSessionStats(),
  });
});

app.get('/sessions/state', auth, (req, res) => {
  const limit = parseBoundedInt(req.query.limit, 50, { min: 1, max: 500 });
  const cliType = normalizeOptionalString(req.query.cliType);
  res.json({
    sessions: listActiveSessions({ limit, cliType }),
  });
});

// [Cloud OpenClaw] Query result (with wait window)
app.get('/tasks/:taskId', auth, async (req, res) => {
  const { taskId } = req.params;
  const waitMs = parseBoundedInt(req.query.wait, 0, { min: 0, max: MAX_POLL_WAIT_MS }); // max wait in ms

  const startTime = Date.now();

  // Poll for result within the wait window
  while (Date.now() - startTime < waitMs) {
    const result = consumeTaskResult(taskId);
    if (result) {
      return res.json(result);
    }
    await new Promise(r => setTimeout(r, 500)); // check every 500ms
  }

  // Timed out or no wait requested; return current status
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

// [Local runner / reconciler] Claim next pending task (long-poll)
app.get('/worker/poll', auth, async (req, res) => {
  const waitMs = parseBoundedInt(req.query.wait, DEFAULT_POLL_WAIT_MS, { min: 1000, max: MAX_POLL_WAIT_MS });

  // Check immediately first
  const initialTask = claimNextPendingTask();
  if (initialTask) {
    return res.json(initialTask);
  }

  // Long-poll: hold the connection, check every 500ms
  const startTime = Date.now();
  while (Date.now() - startTime < waitMs) {
    await new Promise(r => setTimeout(r, 500));
    const pendingTask = claimNextPendingTask();
    if (pendingTask) {
      return res.json(pendingTask);
    }
  }

  res.json(null); // timed out, no tasks available
});

// [Local worker] Report task result
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

  appendEvent(result.exitCode === 0 ? 'task.completed' : 'task.failed', task, {
    taskId,
    taskStatus: task?.status || (result.exitCode === 0 ? 'completed' : 'failed'),
    details: {
      exitCode: result.exitCode,
      error: result.error,
    },
    ...(result.metadata?.sessionId ? { sessionId: result.metadata.sessionId } : {}),
  });

  saveTaskResult(taskId, result);
  console.log(`[Worker] Result: ${taskId} - exit ${exitCode}`);
  if (metadata?.screenshotPath) {
    console.log(`[Worker] Screenshot: ${metadata.screenshotPath}`);
  }

  // Update session tracking
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

app.post('/worker/event', auth, (req, res) => {
  const { taskId, type, details, metadata } = req.body || {};
  const normalizedType = normalizeOptionalString(type);
  if (!normalizedType) {
    return res.status(400).json({ error: 'type is required' });
  }

  const task = taskId ? getTask(taskId) : null;
  const event = appendEvent(normalizedType, task, {
    taskId: taskId || null,
    taskType: metadata?.taskType || null,
    taskStatus: metadata?.taskStatus || task?.status || null,
    sessionId: metadata?.sessionId || task?.sessionId || null,
    origin: metadata?.origin || task?.origin || 'unknown',
    dispatchMode: metadata?.dispatchMode || task?.dispatchMode || 'unspecified',
    responseMode: metadata?.responseMode || task?.responseMode || 'direct-callback',
    entrypoint: metadata?.entrypoint || task?.entrypoint || null,
    details: details || null,
  });

  res.json({ success: true, event });
});

// ========== File I/O API (bypasses shell escaping issues) ==========

// [Cloud OpenClaw] Write file
app.post('/files/write', auth, (req, res) => {
  const { path, content, encoding = 'utf8' } = req.body || {};
  const normalizedPath = normalizeString(path);

  if (!normalizedPath || content === undefined) {
    return res.status(400).json({ error: 'path and content are required' });
  }

  const task = enqueueTask({
    type: 'file-write',
    path: normalizedPath,
    content,
    encoding, // 'utf8' or 'base64'
  });

  console.log(`[File] Write: ${task.id} - ${normalizedPath}`);

  res.json({ taskId: task.id, message: 'File write task created' });
});

// [Cloud OpenClaw] Read file
app.post('/files/read', auth, (req, res) => {
  const { path } = req.body || {};
  const normalizedPath = normalizeString(path);

  if (!normalizedPath) {
    return res.status(400).json({ error: 'path is required' });
  }

  const task = enqueueTask({
    type: 'file-read',
    path: normalizedPath,
  });

  console.log(`[File] Read: ${task.id} - ${normalizedPath}`);

  res.json({ taskId: task.id, message: 'File read task created' });
});

// [Cloud OpenClaw] Edit file (partial string replacement)
app.post('/files/edit', auth, (req, res) => {
  const { path, old_string, new_string, replace_all = false } = req.body || {};
  const normalizedPath = normalizeString(path);

  if (!normalizedPath || old_string === undefined || new_string === undefined) {
    return res.status(400).json({ error: 'path, old_string, new_string are required' });
  }

  const task = enqueueTask({
    type: 'file-edit',
    path: normalizedPath,
    oldString: old_string,
    newString: new_string,
    replaceAll: replace_all,
  });

  console.log(`[File] Edit: ${task.id} - ${normalizedPath}`);

  res.json({ taskId: task.id, message: 'File edit task created' });
});

// ========== Claude CLI API (invoke local Claude Code) ==========

// [Cloud OpenClaw] Execute local Claude Code CLI
app.post('/claude', auth, (req, res) => {
  const { prompt, timeout = 120000, sessionId, callbackChannel, callbackBotToken } = req.body || {};
  const promptText = typeof prompt === 'string' ? prompt : '';
  const requestedSessionId = normalizeOptionalString(sessionId);
  const dispatchMeta = extractDispatchMeta(req.body, 'cc');

  if (!promptText.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // Auto-generate sessionId: ensures every CC invocation has a trackable session for --resume
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

  // Update session tracking
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

// ========== Codex / Gemini CLI API ==========

// [Discord/Telegram bridge] Submit Codex CLI task (with session support)
app.post('/codex', auth, (req, res) => {
  const { prompt, timeout = 300000, sessionId, model, callbackChannel, callbackBotToken } = req.body || {};
  const promptText = typeof prompt === 'string' ? prompt : '';
  const normalizedSessionId = normalizeOptionalString(sessionId);
  const dispatchMeta = extractDispatchMeta(req.body, 'codex');

  if (!promptText.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const effectiveSessionId = normalizedSessionId || crypto.randomUUID();
  const task = enqueueTask({
    type: 'codex-cli',
    prompt: promptText,
    timeout: parseTaskTimeout(timeout, 300000),
    sessionId: effectiveSessionId,
    model: normalizeOptionalString(model),
    callbackChannel: normalizeOptionalString(callbackChannel),
    callbackBotToken: normalizeOptionalString(callbackBotToken),
    ...dispatchMeta,
  });
  touchSession(effectiveSessionId, {
    cliType: 'codex',
    callbackChannel: task.callbackChannel,
    incrementTaskCount: true,
    timestamp: Date.now(),
  });

  const isResume = Boolean(normalizedSessionId);
  console.log(`[Codex] Task: ${task.id} [mode:${task.dispatchMode}] [session:${effectiveSessionId.slice(0, 8)}${isResume ? ',resume' : ',new'}]${task.model ? ' [' + task.model + ']' : ''}${task.callbackChannel ? ' [callback:' + task.callbackChannel + ']' : ''}${task.entrypoint ? ' [via:' + task.entrypoint + ']' : ''} - ${previewText(promptText)}`);

  res.json({ taskId: task.id, sessionId: effectiveSessionId, message: 'Codex CLI task created' });
});

// [Discord/Telegram bridge] Submit Gemini CLI task (with session support)
app.post('/gemini', auth, (req, res) => {
  const { prompt, timeout = 300000, sessionId, resumeLatest, model, callbackChannel, callbackBotToken } = req.body || {};
  const promptText = typeof prompt === 'string' ? prompt : '';
  const normalizedSessionId = normalizeOptionalString(sessionId);
  const dispatchMeta = extractDispatchMeta(req.body, 'gemini');

  if (!promptText.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const effectiveSessionId = normalizedSessionId || crypto.randomUUID();
  const task = enqueueTask({
    type: 'gemini-cli',
    prompt: promptText,
    timeout: parseTaskTimeout(timeout, 300000),
    sessionId: effectiveSessionId,
    resumeLatest: Boolean(resumeLatest) || Boolean(normalizedSessionId),
    model: normalizeOptionalString(model),
    callbackChannel: normalizeOptionalString(callbackChannel),
    callbackBotToken: normalizeOptionalString(callbackBotToken),
    ...dispatchMeta,
  });
  touchSession(effectiveSessionId, {
    cliType: 'gemini',
    callbackChannel: task.callbackChannel,
    incrementTaskCount: true,
    timestamp: Date.now(),
  });

  const isResume = task.resumeLatest;
  console.log(`[Gemini] Task: ${task.id} [mode:${task.dispatchMode}] [session:${effectiveSessionId.slice(0, 8)}${isResume ? ',resume-latest' : ',new'}]${task.callbackChannel ? ' [callback:' + task.callbackChannel + ']' : ''}${task.entrypoint ? ' [via:' + task.entrypoint + ']' : ''} - ${previewText(promptText)}`);

  res.json({ taskId: task.id, sessionId: effectiveSessionId, message: 'Gemini CLI task created' });
});

// ========== Bot callback push (current compatibility path defaults to Discord API) ==========

// Let bridge / hook send bot callbacks through task-api (currently defaults to Discord channel message API)
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

// ========== Session Management API ==========

// [Cloud OpenClaw] List active sessions
app.get('/claude/sessions', auth, (req, res) => {
  const sessions = listActiveSessions({ limit: 200, cliType: 'claude' }).map((session) => ({
    sessionId: session.sessionId,
    lastActivity: session.lastActivity,
    taskCount: session.taskCount,
    callbackChannel: session.callbackChannel,
  }));
  res.json({ sessions });
});

// [Local] List recent CC sessions (with topic summary)
app.get('/claude/recent', auth, async (req, res) => {
  const limit = parseRecentLimit(req.query.limit);
  const { fs, path, readline } = await loadSessionModules();

  // Scan CC session files (container mount path, host ~/.claude/projects)
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

  // Sort by mtime descending, take most recent N
  sessions.sort((a, b) => b.mtime - a.mtime);
  const recent = sessions.slice(0, limit);

  // Extract the first user message from each session as the topic
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

// [Local] List recent Codex sessions (with topic summary)
app.get('/codex/recent', auth, async (req, res) => {
  const limit = parseRecentLimit(req.query.limit);
  const { fs, path, readline } = await loadSessionModules();

  // Scan Codex session files (container mount path, host ~/.codex/sessions)
  // Directory structure: YYYY/MM/DD/rollout-{timestamp}-{uuid}.jsonl
  const sessionsDir = '/host-codex-sessions';
  const sessionFiles = [];

  try {
    // Only scan directories for the last 7 days
    const now = new Date();
    for (let d = 0; d < 7; d++) {
      const date = new Date(now - d * 86400000);
      const yyyy = String(date.getFullYear());
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      const dayDir = path.join(sessionsDir, yyyy, mm, dd);

      try {
        const files = fs.readdirSync(dayDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const fp = path.join(dayDir, f);
            const stat = fs.statSync(fp);
            // Extract trailing UUID from filename (compatible with rollout-2026-03-02T12-33-14-{uuid}.jsonl)
            const uuidMatch = f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i);
            const sessionId = uuidMatch ? uuidMatch[1] : f.replace('.jsonl', '');
            return { file: f, path: fp, mtime: stat.mtimeMs, size: stat.size, sessionId };
          });
        sessionFiles.push(...files);
      } catch { /* day directory does not exist, skip */ }
    }
  } catch (e) {
    return res.json({ sessions: [], error: errorMessage(e) });
  }

  // Sort by mtime descending, take most recent N
  sessionFiles.sort((a, b) => b.mtime - a.mtime);
  const recent = sessionFiles.slice(0, limit);

  // Extract the first user message from each session as the topic
  const results = [];
  for (const s of recent) {
    const topic = await extractSessionTopic(s.path, fs, readline, (record) => {
      if (record.type === 'event_msg' && record.payload?.type === 'user_message') {
        const message = normalizeString(record.payload.message);
        if (!message) return '';
        const isSlashCommand = /^\/[a-z0-9_]+(?:@\w+)?(?:\s|$)/i.test(message);
        const isMentionCommand = /^@\S+\s+\/[a-z0-9_]+(?:@\w+)?(?:\s|$)/i.test(message);
        if (isSlashCommand || isMentionCommand) return '';
        return message.slice(0, 150);
      }
      if (record.message?.role !== 'user') return '';
      return extractUserText(record.message.content);
    });

    results.push({
      sessionId: s.sessionId,
      lastModified: new Date(s.mtime).toISOString(),
      sizeKB: Math.round(s.size / 1024),
      topic,
    });
  }

  res.json({ sessions: results });
});

// ========== Cleanup Expired Tasks ==========
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
  trimEvents();
}, 60000);

// ========== Startup ==========
app.listen(PORT, '0.0.0.0', () => {
  const requeued = resetStaleRunningTasks();
  const queue = getQueueStats();
  trimEvents();
  console.log(`✅ Task API running on :${PORT}`);
  console.log(`   Token : ${AUTH_TOKEN.slice(0, 4)}${'*'.repeat(AUTH_TOKEN.length - 4)}`);
  console.log(`   Notify: ${process.env.CALLBACK_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN ? '✓ CALLBACK_BOT_TOKEN/DISCORD_BOT_TOKEN set' : '✗ no CALLBACK_BOT_TOKEN or DISCORD_BOT_TOKEN'}`);
  console.log(`   Tasks : ${TASK_DB_PATH} | total=${queue.total} | results=${queue.unconsumedResults}`);
  console.log(`   Events: ${EVENT_DB_PATH} | retention=${EVENT_RETENTION_DAYS}d | max=${MAX_EVENTS}`);
  if (requeued > 0) {
    console.log(`   Requeue: reset ${requeued} stale running task(s) to pending`);
  }
});
