import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveRunnerHome(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function environmentPath(env) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === 'path');
  return key ? String(env[key] || '') : '';
}

export function buildExecutablePath(env = process.env, platform = process.platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const configuredEntries = environmentPath(env).split(delimiter).filter(Boolean);
  const platformEntries = platform === 'darwin'
    ? ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']
    : platform === 'win32'
      ? []
      : ['/usr/local/bin', '/usr/bin', '/bin'];

  return [...new Set([...configuredEntries, ...platformEntries])].join(delimiter);
}

export function resolveCommandShell(command, {
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const configuredShell = String(env.WORKER_SHELL || '').trim();

  if (platform === 'win32') {
    const executable = configuredShell || env.ComSpec || env.COMSPEC || 'cmd.exe';
    const shellName = path.win32.basename(executable).toLowerCase().replace(/\.exe$/, '');
    return {
      executable,
      args: new Set(['powershell', 'pwsh']).has(shellName)
        ? ['-NoLogo', '-NoProfile', '-Command', command]
        : ['/d', '/s', '/c', command],
    };
  }

  const candidates = [configuredShell, env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh']
    .map((candidate) => String(candidate || '').trim())
    .filter(Boolean);
  const executable = candidates.find((candidate) => !path.isAbsolute(candidate) || existsSync(candidate)) || '/bin/sh';
  const shellName = path.basename(executable).toLowerCase();
  const supportsLoginFlag = new Set(['bash', 'fish', 'ksh', 'sh', 'zsh']).has(shellName);

  return {
    executable,
    args: supportsLoginFlag ? ['-l', '-c', command] : ['-c', command],
  };
}

export function normalizeExitCode(code) {
  return Number.isInteger(code) ? code : 1;
}

export function listClaudeSessionFiles(prefix, {
  projectsRoot,
  fsModule = fs,
} = {}) {
  const normalizedPrefix = String(prefix || '').trim();
  if (!normalizedPrefix || !/^[a-z0-9-]+$/i.test(normalizedPrefix)) return [];

  const root = projectsRoot || path.join(resolveRunnerHome(), '.claude', 'projects');
  const matches = [];
  let projectDirectories;

  try {
    projectDirectories = fsModule.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return matches;
  }

  for (const projectDirectory of projectDirectories) {
    const directoryPath = path.join(root, projectDirectory.name);
    try {
      for (const fileName of fsModule.readdirSync(directoryPath)) {
        if (!fileName.startsWith(normalizedPrefix) || !fileName.endsWith('.jsonl')) continue;
        const filePath = path.join(directoryPath, fileName);
        const stat = fsModule.statSync(filePath);
        if (!stat.isFile()) continue;
        matches.push({
          sessionId: fileName.slice(0, -'.jsonl'.length),
          filePath,
          mtime: stat.mtimeMs,
        });
      }
    } catch (error) {
      // A single stale or unreadable project directory must not prevent resume
      // lookup in the remaining projects.
      if (error?.code !== 'ENOENT' && error?.code !== 'EACCES' && error?.code !== 'EPERM') throw error;
    }
  }

  return matches.sort((left, right) => right.mtime - left.mtime);
}
