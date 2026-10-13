// Teams (contracts §21.2). Config `teams` is keyed by team id; without it the factory has one implicit
// team `core` that owns every repo. Every call takes (home, cfg) so the implicit team can list repos.
import { basename } from 'node:path';
import * as repos from './repos.mjs';

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

/** True when config.teams is a non-empty object. */
export function explicit(cfg) { return !!(cfg && isObj(cfg.teams) && Object.keys(cfg.teams).length); }

function implicitTeam(home, cfg) {
  const scope = (cfg.tracker && cfg.tracker.scope) || {};
  return {
    id: 'core', name: (cfg.project && cfg.project.name) || basename(repos.homeParent(home)) || 'core', kind: 'engineering',
    parent: null, repos: repos.names(home, cfg), roles: [], tracker: { team_key: scope.team_key || null, team_id: scope.team_id || null },
  };
}

function norm(id, t) {
  const tr = isObj(t.tracker) ? t.tracker : {};
  return {
    id, name: typeof t.name === 'string' && t.name ? t.name : id, kind: t.kind || 'engineering', parent: t.parent || null,
    repos: Array.isArray(t.repos) ? t.repos.filter((x) => typeof x === 'string') : [],
    roles: Array.isArray(t.roles) ? t.roles.filter((x) => typeof x === 'string') : [],
    tracker: { team_key: typeof tr.team_key === 'string' && tr.team_key ? tr.team_key : null, team_id: tr.team_id || null },
  };
}

/** All teams in config order: [{id, name, kind, parent, repos[], roles[], tracker {team_key, team_id}}]. */
export function list(home, cfg) {
  if (!explicit(cfg)) return [implicitTeam(home, cfg)];
  return Object.entries(cfg.teams).map(([id, t]) => norm(id, isObj(t) ? t : {}));
}

export function ids(home, cfg) { return list(home, cfg).map((t) => t.id); }

/** One team; throws (exit 1) when the id is unknown. */
export function get(home, cfg, id) {
  const t = list(home, cfg).find((x) => x.id === id);
  if (!t) {
    const e = new Error(`unknown team "${id}"; known: ${ids(home, cfg).join(', ')}`);
    e.exitCode = 1;
    throw e;
  }
  return t;
}

export function find(home, cfg, id) { return id ? list(home, cfg).find((x) => x.id === id) || null : null; }

/** Parent chain of a team, nearest first (cycles are cut). */
export function ancestors(home, cfg, id) {
  const all = new Map(list(home, cfg).map((t) => [t.id, t]));
  const out = []; const seen = new Set([id]);
  let cur = all.get(id) && all.get(id).parent;
  while (cur && all.has(cur) && !seen.has(cur)) { out.push(cur); seen.add(cur); cur = all.get(cur).parent; }
  return out;
}

/** The deepest team that lists the repo (more ancestors = deeper), or null. */
export function forRepo(home, cfg, repo) {
  if (!repo) return null;
  const hits = list(home, cfg).filter((t) => t.repos.includes(repo));
  if (!hits.length) return null;
  hits.sort((a, b) => ancestors(home, cfg, b.id).length - ancestors(home, cfg, a.id).length);
  return hits[0].id;
}

/** The team that owns a role (planner roles), or null. */
export function forRole(home, cfg, role) {
  if (!role) return null;
  const t = list(home, cfg).find((x) => x.roles.includes(role));
  return t ? t.id : null;
}

const up = (k) => String(k).toUpperCase();

/** Tracker team key of a team (upper case, as Linear keys are): its own key, else the nearest parent's, else null. */
export function trackerKey(home, cfg, teamId) {
  const t = find(home, cfg, teamId);
  if (!t) return null;
  if (t.tracker.team_key) return up(t.tracker.team_key);
  for (const a of ancestors(home, cfg, teamId)) {
    const p = find(home, cfg, a);
    if (p && p.tracker.team_key) return up(p.tracker.team_key);
  }
  return null;
}

/** Factory team ids whose tracker key (own or inherited) is `key`; teams that name the key themselves first. */
export function forTrackerKey(home, cfg, key) {
  if (!key) return [];
  const want = up(key); // keys compare case-insensitively
  const all = list(home, cfg);
  const own = all.filter((t) => t.tracker.team_key && up(t.tracker.team_key) === want).map((t) => t.id);
  const inherited = all.filter((t) => !own.includes(t.id) && trackerKey(home, cfg, t.id) === want).map((t) => t.id);
  return [...own, ...inherited];
}

/**
 * Team of a record set (§21.2 resolution order): task.team > epic.team > team of the task's or epic's
 * repo > team of the task's role > goal.lead_team > goal.team (streams) > goal.teams[0] > the team that
 * owns the default repo > the first team. Ids that are no longer configured are skipped.
 */
export function resolve(home, cfg, { task = null, epic = null, goal = null } = {}) {
  const known = new Set(ids(home, cfg));
  const ok = (id) => (id && known.has(id) ? id : null);
  // Repo work (an epic, or a code or docs task) resolves its repo; planner tasks without an epic have none.
  const repoWork = !!epic || !!(task && (task.epic_id || ['code', 'docs'].includes(task.kind)));
  const repo = (task && task.repo) || (epic && epic.repo) || (repoWork ? repos.defaultName(home, cfg) : null);
  return ok(task && task.team)
    || ok(epic && epic.team)
    || ok(forRepo(home, cfg, repo))
    || ok(forRole(home, cfg, task && task.role))
    || ok(goal && goal.lead_team)
    || ok(goal && goal.team)
    || ok(goal && Array.isArray(goal.teams) ? goal.teams[0] : null)
    || ok(forRepo(home, cfg, repos.defaultName(home, cfg)))
    || list(home, cfg)[0].id;
}
