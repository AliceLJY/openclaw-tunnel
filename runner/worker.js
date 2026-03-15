#!/usr/bin/env node
/**
 * Mac 本地 Runner / Reconciler
 * Agent SDK 版本：流式输出 + 会话管理
 *
 * 运行: npm run runner
 * 或: WORKER_URL=https://xxx WORKER_TOKEN=xxx npm run runner
 */

import { exec, spawn, execFile } from 'child_process';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';

// 防止嵌套检测（从 CC 内部启动时需要）
delete process.env.CLAUDECODE;

function parseConfigInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

// ========== Agent SDK 加载（失败则回退 CLI） ==========
let sdkQuery;
try {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  sdkQuery = sdk.query;
  console.log('[SDK] Agent SDK 加载成功');
} catch (e) {
  console.warn(`[SDK] Agent SDK 加载失败，将使用 CLI 模式: ${e.message}`);
}

// ========== 配置 ==========
const CONFIG = {
  // 云端任务 API 地址（改成你的腾讯云服务器）
  serverUrl: process.env.WORKER_URL || 'http://127.0.0.1:3456',
  // 认证 Token（和云端保持一致）
  token: process.env.WORKER_TOKEN || 'change-me-to-a-secure-token',
  // 调和循环等待间隔（毫秒） - 仅在并发满时使用
  pollInterval: parseConfigInt(process.env.POLL_INTERVAL, 500, 50, 60000),
  // 调和领取窗口（毫秒） - 服务器 hold 住连接的时间
  longPollWait: parseConfigInt(process.env.LONG_POLL_WAIT, 30000, 1000, 300000),
  // 最大并发任务数
  maxConcurrent: parseConfigInt(process.env.MAX_CONCURRENT, 5, 1, 50),
  // 命令执行超时（毫秒）- 10分钟，适配 Gemini/Codex 慢任务
  defaultTimeout: 600000,
  // OpenClaw Hooks 回调配置（CC 完成后通知 bot）
  openclawHooksUrl: process.env.OPENCLAW_HOOKS_URL || 'http://127.0.0.1:18791',
  openclawHooksToken: process.env.OPENCLAW_HOOKS_TOKEN || 'cc-callback-2026',
  callbackApiBaseUrl: process.env.CALLBACK_API_BASE_URL || 'https://discord.com/api/v10',
  // runner 本地 provider session cache，仅供本机 resume / 映射恢复使用
  runnerSessionCacheFile: process.env.RUNNER_SESSION_CACHE_FILE || '/tmp/openclaw-runner-session-cache.json',
};

if (CONFIG.token === 'change-me-to-a-secure-token') {
  console.warn('⚠ WARNING: Using default WORKER_TOKEN. Set WORKER_TOKEN env var for production!');
}

console.log('========================================');
console.log('  Docker-first Local Runner 启动');
console.log('========================================');
console.log(`Task API: ${CONFIG.serverUrl}`);
console.log(`调和等待窗口: ${CONFIG.longPollWait}ms`);
console.log(`最大并发: ${CONFIG.maxConcurrent} 个任务`);
console.log(`执行模式: ${sdkQuery ? 'Agent SDK (优先)' : 'CLI (回退)'}`);
console.log(`Runner cache: ${CONFIG.runnerSessionCacheFile}`);
console.log('');
console.log('支持的任务类型:');
console.log('  - command: 执行 shell 命令');
console.log('  - file-read: 读取文件');
console.log('  - file-write: 写入文件');
console.log('  - file-edit: 编辑文件（局部替换）');
console.log('  - claude-cli: 调用本地 Claude Code (SDK/CLI)');
console.log('  - codex-cli: 调用本地 Codex CLI');
console.log('  - gemini-cli: 调用本地 Gemini CLI');
console.log('');

// ========== HTTP 请求封装 ==========
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
    // 调和领取请求的超时要大于服务器 hold 时间，避免提前断开
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

