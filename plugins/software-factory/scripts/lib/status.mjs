// status (<= 20 lines) and the CTO checkpoint written before compaction.
import { join } from 'node:path';
import { readJson, writeTextAtomic } from './fsutil.mjs';
import * as store from './store.mjs';
import { readFactory, readLease, leaseLive } from './state.mjs';
import { ACTIVE_RUN } from './dispatch.mjs';
import { pending as inboxPending } from './inbox.mjs';

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export function lines(home, { goal = null } = {}) {
  const f = readFactory(home);
  const lease = readLease(home);
  const b = readJson(join(home, 'state', 'budget.json'), { goals: {} }) || { goals: {} };
  const out = [];
  out.push(`factory ${f.status}${f.status_reason ? ` (${f.status_reason})` : ''}; tick ${f.tick.count}; dispatcher ${lease && leaseLive(lease) ? lease.session_id.slice(0, 8) : 'none'}`);
  if (f.tick.next_wakeup_at) out.push(`next tick ${f.tick.next_wakeup_at}`);
  if (f.backoff_until && Date.parse(f.backoff_until) > Date.now()) out.push(`backoff until ${f.backoff_until}`);
  const goals = store.list(home, 'goal', (g) => (goal ? g.id === goal : !['done', 'cancelled'].includes(g.status)));
  for (const g of goals.slice(0, goal ? 1 : 6)) {
    const slot = b.goals && b.goals[g.id];
    const tasks = store.list(home, 'task', (t) => t.goal_id === g.id);
    const counts = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    const c = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
    out.push(`${g.id} ${g.status} ${g.priority} tier ${g.tier || '?'}: ${g.title.slice(0, 50)}`);
    out.push(`  tasks: ${c || 'none'}${slot ? `; tokens ${fmtTokens(slot.spent + slot.reserved)}/${fmtTokens(slot.limit)} (${slot.pct}%)` : ''}`);
  }
  const runs = store.list(home, 'run', (r) => ACTIVE_RUN.has(r.status) && (!goal || r.goal_id === goal));
  if (runs.length) out.push(`running: ${runs.slice(0, 6).map((r) => `${r.id} ${r.role} ${r.task_id}${r.status !== 'running' ? ` (${r.status})` : ''}`).join('; ')}`);
  const gates = store.list(home, 'gate', (g) => g.status === 'pending' && (!goal || g.goal_id === goal));
  if (gates.length) out.push(`waiting on you: ${gates.slice(0, 5).map((g) => `${g.id} ${g.type}${g.subject && g.subject.id ? ` ${g.subject.id}` : ''}`).join('; ')}`);
  const blocked = store.list(home, 'task', (t) => ['blocked', 'failed'].includes(t.status) && (!goal || t.goal_id === goal));
  if (blocked.length) out.push(`blocked/failed: ${blocked.slice(0, 5).map((t) => `${t.id} ${t.status}${t.blocked ? ` (needs ${t.blocked.needs})` : ''}`).join('; ')}`);
  const inb = inboxPending(home).length;
  if (inb) out.push(`inbox: ${inb} requests pending`);
  if (f.tick.last_error) out.push(`last error: ${f.tick.last_error.slice(0, 120)}`);
  return out.slice(0, 20);
}

export function writeCtoCheckpoint(home) {
  const body = ['# Factory dispatcher checkpoint', '', 'This session is the software-factory dispatcher. Keep running `/software-factory:tick`.', '', ...lines(home).map((l) => `- ${l}`), ''];
  const file = join(home, 'run', 'cto-checkpoint.md');
  writeTextAtomic(file, body.join('\n'));
  return file;
}
