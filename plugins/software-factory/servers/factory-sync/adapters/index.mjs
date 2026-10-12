// Adapter factory. Secrets come only from the MCP server env (SF_*, filled from userConfig).
import { createNone } from './none.mjs';
import { createLinear } from './linear.mjs';
import { createGithub } from './github.mjs';
import { createJira } from './jira.mjs';

/** Env value, or '' when unset or left as an unexpanded ${user_config.*} placeholder. */
export function envVal(env, name) {
  const v = env[name];
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return /^\$\{[^}]*\}$/.test(s) ? '' : s;
}

export function syncEnabled(env) {
  const v = envVal(env, 'SF_SYNC_ENABLED').toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}

/** Which credential keys are missing for a provider (names only). */
export function missingCredentials(provider, env) {
  if (provider === 'linear') return envVal(env, 'SF_LINEAR_API_KEY') ? [] : ['linear_api_key'];
  if (provider === 'jira') return [['SF_JIRA_SITE', 'jira_site'], ['SF_JIRA_EMAIL', 'jira_email'], ['SF_JIRA_API_TOKEN', 'jira_api_token']].filter(([k]) => !envVal(env, k)).map(([, n]) => n);
  return []; // github falls back to the gh login
}

/**
 * deps: {env, fetch, ghExec, now}. scope: config.tracker.scope plus resolved ids (team_id ...).
 */
export function createAdapter(provider, scope = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  switch (provider) {
    case 'linear': return createLinear({ apiKey: envVal(env, 'SF_LINEAR_API_KEY'), fetch: deps.fetch || globalThis.fetch, scope, now });
    case 'github': {
      const token = envVal(env, 'SF_GITHUB_TOKEN') || null;
      return createGithub({ token, ...(deps.ghExec ? { ghExec: deps.ghExec } : {}), scope });
    }
    case 'jira': return createJira({ site: envVal(env, 'SF_JIRA_SITE'), email: envVal(env, 'SF_JIRA_EMAIL'), token: envVal(env, 'SF_JIRA_API_TOKEN'), fetch: deps.fetch || globalThis.fetch, scope, now });
    default: return createNone();
  }
}
