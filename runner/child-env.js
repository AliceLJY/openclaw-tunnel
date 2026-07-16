const CONTROL_PLANE_SECRET_KEYS = Object.freeze([
  'WORKER_TOKEN',
  'CALLBACK_BOT_TOKEN',
  'DISCORD_BOT_TOKEN',
  'OPENCLAW_HOOKS_TOKEN',
]);

/**
 * Build the environment inherited by shell commands and AI CLIs without
 * leaking bridge-control credentials into those child processes.
 */
export function buildSanitizedChildEnv(source = process.env, extra = {}) {
  const env = { ...source, ...extra };
  for (const key of CONTROL_PLANE_SECRET_KEYS) delete env[key];
  return env;
}

export { CONTROL_PLANE_SECRET_KEYS };