// ========== 执行命令 ==========
// NOTE: exec() 在此处是有意使用的——worker 本身就是命令执行服务
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

// ========== 文件操作 ==========
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
      console.log(`[写入] ${fullPath}`);

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
      console.log(`[编辑] ${fullPath}`);

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
        // 非全局替换时，检查 old_string 是否唯一
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

// ========== Runner 本地 provider session cache ==========
// 职责单一：只用于 runner 重启后恢复 SDK session resume。
// 权威状态在 server.js 的 taskDb/sessionDb（SQLite），这里不是第二个状态主人。
const SESSION_FILE = CONFIG.runnerSessionCacheFile;
const liveSessions = new Map();   // sdkSessionId → { lastActivity, callbackChannel }
const sessionIdMap = new Map();   // taskApiSessionId → sdkSessionId（映射表）
const ccSessions = new Set();     // CLI 模式用：跟踪已创建的 CC 会话

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
      // 该天目录不存在，跳过
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
      console.log(`[Codex Session] 前缀匹配: ${sessionId} → ${candidates[0].sessionId}`);
    }
    return candidates[0].sessionId;
  }

  return null;
}

// 短 ID 前缀匹配：/cc-recent 显示 8 位截断 ID，resume 需要完整 UUID
function resolveSessionPrefix(prefix) {
  if (!prefix) return prefix;
  // 已经是完整 UUID（含连字符 36 位，纯 hex 32 位）→ 直接返回
  if (prefix.length >= 32) return prefix;

  const sessionDir = path.join(process.env.HOME, '.claude', 'projects', '-Users-' + path.basename(process.env.HOME));
  try {
    const files = fs.readdirSync(sessionDir);
    const matches = files.filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'));
    if (matches.length === 1) {
      const fullId = matches[0].replace('.jsonl', '');
      console.log(`[Session] 前缀匹配: ${prefix} → ${fullId}`);
      return fullId;
    } else if (matches.length > 1) {
      // 多个匹配 → 取最近修改的
      const sorted = matches
        .map(f => ({ file: f, mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const fullId = sorted[0].file.replace('.jsonl', '');
      console.log(`[Session] 前缀 ${prefix} 匹配到 ${matches.length} 个会话，取最新: ${fullId}`);
      return fullId;
    }
  } catch { /* 目录不存在 */ }
  return prefix; // 没找到，返回原值让下游处理
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
      // 恢复映射关系
      if (s.taskApiId) {
        sessionIdMap.set(s.taskApiId, s.sessionId);
      }
    }
    console.log(`[会话] 恢复了 ${liveSessions.size} 个 runner cache 记录`);
  } catch {
    // 文件不存在或格式错误，忽略
  }
}

function saveSessions() {
  try {
    // 反向查找 taskApiId
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
    console.error('[会话] 保存失败:', e.message);
  }
}

loadSessions();

// 注：runner 本地 cache 的过期清理由 server 侧 cleanupExpiredSessions() 统一管理。
// runner 这里不再另起定时器，避免双重清理职责混淆。

// ========== Bot callback push (current compatibility path defaults to Discord API) ==========
const CALLBACK_BOT_TOKEN = process.env.CALLBACK_BOT_TOKEN || '';
const DISCORD_PROXY = process.env.DISCORD_PROXY || 'http://127.0.0.1:7897';

/**
 * 通过可注入的 bot callback API 发送消息。
 * 当前默认仍是 Discord channel message API；https 场景可选走代理。
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
        console.log(`[回调] 推送成功 (${prefix})${attempt > 1 ? ` [第${attempt}次]` : ''}`);
      } else if (attempt < maxRetries) {
        console.error(`[回调] 第${attempt}次失败 (${status})，${backoff/1000}s 后重试`);
        setTimeout(trySend, backoff);
      } else {
        console.error(`[回调] ${maxRetries}次均失败 (${status}): ${typeof data === 'string' ? data.slice(0, 100) : ''}`);
      }
    }).catch(err => {
      if (attempt < maxRetries) {
        console.error(`[回调] 第${attempt}次错误，${backoff/1000}s 后重试: ${err.message}`);
        setTimeout(trySend, backoff);
      } else {
        console.error(`[回调] ${maxRetries}次均失败: ${err.message}`);
      }
    });
  }

  trySend();
}

// ========== 消息过滤 & 格式化（SDK 模式用） ==========
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

// ========== Agent SDK 执行 ==========
async function executeClaudeSDK(prompt, timeout, sessionId, callbackChannel, model) {
  const startTime = Date.now();

  // 判断 sessionId 是否对应一个真实的 CC session 文件（终端开的会话）
  // 如果是，直接用它做 resume，不走 sessionIdMap（避免脏映射覆盖）
  let sdkSessionId = null;
  if (sessionId) {
    const projectDir = path.join(process.env.HOME, '.claude', 'projects', '-Users-' + path.basename(process.env.HOME));
    const sessionFile = path.join(projectDir, sessionId + '.jsonl');
    if (fs.existsSync(sessionFile)) {
      // 真实 CC session 文件存在 → 直接 resume 这个终端会话
      sdkSessionId = sessionId;
    } else {
      // 精确文件不存在 → 先尝试短 ID 前缀匹配
      if (!sessionId.includes('-') || sessionId.length < 36) {
        try {
          const matches = fs.readdirSync(projectDir)
            .filter(f => f.startsWith(sessionId) && f.endsWith('.jsonl'));
          if (matches.length === 1) {
            sdkSessionId = matches[0].replace('.jsonl', '');
            console.log(`[SDK] 短 ID 前缀匹配: ${sessionId} → ${sdkSessionId.slice(0, 8)}...`);
          } else if (matches.length > 1) {
            console.warn(`[SDK] 短 ID ${sessionId} 匹配到 ${matches.length} 个 session，跳过`);
          }
        } catch { /* projectDir 不存在 */ }
      }
      // 前缀也没匹配到 → 走 sessionIdMap 映射
      if (!sdkSessionId) {
        sdkSessionId = sessionIdMap.get(sessionId) || null;
        if (!sdkSessionId) {
          // 从文件重新加载映射（其他 worker 进程可能已写入）
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
            if (sdkSessionId) console.log(`[SDK] 从文件恢复映射: API:${sessionId.slice(0, 8)} → SDK:${sdkSessionId.slice(0, 8)}`);
          } catch { /* 文件不存在或格式错误 */ }
        }
      }
    }
  }
  const isResume = !!sdkSessionId;

  console.log(`[SDK] ${isResume ? '续接' : '新建'}会话: "${prompt.slice(0, 50)}..."${sessionId ? ' [API:' + sessionId.slice(0, 8) + (sdkSessionId ? ' → SDK:' + sdkSessionId.slice(0, 8) : '') + ']' : ''}`);

  // 构建 options（resume 也需要权限配置，否则子进程立即退出）
  // model 由调用方传入，支持 fallback 重试
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

  // 流式输出 debounce
  let buffer = [];
  let debounceTimer = null;
  const DEBOUNCE_MS = 3000;
  let capturedSessionId = sessionId || null;

  function flush() {
    // 不推流式进度到 bot chat，保持干净的聊天体验
    buffer = [];
    debounceTimer = null;
  }

  let resultText = '';
  let resultSubtype = 'success';
  let resultErrors = [];

  // 超时保护
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
      // 捕获 session ID
      if (message.type === 'system' && message.subtype === 'init') {
        capturedSessionId = message.session_id;
        console.log(`[SDK] 会话 ID: ${capturedSessionId.slice(0, 8)}`);
      }

      // 格式化 assistant 消息
      if (message.type === 'assistant') {
        const formatted = formatAssistantMessage(message);
        if (formatted) {
          buffer.push(formatted);
          if (!debounceTimer) {
            debounceTimer = setTimeout(flush, DEBOUNCE_MS);
          }
        }
      }

      // 捕获最终结果
      if (message.type === 'result') {
        resultSubtype = message.subtype;
        if (message.subtype === 'success') {
          resultText = message.result || '';
        } else {
          resultErrors = message.errors || [];
          resultText = resultErrors.join('\n');
        }
        console.log(`[SDK] 结果: ${message.subtype}, 耗时 ${message.duration_ms}ms, 花费 $${message.total_cost_usd?.toFixed(4) || '?'}`);
      }
    }
  } catch (err) {
    clearTimeout(timeoutHandle);
    if (debounceTimer) clearTimeout(debounceTimer);
    flush();

    const isAbort = err.name === 'AbortError' || abortController.signal.aborted;
    console.error(`[SDK] ${isAbort ? '超时' : '错误'}: ${err.message}`);

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
  buffer = [];   // 清空残余，避免与 notifyCompletion 重复发送
  flush();

  const duration = Date.now() - startTime;

  // 更新会话池 + 映射表
  if (capturedSessionId) {
    liveSessions.set(capturedSessionId, {
      lastActivity: Date.now(),
      callbackChannel
    });
    // Task API sessionId → SDK session_id 映射
    if (sessionId && sessionId !== capturedSessionId) {
      sessionIdMap.set(sessionId, capturedSessionId);
      console.log(`[SDK] 映射: API:${sessionId.slice(0, 8)} → SDK:${capturedSessionId.slice(0, 8)}`);
    }
    ccSessions.add(capturedSessionId);
    saveSessions();
  }

  const isError = resultSubtype !== 'success';
  console.log(`[SDK] 完成，耗时 ${duration}ms，结果 ${resultText.length} 字符`);

  return {
    stdout: resultText,
    stderr: isError ? resultErrors.join('\n') : '',
    exitCode: isError ? 1 : 0,
    error: isError ? `SDK ${resultSubtype}` : null,
    duration,
    metadata: capturedSessionId ? { sessionId: capturedSessionId } : undefined
  };
}

