#!/usr/bin/env node
/**
 * Host Runner / Reconciler
 * Agent SDK mode: streaming output + session management
 *
 * Run: npm run runner
 * Or: WORKER_URL=https://xxx WORKER_TOKEN=xxx npm run runner
 */

import { exec, spawn, execFile } from 'child_process';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Prevent nesting detection (needed when launched from within CC)
delete process.env.CLAUDECODE;

function parseConfigInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

// ========== Agent SDK loading (falls back to CLI on failure) ==========
let sdkQuery;
try {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  sdkQuery = sdk.query;
  console.log('[SDK] Agent SDK loaded successfully');
} catch (e) {
  console.warn(`[SDK] Agent SDK load failed, falling back to CLI mode: ${e.message}`);
}

// ========== Configuration ==========
const CONFIG = {
  // Task API URL (set via WORKER_URL env var)
  serverUrl: process.env.WORKER_URL || 'http://127.0.0.1:3456',
  // Auth token (must match the cloud endpoint)
  token: process.env.WORKER_TOKEN || 'change-me-to-a-secure-token',
  // Reconcile loop poll interval (ms) - only used when concurrency is full
  pollInterval: parseConfigInt(process.env.POLL_INTERVAL, 500, 50, 60000),
  // Long-poll claim window (ms) - how long the server holds the connection
  longPollWait: parseConfigInt(process.env.LONG_POLL_WAIT, 30000, 1000, 300000),
  // Max concurrent tasks
  maxConcurrent: parseConfigInt(process.env.MAX_CONCURRENT, 5, 1, 50),
  // Command execution timeout (ms) - 10 min, accommodates slow Gemini/Codex tasks
  defaultTimeout: 600000,
  // OpenClaw Hooks callback config (notify bot after CC completes)
  openclawHooksUrl: process.env.OPENCLAW_HOOKS_URL || 'http://127.0.0.1:18791',
  openclawHooksToken: process.env.OPENCLAW_HOOKS_TOKEN || 'cc-callback-2026',
  callbackApiBaseUrl: process.env.CALLBACK_API_BASE_URL || 'https://discord.com/api/v10',
  // Runner local provider session cache, used only for local resume / mapping recovery
  runnerSessionCacheFile: process.env.RUNNER_SESSION_CACHE_FILE || '/tmp/openclaw-runner-session-cache.json',
};

if (CONFIG.token === 'change-me-to-a-secure-token') {
  console.warn('⚠ WARNING: Using default WORKER_TOKEN. Set WORKER_TOKEN env var for production!');
}

console.log('========================================');
console.log('  Docker-first Local Runner started');
console.log('========================================');
console.log(`Task API: ${CONFIG.serverUrl}`);
console.log(`Long-poll window: ${CONFIG.longPollWait}ms`);
console.log(`Max concurrency: ${CONFIG.maxConcurrent} tasks`);
console.log(`Execution mode: ${sdkQuery ? 'Agent SDK (preferred)' : 'CLI (fallback)'}`);
console.log(`Runner cache: ${CONFIG.runnerSessionCacheFile}`);
console.log('');
console.log('Supported task types:');
console.log('  - command: execute shell command');
console.log('  - file-read: read file');
console.log('  - file-write: write file');
console.log('  - file-edit: edit file (partial replacement)');
console.log('  - claude-cli: invoke local Claude Code (SDK/CLI)');
console.log('  - codex-cli: invoke local Codex CLI');
console.log('  - gemini-cli: invoke local Gemini CLI');
console.log('');

