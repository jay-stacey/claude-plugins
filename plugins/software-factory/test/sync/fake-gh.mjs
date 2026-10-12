#!/usr/bin/env node
// Fake `gh api` for sync tests. State lives in the JSON file named by FAKE_GH_STATE. No network.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);
const st = JSON.parse(readFileSync(file, 'utf8'));
st.calls = st.calls || [];
const method = args[args.indexOf('--method') + 1] || 'GET';
const path = args.find((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '--method' && args[i - 1] !== '-H' && args[i - 1] !== '--input');
let input = '';
if (args.includes('--input')) { try { input = readFileSync(0, 'utf8'); } catch { input = ''; } }
const body = input ? JSON.parse(input) : null;
st.calls.push(`${method} ${path}`);
const tick = () => { st.clock = (st.clock || Date.parse('2026-10-12T10:00:00Z')) + 1000; return new Date(st.clock).toISOString(); };
const save = () => writeFileSync(file, JSON.stringify(st, null, 2));
class Done extends Error {}
const out = (obj) => { save(); process.stdout.write(JSON.stringify(obj)); throw new Done(); };
const fail = (code, msg) => { save(); process.stderr.write(`gh: ${msg} (HTTP ${code})\n`); process.exitCode = 1; throw new Done(); };
const view = (i) => ({ ...i, html_url: `https://github.com/o/r/issues/${i.number}`, repository_url: 'https://api.github.com/repos/o/r', labels: i.labels.map((n) => ({ name: n })) });

try {
if (st.failNext && st.failNext.length) { const f = st.failNext.shift(); fail(f.code, f.msg || 'failure'); }
const [p, q] = String(path).split('?');
const params = new URLSearchParams(q || '');
let m;
if (p === 'user') out({ id: 1, login: 'factory-bot' });
if (p === 'repos/o/r') out({ full_name: 'o/r' });
if (p === 'repos/o/r/labels' && method === 'GET') out(st.labels.map((n) => ({ name: n })));
if (p === 'repos/o/r/labels' && method === 'POST') { if (st.labels.includes(body.name)) fail(422, 'already_exists'); st.labels.push(body.name); out({ name: body.name }); }
if (p === 'repos/o/r/issues' && method === 'POST') {
  const n = ++st.n; const i = { id: 1000 + n, node_id: `N${n}`, number: n, title: body.title, body: body.body, labels: body.labels || [], state: 'open', state_reason: null, assignee: null, updated_at: tick() };
  st.issues.push(i); out(view(i));
}
if (p === 'repos/o/r/issues' && method === 'GET') {
  let list = st.issues;
  if (params.get('since')) list = list.filter((i) => i.updated_at >= params.get('since'));
  if (params.get('labels')) list = list.filter((i) => i.labels.includes(params.get('labels')));
  out(list.map(view));
}
if (p === 'repos/o/r/issues/comments') out(st.comments.filter((c) => !params.get('since') || c.updated_at >= params.get('since')).map((c) => ({ ...c, issue_url: `https://api.github.com/repos/o/r/issues/${c.issue}` })));
if ((m = /^repos\/o\/r\/issues\/(\d+)\/sub_issues$/.exec(p))) { st.sub.push([Number(m[1]), body.sub_issue_id]); out({}); }
if ((m = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(p))) {
  const c = { id: 5000 + (++st.n), issue: Number(m[1]), body: body.body, user: { login: 'factory-bot' }, created_at: tick(), updated_at: tick() };
  st.comments.push(c); out(c);
}
if ((m = /^repos\/o\/r\/issues\/(\d+)$/.exec(p))) {
  const i = st.issues.find((x) => x.number === Number(m[1]));
  if (!i) fail(404, 'Not Found');
  if (method === 'PATCH') { Object.assign(i, body); i.updated_at = tick(); }
  out(view(i));
}
if (p === 'search/issues') {
  const qq = params.get('q') || '';
  const id = /sf-id: ([GT]-\d+)/.exec(qq);
  out({ items: st.issues.filter((i) => id && String(i.body).includes(`sf-id: ${id[1]}`)).map(view) });
}
fail(404, `fake gh: no route for ${method} ${path}`);
} catch (e) { if (!(e instanceof Done)) throw e; }