// ========== Codex CLI 执行（支持 session 续接 + 指定模型）==========
function executeCodexCLI(prompt, timeout, sessionId, model) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const resolvedSessionId = resolveCodexSessionId(sessionId);
    console.log(`[Codex CLI] 执行${model ? ' [' + model + ']' : ''}: "${prompt.slice(0, 50)}..."${resolvedSessionId ? ' [resume:' + resolvedSessionId.slice(0, 8) + ']' : ''}`);

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
      // 从 stderr 提取 session id（格式：session id: <uuid>）
      const sessionMatch = stderr.match(/session id:\s*([a-f0-9-]+)/i);
      const capturedSessionId = sessionMatch ? sessionMatch[1] : null;
      console.log(`[Codex CLI] 完成，耗时 ${duration}ms，输出 ${stdout.length} 字节${capturedSessionId ? '，session:' + capturedSessionId.slice(0, 8) : ''}`);
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

// ========== Gemini CLI 执行（支持 session 续接）==========
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
    console.log(`[Gemini CLI] 执行 [${modelName}]: "${prompt.slice(0, 50)}..."${resumeLatest ? ' [resume:latest]' : ''}`);
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
      // 从 json 输出提取 session_id 和 response
      let capturedSessionId = null;
      let responseText = stdout.trim();
      try {
        const json = JSON.parse(stdout);
        capturedSessionId = json.session_id || null;
        responseText = json.response || responseText;
      } catch {}
      responseText = sanitizeGeminiResponse(responseText);
      console.log(`[Gemini CLI] 完成，耗时 ${duration}ms，输出 ${responseText.length} 字节${capturedSessionId ? '，session:' + capturedSessionId.slice(0, 8) : ''}`);
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