// ========== HTTP request helper ==========
function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, CONFIG.serverUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${CONFIG.token}`,
        'Content-Type': 'application/json',
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data || 'null') });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    // Poll request timeout must exceed server hold time to avoid premature disconnect
    const reqTimeout = urlPath.includes('/worker/poll') ? CONFIG.longPollWait + 5000 : 10000;
    req.setTimeout(reqTimeout, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ========== Execute command ==========
// NOTE: exec() is intentionally used here -- the worker IS a command execution service
function executeCommand(command, timeout) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const cleanCommand = command.trim();
    const wrappedCommand = `/bin/zsh -l -c ${JSON.stringify(cleanCommand)}`;

    exec(wrappedCommand, {
      timeout: timeout || CONFIG.defaultTimeout,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin',
        HOME: process.env.HOME,
        USER: process.env.USER
      }
    }, (error, stdout, stderr) => {
      const duration = Date.now() - startTime;
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: error ? error.code || 1 : 0,
        error: error ? error.message : null,
        duration
      });
    });
  });
}

// ========== File operations ==========
function expandHome(filePath) {
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME, filePath.slice(2));
  }
  return filePath;
}

function writeFileToDisk(filePath, content, encoding) {
  return new Promise((resolve) => {
    try {
      const cleanPath = filePath.trim();
      const fullPath = expandHome(cleanPath);
      console.log(`[Write] ${fullPath}`);

      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = encoding === 'base64'
        ? Buffer.from(content || '', 'base64')
        : (content || '');

      fs.writeFileSync(fullPath, data);
      resolve({
        stdout: `File written: ${fullPath}`,
        stderr: '',
        exitCode: 0,
        error: null
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        error: err.message
      });
    }
  });
}

function readFileFromDisk(filePath) {
  return new Promise((resolve) => {
    try {
      const fullPath = expandHome(filePath);
      const content = fs.readFileSync(fullPath, 'utf8');
      resolve({
        stdout: content,
        stderr: '',
        exitCode: 0,
        error: null
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        error: err.message
      });
    }
  });
}

function editFileOnDisk(filePath, oldString, newString, replaceAll) {
  return new Promise((resolve) => {
    try {
      const fullPath = expandHome(filePath.trim());
      console.log(`[Edit] ${fullPath}`);

      if (!fs.existsSync(fullPath)) {
        return resolve({
          stdout: '',
          stderr: `File not found: ${fullPath}`,
          exitCode: 1,
          error: 'File not found'
        });
      }

      let content = fs.readFileSync(fullPath, 'utf8');

      if (!content.includes(oldString)) {
        return resolve({
          stdout: '',
          stderr: `old_string not found in ${fullPath}`,
          exitCode: 1,
          error: 'old_string not found'
        });
      }

      if (!replaceAll) {
        // For non-global replace, check that old_string is unique
        const count = content.split(oldString).length - 1;
        if (count > 1) {
          return resolve({
            stdout: '',
            stderr: `old_string found ${count} times in ${fullPath}, use replace_all or provide more context`,
            exitCode: 1,
            error: 'old_string not unique'
          });
        }
      }

      content = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      fs.writeFileSync(fullPath, content);
      resolve({
        stdout: `File edited: ${fullPath}`,
        stderr: '',
        exitCode: 0,
        error: null
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        error: err.message
      });
    }
  });
}

// ========== Runner local provider session cache ==========
// Single responsibility: only used to recover SDK session resume after runner restart.
// Authoritative state lives in server.js taskDb/sessionDb (SQLite); this is not a second source of truth.
const SESSION_FILE = CONFIG.runnerSessionCacheFile;
const liveSessions = new Map();   // sdkSessionId → { lastActivity, callbackChannel }
const sessionIdMap = new Map();   // taskApiSessionId → sdkSessionId (mapping table)
const ccSessions = new Set();     // CLI mode: tracks created CC sessions

function rememberMappedSession(taskApiId, providerSessionId, callbackChannel) {
  if (!providerSessionId) return;
  liveSessions.set(providerSessionId, {
    lastActivity: Date.now(),
    callbackChannel
  });
  if (taskApiId && taskApiId !== providerSessionId) {
    sessionIdMap.set(taskApiId, providerSessionId);
  }
  saveSessions();
}

function listRecentCodexSessions(days = 30) {
  const sessionsDir = path.join(process.env.HOME, '.codex', 'sessions');
  const sessionFiles = [];
  const now = new Date();

  for (let d = 0; d < days; d++) {
    const date = new Date(now.getTime() - d * 86400000);
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
          const uuidMatch = f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i);
          const sessionId = uuidMatch ? uuidMatch[1] : f.replace('.jsonl', '');
          return { sessionId, mtime: stat.mtimeMs };
        });
      sessionFiles.push(...files);
    } catch {
      // Day directory doesn't exist, skip
    }
  }

  return sessionFiles;
}

function resolveCodexSessionId(sessionId) {
  if (!sessionId) return null;

  const mapped = sessionIdMap.get(sessionId);
  if (mapped) return mapped;

  const candidates = listRecentCodexSessions()
    .filter(s => s.sessionId === sessionId || s.sessionId.startsWith(sessionId))
    .sort((a, b) => b.mtime - a.mtime);

  if (candidates.length > 0) {
    if (candidates[0].sessionId !== sessionId) {
      console.log(`[Codex Session] Prefix match: ${sessionId} → ${candidates[0].sessionId}`);
    }
    return candidates[0].sessionId;
  }

  return null;
}

// Short ID prefix match: /cc-recent shows 8-char truncated IDs, resume needs full UUID
function resolveSessionPrefix(prefix) {
  if (!prefix) return prefix;
  // Already a full UUID (36 chars with hyphens, 32 chars hex) → return as-is
  if (prefix.length >= 32) return prefix;

  const sessionDir = path.join(process.env.HOME, '.claude', 'projects', '-Users-' + path.basename(process.env.HOME));
  try {
    const files = fs.readdirSync(sessionDir);
    const matches = files.filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'));
    if (matches.length === 1) {
      const fullId = matches[0].replace('.jsonl', '');
      console.log(`[Session] Prefix match: ${prefix} → ${fullId}`);
      return fullId;
    } else if (matches.length > 1) {
      // Multiple matches → pick the most recently modified
      const sorted = matches
        .map(f => ({ file: f, mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const fullId = sorted[0].file.replace('.jsonl', '');
      console.log(`[Session] Prefix ${prefix} matched ${matches.length} sessions, using latest: ${fullId}`);
      return fullId;
    }
  } catch { /* directory doesn't exist */ }
  return prefix; // Not found, return original value for downstream handling
}

function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    for (const s of data) {
      liveSessions.set(s.sessionId, {
        lastActivity: s.lastActivity,
        callbackChannel: s.callbackChannel
      });
      ccSessions.add(s.sessionId);
      // Restore mapping
      if (s.taskApiId) {
        sessionIdMap.set(s.taskApiId, s.sessionId);
      }
    }
    console.log(`[Session] Restored ${liveSessions.size} runner cache entries`);
  } catch {
    // File doesn't exist or malformed, ignore
  }
}

function saveSessions() {
  try {
    // Reverse lookup taskApiId
    const reverseMap = new Map();
    for (const [taskApiId, sdkId] of sessionIdMap) {
      reverseMap.set(sdkId, taskApiId);
    }
    const data = Array.from(liveSessions.entries()).map(([sessionId, s]) => ({
      sessionId,
      taskApiId: reverseMap.get(sessionId) || null,
      lastActivity: s.lastActivity,
      callbackChannel: s.callbackChannel
    }));
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[Session] Save failed:', e.message);
  }
}

loadSessions();

// Note: expiry cleanup of runner local cache is managed by server-side cleanupExpiredSessions().
// Runner does not run its own cleanup timer to avoid conflicting dual-ownership.

// ========== Bot callback push (current compatibility path defaults to Discord API) ==========
const CALLBACK_BOT_TOKEN = process.env.CALLBACK_BOT_TOKEN || '';
const DISCORD_PROXY = process.env.DISCORD_PROXY || '';

/**
 * Send a message via the injectable bot callback API.
 * Currently defaults to the Discord channel message API; HTTPS can optionally use a proxy.
 */
function discordPost(channelId, content, botToken) {
  const token = botToken || CALLBACK_BOT_TOKEN;
  const discordApiBase = CONFIG.callbackApiBaseUrl.endsWith('/') ? CONFIG.callbackApiBaseUrl : `${CONFIG.callbackApiBaseUrl}/`;
  const discordUrl = new URL(`channels/${channelId}/messages`, discordApiBase);
  const isHttps = discordUrl.protocol === 'https:';
  const lib = isHttps ? https : http;
  const agent = isHttps && DISCORD_PROXY ? new HttpsProxyAgent(DISCORD_PROXY) : undefined;
  const body = JSON.stringify({ content: content.slice(0, 2000) });

  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: discordUrl.protocol,
      hostname: discordUrl.hostname,
      port: discordUrl.port || (isHttps ? 443 : 80),
      path: discordUrl.pathname + discordUrl.search,
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      agent,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Callback request timeout'));
    });
    req.write(body);
    req.end();
  });
}

function notifyDiscord(callbackChannel, sessionId, text, prefix, botToken) {
  if (!callbackChannel) return;

  const sessionInfo = sessionId ? `\n📎 sessionId: \`${sessionId.slice(0, 8)}\`` : '';
  let message = `**${prefix}**${sessionInfo}\n\n${text}`;
  if (message.length > 2000) message = message.slice(0, 1997) + '...';

  const maxRetries = 5;
  let attempt = 0;

  function trySend() {
    attempt++;
    const backoff = Math.min(attempt * 3000, 15000);
    discordPost(callbackChannel, message, botToken).then(({ status, data }) => {
      if (status >= 200 && status < 300) {
        console.log(`[Callback] Push succeeded (${prefix})${attempt > 1 ? ` [attempt #${attempt}]` : ''}`);
      } else if (attempt < maxRetries) {
        console.error(`[Callback] Attempt #${attempt} failed (${status}), retrying in ${backoff/1000}s`);
        setTimeout(trySend, backoff);
      } else {
        console.error(`[Callback] All ${maxRetries} attempts failed (${status}): ${typeof data === 'string' ? data.slice(0, 100) : ''}`);
      }
    }).catch(err => {
      if (attempt < maxRetries) {
        console.error(`[Callback] Attempt #${attempt} error, retrying in ${backoff/1000}s: ${err.message}`);
        setTimeout(trySend, backoff);
      } else {
        console.error(`[Callback] All ${maxRetries} attempts failed: ${err.message}`);
      }
    });
  }

  trySend();
}

// ========== Message filtering & formatting (SDK mode) ==========
const SILENT_TOOLS = new Set([
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'
]);

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'
]);

