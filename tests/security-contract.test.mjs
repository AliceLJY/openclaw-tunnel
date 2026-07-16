import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildSanitizedChildEnv, CONTROL_PLANE_SECRET_KEYS } from '../runner/child-env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeWriter = path.join(repoRoot, 'scripts', 'write-runtime-config.mjs');
const fixture = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'runtime-input.json'), 'utf8'));

function readRepo(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function envValue(contents, key) {
  const prefix = `${key}=`;
  const line = contents.split('\n').find((entry) => entry.startsWith(prefix));
  assert.ok(line, `${key} must be present in generated env`);
  const raw = line.slice(prefix.length);
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replaceAll("\\'", "'").replaceAll('\\\\', '\\');
  }
  return raw;
}

test('runtime writer keeps generated credentials private, unprinted, and ignored', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-tunnel-security-test-'));
  const result = spawnSync(process.execPath, [runtimeWriter], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...fixture,
      OPENCLAW_TUNNEL_ROOT: tempRoot,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, 'runtime writer must succeed');
  assert.equal(result.stdout.includes(fixture.CALLBACK_BOT_TOKEN), false, 'stdout must not disclose callback credentials');
  assert.equal(result.stderr.includes(fixture.CALLBACK_BOT_TOKEN), false, 'stderr must not disclose callback credentials');

  const envPath = path.join(tempRoot, '.env');
  const runtimeDir = path.join(tempRoot, '.runtime');
  const runnerEnvPath = path.join(runtimeDir, 'runner.env');
  const pluginPath = path.join(runtimeDir, 'openclaw-plugin-config.json');
  const envContents = fs.readFileSync(envPath, 'utf8');
  const runnerEnvContents = fs.readFileSync(runnerEnvPath, 'utf8');
  const generatedWorkerToken = envValue(envContents, 'WORKER_TOKEN');
  const generatedPluginConfig = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
  const generatedPluginValues = generatedPluginConfig.plugins.entries['cli-bridge'].config;
  const envProbe = spawnSync(process.execPath, [
    `--env-file=${envPath}`,
    '-e',
    'process.exit(/^[a-f0-9]{64}$/.test(process.env.WORKER_TOKEN || "") && process.env.CALLBACK_BOT_TOKEN ? 0 : 1)',
  ], { encoding: 'utf8' });
  const runnerEnvProbe = spawnSync(process.execPath, [
    `--env-file=${runnerEnvPath}`,
    '-e',
    'process.exit(/^[a-f0-9]{64}$/.test(process.env.WORKER_TOKEN || "") && !process.env.CALLBACK_BOT_TOKEN ? 0 : 1)',
  ], { encoding: 'utf8' });

  assert.ok(/^[a-f0-9]{64}$/.test(generatedWorkerToken), 'WORKER_TOKEN must contain 256 random bits encoded as hex');
  assert.equal(envProbe.status, 0, 'Node must be able to load the generated private env file');
  assert.equal(envProbe.stdout, '', 'env validation must not print credentials');
  assert.equal(envProbe.stderr, '', 'env validation must not print credentials');
  assert.equal(runnerEnvProbe.status, 0, 'runner env must contain only its worker credential, not the callback token');
  assert.equal(runnerEnvProbe.stdout, '', 'runner env validation must not print credentials');
  assert.equal(runnerEnvProbe.stderr, '', 'runner env validation must not print credentials');
  assert.equal(envValue(runnerEnvContents, 'WORKER_TOKEN'), generatedWorkerToken, 'runner and task API must share the worker token');
  assert.equal(result.stdout.includes(generatedWorkerToken), false, 'stdout must not disclose WORKER_TOKEN');
  assert.equal(result.stderr.includes(generatedWorkerToken), false, 'stderr must not disclose WORKER_TOKEN');
  assert.equal(generatedPluginValues.apiToken, generatedWorkerToken, 'plugin and task API must share the generated token');
  assert.equal(Object.hasOwn(generatedPluginValues, 'callbackBotToken'), false, 'setup must keep the task-api callback token out of plugin config');
  assert.equal(Object.hasOwn(generatedPluginValues, 'discordBotToken'), false, 'legacy mismatched key must not be generated');
  assert.equal(envValue(envContents, 'TASK_API_BIND'), '127.0.0.1', 'generated Compose bind must default to loopback');

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600, '.env must be mode 0600');
    assert.equal(fs.statSync(runnerEnvPath).mode & 0o777, 0o600, 'runner env must be mode 0600');
    assert.equal(fs.statSync(pluginPath).mode & 0o777, 0o600, 'plugin runtime config must be mode 0600');
    assert.equal(fs.statSync(runtimeDir).mode & 0o777, 0o700, 'runtime directory must be mode 0700');
  }

  for (const candidate of ['.env', '.runtime/runner.env', '.runtime/openclaw-plugin-config.json']) {
    const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', candidate], { cwd: repoRoot });
    assert.equal(ignored.status, 0, `${candidate} must be ignored by Git`);
  }

  const trackedManifest = JSON.parse(readRepo('plugin/openclaw.plugin.json'));
  assert.equal(Object.hasOwn(trackedManifest, 'config'), false, 'tracked plugin manifest must remain runtime-credential-free');
});