// ========== CLI 回退执行（原有逻辑） ==========
const CLAUDE_PATH = '/opt/homebrew/bin/claude';
const CODEX_PATH = '/opt/homebrew/bin/codex';
const GEMINI_PATH = '/opt/homebrew/bin/gemini';
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
    console.log(`[Claude CLI] 执行 [${useModel}]: "${prompt.slice(0, 50)}..."${sessionId ? ' [会话:' + sessionId.slice(0, 8) + ']' : ''}`);

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
    console.log(`[Claude CLI] 命令: ${CLAUDE_PATH} ${args.map(v => JSON.stringify(v)).join(' ')}`);

    // 写入实时日志
    try { fs.appendFileSync(CC_LOG, `\n${'='.repeat(60)}\n[${new Date().toISOString()}] CC 开始: ${prompt.slice(0, 80)}...\n${'='.repeat(60)}\n`); } catch (e) {}
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
      console.log(`[Claude CLI] 完成，耗时 ${duration}ms，输出 ${stdout.length} 字节`);

      try { fs.appendFileSync(CC_LOG, `\n[${new Date().toISOString()}] CC 结束 (${duration}ms, exit ${code})\n`); } catch (e) {}

      const screenshotMatch = stdout.match(/PLEASE_UPLOAD_TO_DISCORD:\s*(.+\.png)/);
      const screenshotPath = screenshotMatch ? screenshotMatch[1].trim() : null;

      if (screenshotPath) {
        console.log(`[Claude CLI] 检测到截图: ${screenshotPath}`);
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

// ========== 完成通知（最终结果推回 bot 侧 callback channel） ==========
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
    console.error(`[事件] ${type} 上报失败: ${err.message}`);
  });
}