function formatAssistantMessage(msg) {
  if (msg.type !== 'assistant' || !msg.message?.content) return null;

  const parts = [];

  for (const block of msg.message.content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      if (SILENT_TOOLS.has(block.name)) continue;
      if (READ_ONLY_TOOLS.has(block.name)) continue;
      const inputPreview = typeof block.input === 'object'
        ? (block.input.command || block.input.file_path || block.input.description || '').slice(0, 80)
        : '';
      parts.push(`🔧 ${block.name}${inputPreview ? ': ' + inputPreview : ''}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

// ========== Agent SDK execution ==========
async function executeClaudeSDK(prompt, timeout, sessionId, callbackChannel, model) {
  const startTime = Date.now();

  // Check if sessionId corresponds to a real CC session file (terminal session).
  // If so, resume it directly without going through sessionIdMap (avoids stale mapping override).
  let sdkSessionId = null;
  if (sessionId) {
    const projectDir = path.join(process.env.HOME, '.claude', 'projects', '-Users-' + path.basename(process.env.HOME));
    const sessionFile = path.join(projectDir, sessionId + '.jsonl');
    if (fs.existsSync(sessionFile)) {
      // Real CC session file exists → resume this terminal session directly
      sdkSessionId = sessionId;
    } else {
      // Exact file not found → try short ID prefix match first
      if (!sessionId.includes('-') || sessionId.length < 36) {
        try {
          const matches = fs.readdirSync(projectDir)
            .filter(f => f.startsWith(sessionId) && f.endsWith('.jsonl'));
          if (matches.length === 1) {
            sdkSessionId = matches[0].replace('.jsonl', '');
            console.log(`[SDK] Short ID prefix match: ${sessionId} → ${sdkSessionId.slice(0, 8)}...`);
          } else if (matches.length > 1) {
            console.warn(`[SDK] Short ID ${sessionId} matched ${matches.length} sessions, skipping`);
          }
        } catch { /* projectDir doesn't exist */ }
      }
      // Prefix match also failed → fall back to sessionIdMap lookup
      if (!sdkSessionId) {
        sdkSessionId = sessionIdMap.get(sessionId) || null;
        if (!sdkSessionId) {
          // Reload mapping from file (other worker processes may have written it)
          try {
            const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            for (const s of data) {
              if (s.taskApiId && s.sessionId) {
                sessionIdMap.set(s.taskApiId, s.sessionId);
                if (!liveSessions.has(s.sessionId)) {
                  liveSessions.set(s.sessionId, { lastActivity: s.lastActivity, callbackChannel: s.callbackChannel });
                }
              }
            }
            sdkSessionId = sessionIdMap.get(sessionId) || null;
            if (sdkSessionId) console.log(`[SDK] Mapping restored from file: API:${sessionId.slice(0, 8)} → SDK:${sdkSessionId.slice(0, 8)}`);
          } catch { /* file doesn't exist or malformed */ }
        }
      }
    }
  }
  const isResume = !!sdkSessionId;

  console.log(`[SDK] ${isResume ? 'Resuming' : 'New'} session: "${prompt.slice(0, 50)}..."${sessionId ? ' [API:' + sessionId.slice(0, 8) + (sdkSessionId ? ' → SDK:' + sdkSessionId.slice(0, 8) : '') + ']' : ''}`);

  // Build options (resume also needs permission config, otherwise subprocess exits immediately).
  // model is passed in by the caller, supports fallback retry.
  const baseOptions = {
    model: model || 'claude-opus-4-6',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    cwd: process.env.HOME,
  };
  const options = isResume
    ? { ...baseOptions, resume: sdkSessionId }
    : {
        ...baseOptions,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
      };

  // Streaming output debounce
  let buffer = [];
  let debounceTimer = null;
  const DEBOUNCE_MS = 3000;
  let capturedSessionId = sessionId || null;

  function flush() {
    // Don't push streaming progress to bot chat, keep a clean chat experience
    buffer = [];
    debounceTimer = null;
  }

  let resultText = '';
  let resultSubtype = 'success';
  let resultErrors = [];

  // Timeout guard
  const timeoutMs = (timeout || CONFIG.defaultTimeout) + 30000;
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    for await (const message of sdkQuery({
      prompt,
      options: { ...options, abortController }
    })) {
      // Capture session ID
      if (message.type === 'system' && message.subtype === 'init') {
        capturedSessionId = message.session_id;
        console.log(`[SDK] Session ID: ${capturedSessionId.slice(0, 8)}`);
      }

      // Format assistant message
      if (message.type === 'assistant') {
        const formatted = formatAssistantMessage(message);
        if (formatted) {
          buffer.push(formatted);
          if (!debounceTimer) {
            debounceTimer = setTimeout(flush, DEBOUNCE_MS);
          }
        }
      }

      // Capture final result
      if (message.type === 'result') {
        resultSubtype = message.subtype;
        if (message.subtype === 'success') {
          resultText = message.result || '';
        } else {
          resultErrors = message.errors || [];
          resultText = resultErrors.join('\n');
        }
        console.log(`[SDK] Result: ${message.subtype}, took ${message.duration_ms}ms, cost $${message.total_cost_usd?.toFixed(4) || '?'}`);
      }
    }
  } catch (err) {
    clearTimeout(timeoutHandle);
    if (debounceTimer) clearTimeout(debounceTimer);
    flush();

    const isAbort = err.name === 'AbortError' || abortController.signal.aborted;
    console.error(`[SDK] ${isAbort ? 'Timeout' : 'Error'}: ${err.message}`);

    return {
      stdout: resultText || '',
      stderr: isAbort ? 'Timeout' : err.message,
      exitCode: isAbort ? -1 : 1,
      error: isAbort ? 'Timeout' : err.message,
      duration: Date.now() - startTime,
      metadata: capturedSessionId ? { sessionId: capturedSessionId } : undefined
    };
  }

  clearTimeout(timeoutHandle);
  if (debounceTimer) clearTimeout(debounceTimer);
  buffer = [];   // Clear residual to avoid duplicate sends with notifyCompletion
  flush();

  const duration = Date.now() - startTime;

  // Update session pool + mapping table
  if (capturedSessionId) {
    liveSessions.set(capturedSessionId, {
      lastActivity: Date.now(),
      callbackChannel
    });
    // Task API sessionId → SDK session_id mapping
    if (sessionId && sessionId !== capturedSessionId) {
      sessionIdMap.set(sessionId, capturedSessionId);
      console.log(`[SDK] Mapping: API:${sessionId.slice(0, 8)} → SDK:${capturedSessionId.slice(0, 8)}`);
    }
    ccSessions.add(capturedSessionId);
    saveSessions();
  }

  const isError = resultSubtype !== 'success';
  console.log(`[SDK] Done, took ${duration}ms, result ${resultText.length} chars`);

  return {
    stdout: resultText,
    stderr: isError ? resultErrors.join('\n') : '',
    exitCode: isError ? 1 : 0,
    error: isError ? `SDK ${resultSubtype}` : null,
    duration,
    metadata: capturedSessionId ? { sessionId: capturedSessionId } : undefined
  };
}

// ========== Codex CLI execution (supports session resume + model selection) ==========
function executeCodexCLI(prompt, timeout, sessionId, model) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const resolvedSessionId = resolveCodexSessionId(sessionId);
    console.log(`[Codex CLI] Executing${model ? ' [' + model + ']' : ''}: "${prompt.slice(0, 50)}..."${resolvedSessionId ? ' [resume:' + resolvedSessionId.slice(0, 8) + ']' : ''}`);

    const args = ['exec'];
    if (resolvedSessionId) {
      args.push('resume');
    }
    args.push('--skip-git-repo-check', '--full-auto');
    if (model) args.push('-m', model);
    if (resolvedSessionId) args.push(resolvedSessionId);
    args.push(prompt);

    const child = spawn(CODEX_PATH, args, {
      cwd: process.env.HOME,
      env: buildCliEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    const effectiveTimeout = (timeout || CONFIG.defaultTimeout) + 30000;
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        stdout, stderr: 'Timeout', exitCode: -1,
        error: 'Timeout', duration: Date.now() - startTime
      });
    }, effectiveTimeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      // Extract session id from stderr (format: session id: <uuid>)
      const sessionMatch = stderr.match(/session id:\s*([a-f0-9-]+)/i);
      const capturedSessionId = sessionMatch ? sessionMatch[1] : null;
      console.log(`[Codex CLI] Done, took ${duration}ms, output ${stdout.length} bytes${capturedSessionId ? ', session:' + capturedSessionId.slice(0, 8) : ''}`);
      resolve({
        stdout: stdout.trim(), stderr: stderr.trim(),
        exitCode: code || 0, error: code ? `Exit code ${code}` : null, duration,
        metadata: capturedSessionId ? { sessionId: capturedSessionId } : undefined
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout, stderr: err.message, exitCode: -1,
        error: err.message, duration: Date.now() - startTime
      });
    });
  });
}

// ========== Gemini CLI execution (supports session resume) ==========
const DEFAULT_GEMINI_REPLY_HINT = [
  'You are replying to an end user inside a chat bot.',
  'Answer the user request directly, naturally, and helpfully.',
  'Do not describe yourself as a CLI tool, non-interactive agent, runtime, or execution environment unless the user explicitly asks about that.',
  'Do not add meta commentary about how you were invoked.',
  'If the user asks who you are, answer as an AI assistant in this chat and briefly say what you can help with.',
].join(' ');

function buildGeminiPrompt(prompt) {
  const hint = process.env.GEMINI_REPLY_HINT;
  if (hint === 'off') return prompt;
  const effectiveHint = (hint || DEFAULT_GEMINI_REPLY_HINT).trim();
  if (!effectiveHint) return prompt;
  return [
    'System instructions:',
    effectiveHint,
    '',
    'User message:',
    prompt,
    '',
    'Reply:'
  ].join('\n');
}

function sanitizeGeminiResponse(responseText) {
  const text = (responseText || '').trim();
  if (!text) return text;

  const exactMetaPatterns = [
    /^我是一个非交互式命令行代理[。.!！]?$/i,
    /^我是一个非交互式cli代理[。.!！]?$/i,
    /^我是一个cli代理[。.!！]?$/i,
    /^i am a non-interactive command-line agent[.!]?$/i,
    /^i am a non-interactive cli agent[.!]?$/i,
    /^i am a cli agent[.!]?$/i,
  ];

  if (exactMetaPatterns.some((pattern) => pattern.test(text))) {
    return /[一-龥]/.test(text) ? '我是一个 AI 助手。' : 'I am an AI assistant.';
  }

  return text
    .replace(/^我是一个非交互式命令行代理[。.!！]?\s*/i, '我是一个 AI 助手。')
    .replace(/^我是一个非交互式cli代理[。.!！]?\s*/i, '我是一个 AI 助手。')
    .replace(/^我是一个cli代理[。.!！]?\s*/i, '我是一个 AI 助手。')
    .replace(/^I am a non-interactive command-line agent[.!]?\s*/i, 'I am an AI assistant. ')
    .replace(/^I am a non-interactive CLI agent[.!]?\s*/i, 'I am an AI assistant. ')
    .replace(/^I am a CLI agent[.!]?\s*/i, 'I am an AI assistant. ')
    .trim();
}

function executeGeminiCLI(prompt, timeout, resumeLatest, model) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const modelName = model || 'gemini-2.5-flash';
    console.log(`[Gemini CLI] Executing [${modelName}]: "${prompt.slice(0, 50)}..."${resumeLatest ? ' [resume:latest]' : ''}`);
    const wrappedPrompt = buildGeminiPrompt(prompt);

    const args = [];
    if (resumeLatest) {
      args.push('--resume', 'latest');
    }
    args.push('-m', modelName, '-p', wrappedPrompt, '-o', 'json', '--sandbox=false');
    const child = spawn(GEMINI_PATH, args, {
      cwd: process.env.HOME,
      env: buildCliEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    const effectiveTimeout = (timeout || CONFIG.defaultTimeout) + 30000;
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        stdout, stderr: 'Timeout', exitCode: -1,
        error: 'Timeout', duration: Date.now() - startTime
      });
    }, effectiveTimeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      // Extract session_id and response from JSON output
      let capturedSessionId = null;
      let responseText = stdout.trim();
      try {
        const json = JSON.parse(stdout);
        capturedSessionId = json.session_id || null;
        responseText = json.response || responseText;
      } catch {}
      responseText = sanitizeGeminiResponse(responseText);
      console.log(`[Gemini CLI] Done, took ${duration}ms, output ${responseText.length} bytes${capturedSessionId ? ', session:' + capturedSessionId.slice(0, 8) : ''}`);
      resolve({
        stdout: responseText, stderr: stderr.trim(),
        exitCode: code || 0, error: code ? `Exit code ${code}` : null, duration,
        metadata: capturedSessionId ? { sessionId: capturedSessionId } : undefined
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout, stderr: err.message, exitCode: -1,
        error: err.message, duration: Date.now() - startTime
      });
    });
  });
}

// ========== CLI fallback execution (legacy path) ==========
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const CODEX_PATH = process.env.CODEX_PATH || 'codex';
const GEMINI_PATH = process.env.GEMINI_PATH || 'gemini';
const CC_LOG = '/tmp/cc-live.log';

function buildCliEnv(extra = {}) {
  return {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + process.env.PATH,
    HOME: process.env.HOME,
    ...extra,
  };
}

function executeClaudeCLI(prompt, timeout, sessionId, model) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const useModel = model || 'claude-opus-4-6';
    console.log(`[Claude CLI] Executing [${useModel}]: "${prompt.slice(0, 50)}..."${sessionId ? ' [session:' + sessionId.slice(0, 8) + ']' : ''}`);

    const args = ['--print', '--model', useModel];
    if (sessionId) {
      if (ccSessions.has(sessionId)) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
        ccSessions.add(sessionId);
      }
    }
    args.push('--dangerously-skip-permissions', prompt);
    console.log(`[Claude CLI] Command: ${CLAUDE_PATH} ${args.map(v => JSON.stringify(v)).join(' ')}`);

    // Write to live log
    try { fs.appendFileSync(CC_LOG, `\n${'='.repeat(60)}\n[${new Date().toISOString()}] CC started: ${prompt.slice(0, 80)}...\n${'='.repeat(60)}\n`); } catch (e) {}
    const child = spawn(CLAUDE_PATH, args, {
      cwd: process.env.HOME,
      env: buildCliEnv({ TERM: 'xterm-256color' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      try { fs.appendFileSync(CC_LOG, chunk); } catch (e) {}
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const effectiveTimeout = (timeout || CONFIG.defaultTimeout) + 30000;
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        stdout,
        stderr: 'Timeout',
        exitCode: -1,
        error: 'Timeout',
        duration: Date.now() - startTime
      });
    }, effectiveTimeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      console.log(`[Claude CLI] Done, took ${duration}ms, output ${stdout.length} bytes`);

      try { fs.appendFileSync(CC_LOG, `\n[${new Date().toISOString()}] CC finished (${duration}ms, exit ${code})\n`); } catch (e) {}

      const screenshotMatch = stdout.match(/PLEASE_UPLOAD_TO_DISCORD:\s*(.+\.png)/);
      const screenshotPath = screenshotMatch ? screenshotMatch[1].trim() : null;

      if (screenshotPath) {
        console.log(`[Claude CLI] Screenshot detected: ${screenshotPath}`);
      }

      let ccSessionId = sessionId || null;
      if (!ccSessionId) {
        try {
          const historyPath = path.join(process.env.HOME, '.claude', 'history.jsonl');
          const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n');
          const lastEntry = JSON.parse(lines[lines.length - 1]);
          ccSessionId = lastEntry.sessionId || null;
        } catch (e) {}
      }

      const result = {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code || 0,
        error: code ? `Exit code ${code}` : null,
        duration
      };

      const metadata = {};
      if (screenshotPath) metadata.screenshotPath = screenshotPath;
      if (ccSessionId) metadata.sessionId = ccSessionId;
      if (Object.keys(metadata).length > 0) result.metadata = metadata;

      resolve(result);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: err.message,
        exitCode: -1,
        error: err.message,
        duration: Date.now() - startTime
      });
    });
  });
}

// ========== Completion notification (push final result back to bot-side callback channel) ==========
const CLI_TASK_TYPES = new Set(['claude-cli', 'codex-cli', 'gemini-cli']);
const CLI_LABELS = { 'claude-cli': 'CC', 'codex-cli': 'Codex', 'gemini-cli': 'Gemini' };

function describeTaskMode(task) {
  const mode = task.dispatchMode || 'unspecified';
  const via = task.entrypoint ? ` via:${task.entrypoint}` : '';
  return `[mode:${mode}${via}]`;
}

function reportTaskEvent(task, type, details = {}) {
  if (!task?.id) return;
  request('POST', '/worker/event', {
    taskId: task.id,
    type,
    details,
    metadata: {
      taskType: task.type,
      taskStatus: task.status,
      sessionId: task.sessionId || null,
      origin: task.origin || 'unknown',
      dispatchMode: task.dispatchMode || 'unspecified',
      responseMode: task.responseMode || 'direct-callback',
      entrypoint: task.entrypoint || null,
    },
  }).catch((err) => {
    console.error(`[Event] ${type} report failed: ${err.message}`);
  });
}

function notifyCompletion(task, result) {
  if (!CLI_TASK_TYPES.has(task.type) || !task.callbackChannel) return;
  if (task.responseMode && task.responseMode !== 'direct-callback') return;

  const label = CLI_LABELS[task.type] || task.type;
  const output = (result.stdout || '').slice(-1800) || '(no output)';

  if (result.exitCode !== 0) {
    const duration = result.duration ? `${Math.round(result.duration / 1000)}s` : 'unknown';
    notifyDiscord(task.callbackChannel, task.sessionId, output, `❌ ${label} failed (${duration})`, task.callbackBotToken);
    reportTaskEvent(task, 'callback.dispatched', {
      channel: task.callbackChannel,
      outcome: 'failure-message',
      durationMs: result.duration || null,
    });
  } else {
    const message = output.length > 2000 ? output.slice(0, 1997) + '...' : output;
    const maxRetries = 5;
    let attempt = 0;

    function trySend() {
      attempt++;
      const backoff = Math.min(attempt * 3000, 15000);
      discordPost(task.callbackChannel, message, task.callbackBotToken).then(({ status }) => {
        if (status >= 200 && status < 300) {
          console.log(`[Callback] ${label} output pushed ${describeTaskMode(task)}${attempt > 1 ? ` [attempt #${attempt}]` : ''}`);
          reportTaskEvent(task, 'callback.sent', {
            channel: task.callbackChannel,
            attempts: attempt,
            status,
          });
        } else if (attempt < maxRetries) {
          console.error(`[Callback] Push failed (${status}), retrying in ${backoff/1000}s`);
          setTimeout(trySend, backoff);
        } else {
          console.error(`[Callback] ${label} all ${maxRetries} push attempts failed (${status})`);
          reportTaskEvent(task, 'callback.failed', {
            channel: task.callbackChannel,
            attempts: attempt,
            status,
          });
        }
      }).catch(err => {
        if (attempt < maxRetries) {
          console.error(`[Callback] Push error, retrying in ${backoff/1000}s: ${err.message}`);
          setTimeout(trySend, backoff);
        } else {
          console.error(`[Callback] ${label} all ${maxRetries} push attempts failed: ${err.message}`);
          reportTaskEvent(task, 'callback.failed', {
            channel: task.callbackChannel,
            attempts: attempt,
            error: err.message,
          });
        }
      });
    }

    trySend();
  }
}

// ========== Concurrent task management ==========
let isRunning = true;
let consecutiveErrors = 0;
const runningTasks = new Set();

async function executeTask(task) {
  const taskId = task.id.slice(0, 8);

  try {
    let result;

    if (task.type === 'file-write') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [File write] ${taskId}... - ${task.path.trim()}`);
      result = await writeFileToDisk(task.path, task.content, task.encoding);
    } else if (task.type === 'file-read') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [File read] ${taskId}... - ${task.path}`);
      result = await readFileFromDisk(task.path);
    } else if (task.type === 'file-edit') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [File edit] ${taskId}... - ${task.path}`);
      result = await editFileOnDisk(task.path, task.oldString, task.newString, task.replaceAll);
    } else if (task.type === 'claude-cli') {
      // Short ID prefix resolution (/cc-recent shows 8-char IDs, need to resolve to full UUID)
      if (task.sessionId) task.sessionId = resolveSessionPrefix(task.sessionId);
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [Claude ${sdkQuery ? 'SDK' : 'CLI'}] ${taskId} ${describeTaskMode(task)} - ${task.prompt?.slice(0, 50)}...`);
      // Ack already handled by cc-bridge registerCommand, worker doesn't push again
      // CC model fallback: Opus → Sonnet (uses CC default if unspecified)
      const CC_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6'];
      for (let i = 0; i < CC_MODELS.length; i++) {
        const model = CC_MODELS[i];
        try {
          if (sdkQuery) {
            result = await executeClaudeSDK(task.prompt, task.timeout, task.sessionId, task.callbackChannel, model);
          } else {
            result = await executeClaudeCLI(task.prompt, task.timeout, task.sessionId, model);
          }
          // Success or normal exit (non-zero exitCode counts as complete, no retry)
          break;
        } catch (err) {
          const isLast = i === CC_MODELS.length - 1;
          console.warn(`[CC Fallback] ${model} failed: ${err.message}${isLast ? '' : ', falling back to ' + CC_MODELS[i + 1]}`);
          if (isLast) throw err;
        }
      }
    } else if (task.type === 'codex-cli') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [Codex CLI] ${taskId} ${describeTaskMode(task)}${task.sessionId ? ' [session:' + task.sessionId.slice(0, 8) + ']' : ''}${task.model ? ' [' + task.model + ']' : ''} - ${task.prompt?.slice(0, 50)}...`);
      result = await executeCodexCLI(task.prompt, task.timeout, task.sessionId, task.model);
    } else if (task.type === 'gemini-cli') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [Gemini CLI] ${taskId} ${describeTaskMode(task)}${task.resumeLatest ? ' [resume:latest]' : ''}${task.model ? ' [' + task.model + ']' : ''} - ${task.prompt?.slice(0, 50)}...`);
      result = await executeGeminiCLI(task.prompt, task.timeout, task.resumeLatest, task.model);
    } else {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [Command] ${taskId}... - ${task.command}`);
      result = await executeCommand(task.command, task.timeout);
    }

    if ((task.type === 'codex-cli' || task.type === 'gemini-cli') && result.metadata?.sessionId) {
      rememberMappedSession(task.sessionId, result.metadata.sessionId, task.callbackChannel);
    }

    // Report result
    await request('POST', '/worker/result', {
      taskId: task.id,
      ...result
    });

    // Callback notification to bot-side channel after CC task completes
    notifyCompletion(task, result);

    const status = result.exitCode === 0 ? '✓' : '✗';
    console.log(`[Done] ${status} ${taskId}... (remaining: ${runningTasks.size - 1})`);

  } catch (err) {
    console.error(`[Error] ${taskId}... - ${err.message}`);
    try {
      await request('POST', '/worker/result', {
        taskId: task.id,
        stdout: '',
        stderr: err.message,
        exitCode: -1,
        error: err.message
      });
    } catch (reportErr) {
      console.error(`[Report failed] ${taskId}... - ${reportErr.message}`);
    }
  } finally {
    runningTasks.delete(task.id);
  }
}