test('setup scopes callback credentials while preserving the optional plugin schema', () => {
  const setup = readRepo('setup.sh');
  const runnerInstaller = readRepo('runner/install.sh');
  const windowsRunner = readRepo('runner/start-worker.bat');
  const pluginSource = readRepo('plugin/index.ts');
  const manifest = JSON.parse(readRepo('plugin/openclaw.plugin.json'));

  assert.match(setup, /read -rsp .*Callback bot token/, 'callback token input must be hidden');
  assert.doesNotMatch(setup, /echo[^\n]*WORKER_TOKEN|echo[^\n]*\$\{?WORKER_TOKEN/, 'setup must not print WORKER_TOKEN');
  assert.doesNotMatch(setup, /plugin\/openclaw\.plugin\.json/, 'setup must not mutate the tracked plugin manifest');
  assert.match(runnerInstaller, /--env-file=/, 'LaunchAgent must load the ignored private env file');
  assert.doesNotMatch(runnerInstaller, /<key>WORKER_TOKEN<\/key>/, 'LaunchAgent plist must not contain the bearer token');
  assert.match(runnerInstaller, /\.runtime\/runner\.env/, 'LaunchAgent must default to the scoped runner env file');
  assert.match(windowsRunner, /\.runtime\\runner\.env/, 'Windows launcher must prefer the scoped runner env file');
  assert.match(runnerInstaller, /<key>Umask<\/key>\s*<integer>63<\/integer>/, 'LaunchAgent must create private logs and cache files');
  assert.match(readRepo('runner/worker.js'), /process\.umask\(0o077\)/, 'manual runner launches must also create private files');
  assert.ok(manifest.configSchema.properties.callbackBotToken, 'manifest must declare callbackBotToken');
  assert.equal(Object.hasOwn(manifest.configSchema.properties, 'discordBotToken'), false, 'manifest must not declare the mismatched key');
  assert.match(pluginSource, /cfg\.callbackBotToken/, 'plugin runtime must read callbackBotToken');
  assert.doesNotMatch(pluginSource, /cfg\.discordBotToken/, 'plugin runtime must not read the mismatched key');
});

test('child processes do not inherit bridge control-plane credentials', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/tmp/example-home',
    ANTHROPIC_API_KEY: 'provider-key-kept-for-cli',
    WORKER_TOKEN: 'worker-secret',
    CALLBACK_BOT_TOKEN: 'callback-secret',
    DISCORD_BOT_TOKEN: 'legacy-callback-secret',
    OPENCLAW_HOOKS_TOKEN: 'hooks-secret',
  };
  const childEnv = buildSanitizedChildEnv(source, { TERM: 'xterm-256color' });

  for (const key of CONTROL_PLANE_SECRET_KEYS) {
    assert.equal(Object.hasOwn(childEnv, key), false, `${key} must not reach child processes`);
  }
  assert.equal(childEnv.ANTHROPIC_API_KEY, source.ANTHROPIC_API_KEY, 'provider auth required by the CLI must remain available');
  assert.equal(childEnv.TERM, 'xterm-256color');
});

test('documentation and Compose defaults require a protected remote transport', () => {
  const readme = readRepo('README.md');
  const readmeCn = readRepo('README_CN.md');
  const compose = readRepo('docker-compose.yml');
  const envExample = readRepo('.env.example');
  const worker = readRepo('runner/worker.js');
  const taskApi = readRepo('task-api/server.js');
  const dockerfile = readRepo('task-api/Dockerfile');
  const ci = readRepo('.github/workflows/ci.yml');
  const manifest = JSON.parse(readRepo('plugin/openclaw.plugin.json'));
  const combinedDocs = `${readme}\n${readmeCn}\n${compose}\n${envExample}`;

  assert.match(compose, /\$\{TASK_API_BIND:-127\.0\.0\.1\}:\$\{PORT:-3456\}/, 'Compose must publish on loopback by default');
  assert.doesNotMatch(compose, /0\.0\.0\.0/, 'Compose must not publish task-api on every host interface by default');
  assert.doesNotMatch(combinedDocs, /http:\/\/(?:your-server(?:\.com)?|<task-api-host>|<cloud-ip>)/i, 'remote examples must not use plaintext public HTTP');
  assert.match(readme, /trusted remote-execution bridge, not a sandbox/i, 'English docs must state the execution trust boundary');
  assert.match(readme, /HTTPS[\s\S]*VPN[\s\S]*SSH tunnel/i, 'English docs must lead with protected remote transports');
  assert.match(readmeCn, /可信远程执行桥，不是沙箱/, 'Chinese docs must state the execution trust boundary');
  assert.match(readmeCn, /HTTPS[\s\S]*VPN[\s\S]*SSH 隧道/i, 'Chinese docs must lead with protected remote transports');
  assert.match(worker, /It is not a sandbox or a security boundary/, 'runner source must not describe the prefix filter as isolation');
  assert.doesNotMatch(worker, /prevent shell injection/, 'runner source must not claim zsh -c prevents shell interpretation');
  assert.doesNotMatch(worker, /cc-callback-2026/, 'runner must not ship a hard-coded callback credential');
  assert.match(taskApi, /crypto\.timingSafeEqual/, 'task-api bearer comparison must use a timing-safe primitive');
  assert.match(dockerfile, /npm ci --omit=dev/, 'task-api image must install the audited lockfile exactly');
  assert.doesNotMatch(dockerfile, /docker-cli|docker\.sock/, 'task-api image must not carry unused Docker control-plane access');
  assert.equal(manifest.configSchema.properties.apiUrl.default, 'http://host.docker.internal:3456', 'plugin HTTP default must remain local-container-only');
  assert.match(ci, /uses: actions\/checkout@v7/, 'CI must use actions/checkout@v7');
});