function notifyCompletion(task, result) {
  if (!CLI_TASK_TYPES.has(task.type) || !task.callbackChannel) return;
  if (task.responseMode && task.responseMode !== 'direct-callback') return;

  const label = CLI_LABELS[task.type] || task.type;
  const output = (result.stdout || '').slice(-1800) || '(无输出)';

  if (result.exitCode !== 0) {
    const duration = result.duration ? `${Math.round(result.duration / 1000)}s` : '未知';
    notifyDiscord(task.callbackChannel, task.sessionId, output, `❌ ${label} 失败（${duration}）`, task.callbackBotToken);
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
          console.log(`[回调] ${label} 输出已推送 ${describeTaskMode(task)}${attempt > 1 ? ` [第${attempt}次]` : ''}`);
          reportTaskEvent(task, 'callback.sent', {
            channel: task.callbackChannel,
            attempts: attempt,
            status,
          });
        } else if (attempt < maxRetries) {
          console.error(`[回调] 推送失败 (${status})，${backoff/1000}s 后重试`);
          setTimeout(trySend, backoff);
        } else {
          console.error(`[回调] ${label} ${maxRetries}次推送均失败 (${status})`);
          reportTaskEvent(task, 'callback.failed', {
            channel: task.callbackChannel,
            attempts: attempt,
            status,
          });
        }
      }).catch(err => {
        if (attempt < maxRetries) {
          console.error(`[回调] 推送错误，${backoff/1000}s 后重试: ${err.message}`);
          setTimeout(trySend, backoff);
        } else {
          console.error(`[回调] ${label} ${maxRetries}次推送均失败: ${err.message}`);
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

// ========== 并发任务管理 ==========
let isRunning = true;
let consecutiveErrors = 0;
const runningTasks = new Set();

async function executeTask(task) {
  const taskId = task.id.slice(0, 8);

  try {
    let result;

    if (task.type === 'file-write') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [文件写入] ${taskId}... - ${task.path.trim()}`);
      result = await writeFileToDisk(task.path, task.content, task.encoding);
    } else if (task.type === 'file-read') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [文件读取] ${taskId}... - ${task.path}`);
      result = await readFileFromDisk(task.path);
    } else if (task.type === 'file-edit') {
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [文件编辑] ${taskId}... - ${task.path}`);
      result = await editFileOnDisk(task.path, task.oldString, task.newString, task.replaceAll);
    } else if (task.type === 'claude-cli') {
      // 短 ID 前缀解析（/cc-recent 显示 8 位，用户照抄后需要还原完整 UUID）
      if (task.sessionId) task.sessionId = resolveSessionPrefix(task.sessionId);
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [Claude ${sdkQuery ? 'SDK' : 'CLI'}] ${taskId} ${describeTaskMode(task)} - ${task.prompt?.slice(0, 50)}...`);
      // ack 已由 cc-bridge registerCommand 处理，worker 不再重复推
      // CC 模型 fallback：Opus → Sonnet → 不指定（用 CC 默认）
      const CC_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6'];
      for (let i = 0; i < CC_MODELS.length; i++) {
        const model = CC_MODELS[i];
        try {
          if (sdkQuery) {
            result = await executeClaudeSDK(task.prompt, task.timeout, task.sessionId, task.callbackChannel, model);
          } else {
            result = await executeClaudeCLI(task.prompt, task.timeout, task.sessionId, model);
          }
          // 成功或正常退出（exitCode 非 0 也算完成，不重试）
          break;
        } catch (err) {
          const isLast = i === CC_MODELS.length - 1;
          console.warn(`[CC Fallback] ${model} 失败: ${err.message}${isLast ? '' : '，降级 ' + CC_MODELS[i + 1]}`);
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
      console.log(`[${runningTasks.size}/${CONFIG.maxConcurrent}] [命令] ${taskId}... - ${task.command}`);
      result = await executeCommand(task.command, task.timeout);
    }

    if ((task.type === 'codex-cli' || task.type === 'gemini-cli') && result.metadata?.sessionId) {
      rememberMappedSession(task.sessionId, result.metadata.sessionId, task.callbackChannel);
    }

    // 上报结果
    await request('POST', '/worker/result', {
      taskId: task.id,
      ...result
    });

    // CC 任务完成后回调通知 bot 侧 channel
    notifyCompletion(task, result);

    const status = result.exitCode === 0 ? '✓' : '✗';
    console.log(`[完成] ${status} ${taskId}... (剩余: ${runningTasks.size - 1})`);

  } catch (err) {
    console.error(`[错误] ${taskId}... - ${err.message}`);
    try {
      await request('POST', '/worker/result', {
        taskId: task.id,
        stdout: '',
        stderr: err.message,
        exitCode: -1,
        error: err.message
      });
    } catch (reportErr) {
      console.error(`[上报失败] ${taskId}... - ${reportErr.message}`);
    }
  } finally {
    runningTasks.delete(task.id);
  }
}

// 主调和循环：hook 优先，长轮询负责领取任务和兜底恢复
async function runReconcilerLoop() {
  while (isRunning) {
    try {
      if (runningTasks.size >= CONFIG.maxConcurrent) {
        await sleep(CONFIG.pollInterval);
        continue;
      }

      const pollRes = await request('GET', `/worker/poll?wait=${CONFIG.longPollWait}`);

      if (pollRes.status === 401) {
        console.error('[错误] Token 认证失败，请检查配置');
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
        console.error(`[连接失败] ${err.message}`);
      }
      console.log(`[重试] ${waitTime / 1000}s 后重试... (第 ${consecutiveErrors} 次)`);

      await sleep(waitTime);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== 导出活跃会话列表（供外部查询） ==========
export function getActiveSessions() {
  return Array.from(liveSessions.entries()).map(([sessionId, s]) => ({
    sessionId,
    lastActivity: s.lastActivity,
    callbackChannel: s.callbackChannel
  }));
}

// ========== 优雅退出 ==========
process.on('SIGINT', () => {
  console.log('\n[退出] 收到 Ctrl+C，正在停止...');
  isRunning = false;
  saveSessions();
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', () => {
  console.log('\n[退出] 收到终止信号，正在停止...');
  isRunning = false;
  saveSessions();
  setTimeout(() => process.exit(0), 1000);
});

// ========== 启动 ==========
runReconcilerLoop().catch(console.error);
