#!/usr/bin/env node
// Control center lifecycle: start | stop | status | open | restart  --project <dir> [--demo] [--no-open] [--port n]
// Prints short blocks that the control-center skill relays unchanged.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const LOG_CAP = 1024 * 1024;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--demo' || a === '--no-open' || a === '--json') out[a.slice(2)] = true;
    else if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; } else out._.push(a);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function request(port, method, p, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, timeout: 2000,
      headers: { 'X-Factory-Token': token, Host: `127.0.0.1:${port}`, ...(method === 'POST' ? { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}

async function resolveHome(project) {
  if (process.env.FACTORY_HOME) return path.resolve(process.env.FACTORY_HOME);
  const direct = path.join(project, '.factory');
  if (fs.existsSync(direct)) return direct;
  try {
    const paths = await import(pathToFileURL(fileURLToPath(new URL('../../scripts/lib/paths.mjs', import.meta.url))).href);
    const h = paths.findHome?.(project);
    if (h && fs.existsSync(h)) return h;
  } catch { /* core library missing: fall through */ }
  return null;
}

// Healthy server for this home, or null (stale run files are removed).
async function running(home, project) {
  const runFile = path.join(home, 'run', 'control-center.json');
  const rf = readJson(runFile);
  if (!rf) return null;
  if (alive(rf.pid)) {
    const h = await request(rf.port, 'GET', '/api/health', rf.token);
    if (h?.status === 200 && h.body?.instance_id === rf.instance_id && path.resolve(h.body.project_dir) === path.resolve(rf.project_dir)
      && (!project || path.resolve(rf.project_dir) === path.resolve(project))) {
      return { ...rf, health: h.body };
    }
  }
  fs.rmSync(runFile, { force: true });
  return null;
}

function openBrowser(url, home) {
  const cfg = readJson(path.join(home, 'config.json'));
  if (cfg?.control_center?.open_browser === false) return 'not opened: control_center.open_browser is false';
  if (process.env.CI || process.env.SSH_CONNECTION || process.env.SSH_TTY) return 'not opened: CI or SSH session';
  let cmd, args;
  if (process.platform === 'win32') { cmd = 'rundll32'; args = ['url.dll,FileProtocolHandler', url]; } else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; } else { cmd = 'xdg-open'; args = [url]; }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return 'opened in your browser';
  } catch {
    return 'open it in your browser';
  }
}

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return `${Math.max(s, 0)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m ago`;
}
function upFor(sec) {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}

function loopLine(h) {
  const l = h.loop || {};
  const next = l.next_tick_in_s == null ? '' : l.next_tick_in_s >= 0 ? `, next ~${Math.max(1, Math.round(l.next_tick_in_s / 60))}m` : '';
  return `Factory loop: ${String(l.label || 'unknown').toLowerCase()}${next}. Pending approvals: ${h.pending_gates ?? 0}.`;
}

async function start(home, project, args, { forceOpen = false } = {}) {
  const existing = await running(home, project);
  const url = (rf) => `http://127.0.0.1:${rf.port}/?k=${rf.token}`;
  if (existing) {
    const opened = forceOpen && !args['no-open'] ? openBrowser(url(existing), home) : 'already running';
    console.log(`Control center running: ${url(existing)}  (${opened})`);
    console.log(`PID ${existing.pid} - reused, up ${upFor(existing.health.uptime_s)}`);
    console.log(loopLine(existing.health));
    console.log('Stop it with /software-factory:control-center stop');
    return 0;
  }
  const runDir = path.join(home, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const logFile = path.join(runDir, 'control-center.log');
  try { if (fs.statSync(logFile).size > LOG_CAP) fs.renameSync(logFile, `${logFile}.1`); } catch { /* no log yet */ }
  const fd = fs.openSync(logFile, 'a');
  const argv = [SERVER, '--project', project, '--home', home];
  if (args.demo) argv.push('--demo');
  if (args.port) argv.push('--port', String(args.port));
  const child = spawn(process.execPath, argv, { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], cwd: project, env: process.env });
  child.unref();
  fs.closeSync(fd);
  const runFile = path.join(runDir, 'control-center.json');
  let rf = null;
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    rf = readJson(runFile);
    if (rf && rf.pid === child.pid) break;
    rf = null;
    if (child.exitCode !== null) break;
  }
  if (!rf) {
    console.log(`Control center did not start. See the log: ${logFile}`);
    return 1;
  }
  const preferred = readJson(path.join(home, 'config.json'))?.control_center?.port ?? 47610;
  const opened = args['no-open'] ? 'not opened' : openBrowser(url(rf), home);
  console.log(`Control center running: ${url(rf)}  (${opened})`);
  console.log(`PID ${rf.pid} - started just now${args.demo ? ' - demo mode, replaying fixture events' : ''}`);
  if (args.port === undefined && (rf.port < preferred || rf.port >= preferred + 20)) console.log(`Port range ${preferred}-${preferred + 19} busy; started on ${rf.port} instead.`);
  const h = await request(rf.port, 'GET', '/api/health', rf.token);
  if (h?.body) console.log(loopLine(h.body));
  if (args.demo) console.log(`Stop the demo with: node "${fileURLToPath(import.meta.url)}" stop --project "${project}"`);
  else console.log('Stop it with /software-factory:control-center stop');
  return 0;
}