// Main reconciler loop: hooks take priority, long-poll claims tasks and provides fallback recovery
async function runReconcilerLoop() {
  while (isRunning) {
    try {
      if (runningTasks.size >= CONFIG.maxConcurrent) {
        await sleep(CONFIG.pollInterval);
        continue;
      }

      const pollRes = await request('GET', `/worker/poll?wait=${CONFIG.longPollWait}`);

      if (pollRes.status === 401) {
        console.error('[Error] Token authentication failed, check configuration');
        await sleep(10000);
        continue;
      }

      const task = pollRes.data;
      consecutiveErrors = 0;

      if (!task) continue;

      runningTasks.add(task.id);
      executeTask(task);

      if (runningTasks.size < CONFIG.maxConcurrent) continue;

    } catch (err) {
      consecutiveErrors++;
      const waitTime = Math.min(consecutiveErrors * 5000, 60000);

      if (consecutiveErrors === 1) {
        console.error(`[Connection failed] ${err.message}`);
      }
      console.log(`[Retry] Retrying in ${waitTime / 1000}s... (attempt #${consecutiveErrors})`);

      await sleep(waitTime);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== Export active sessions (for external queries) ==========
export function getActiveSessions() {
  return Array.from(liveSessions.entries()).map(([sessionId, s]) => ({
    sessionId,
    lastActivity: s.lastActivity,
    callbackChannel: s.callbackChannel
  }));
}

// ========== Graceful shutdown ==========
process.on('SIGINT', () => {
  console.log('\n[Shutdown] Received Ctrl+C, stopping...');
  isRunning = false;
  saveSessions();
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', () => {
  console.log('\n[Shutdown] Received SIGTERM, stopping...');
  isRunning = false;
  saveSessions();
  setTimeout(() => process.exit(0), 1000);
});

// ========== Start ==========
runReconcilerLoop().catch(console.error);