async function stop(home) {
  const runFile = path.join(home, 'run', 'control-center.json');
  const rf = readJson(runFile);
  if (!rf || !alive(rf.pid)) {
    fs.rmSync(runFile, { force: true });
    console.log('Control center was not running.');
    return 0;
  }
  await request(rf.port, 'POST', '/api/shutdown', rf.token, {});
  for (let i = 0; i < 30 && alive(rf.pid); i++) await sleep(100);
  if (alive(rf.pid)) {
    try { process.kill(rf.pid); } catch { /* gone */ }
    for (let i = 0; i < 20 && alive(rf.pid); i++) await sleep(100);
  }
  const now = readJson(runFile);
  if (now && now.instance_id === rf.instance_id) fs.rmSync(runFile, { force: true });
  console.log(`Control center stopped (PID ${rf.pid}).`);
  return 0;
}

async function status(home, project) {
  const r = await running(home, project);
  const logFile = path.join(home, 'run', 'control-center.log');
  if (!r) {
    console.log('Control center is not running. Start it with /software-factory:control-center start');
    return 0;
  }
  const h = r.health;
  console.log(`Control center running: http://127.0.0.1:${r.port}/?k=${r.token}`);
  console.log(`PID ${r.pid} - up ${upFor(h.uptime_s)} - ${h.clients} browser(s) connected - ${h.watcher} every ${h.poll_ms} ms${h.demo ? ' - demo mode' : ''}`);
  console.log(loopLine(h));
  console.log(`Last factory event: ${ago(h.last_event_at)}. Log: ${logFile}`);
  return 0;
}

async function main() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) {
    console.log(`Node ${process.versions.node} found; need 20 or newer: https://nodejs.org`);
    return 1;
  }
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'start';
  if (!['start', 'stop', 'status', 'open', 'restart'].includes(cmd)) {
    console.log('Usage: cli.mjs start|stop|status|open|restart --project <dir> [--demo] [--no-open] [--port n]');
    return 2;
  }
  let project = path.resolve(args.project || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (args.demo && (cmd === 'start' || cmd === 'open' || cmd === 'restart')) {
    const { prepareDemo } = await import('./demo.mjs');
    project = prepareDemo();
    console.log(`Demo copy of the test fixture: ${project}`);
    return start(path.join(project, '.factory'), project, args, { forceOpen: true });
  }
  const home = await resolveHome(project);
  if (!home) {
    console.log('No factory here. Run /software-factory:setup first.');
    return 4;
  }
  if (cmd === 'stop') return stop(home);
  if (cmd === 'status') return status(home, project);
  if (cmd === 'restart') { await stop(home); return start(home, project, args, { forceOpen: true }); }
  return start(home, project, args, { forceOpen: cmd === 'open' });
}

main().then((code) => { process.exitCode = code; }, (e) => {
  console.log(`Control center error: ${e.message}`);
  process.exitCode = 1;
});
