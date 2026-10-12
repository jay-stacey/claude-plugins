// Permission broker for software-factory agents (Team DELIVERY). Contracts §8.
// decide() is pure: it inspects the tool call and the run context and returns allow / deny / pass.
// It never returns "ask": a background agent cannot answer a prompt.
import path from 'node:path';
import { normPath, isInside, relInside, toSlash } from './git.mjs';

const IS_WIN = process.platform === 'win32';
const PREFIX = 'software-factory:';
const PASS_AGENTS = new Set(['software-factory:setup-interviewer']);

export const REASON_DEFAULT = 'not on the factory allow list; ask in open_questions';

const allow = () => ({ decision: 'allow', reason: '' });
const deny = (reason) => ({ decision: 'deny', reason });

// ---------------------------------------------------------------- CLI subcommands per role

// Contracts §8 + §12.2 (read-only subcommands for every role).
const CLI_COMMON = ['handoff validate', 'evidence run', 'worktree prepare', 'status', 'task show', 'task list',
  'goal show', 'epic show', 'epic list', 'budget show', 'gate list', 'events tail'];
const CLI_EXTRA = {
  cto: ['goal set', 'task new', 'task replan', 'task retry', 'task cancel', 'task waive', 'task block', 'epic new', 'note'],
  'staff-engineer': ['epic new', 'task new'],
  'project-manager': ['task new', 'task replan'],
};
const CLI_SINGLE = new Set(['status', 'note']);

export function cliSubcommandsFor(role) {
  return new Set([...CLI_COMMON, ...(CLI_EXTRA[role] || [])]);
}

// ---------------------------------------------------------------- glob matching

const globCache = new Map();

/** Tiny glob matcher: `**`, `*`, `?`; a pattern without wildcards matches the path or anything under it. */
export function matchGlob(pattern, relPath) {
  if (!pattern || relPath == null) return false;
  let pat = toSlash(String(pattern).trim()).replace(/^\.\//, '');
  const rel = toSlash(String(relPath)).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!pat) return false;
  if (pat.endsWith('/')) pat += '**';
  const key = `${IS_WIN ? 'i' : 'c'}:${pat}`;
  let re = globCache.get(key);
  if (!re) {
    let src = '';
    const plain = !/[*?]/.test(pat);
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i];
      if (ch === '*') {
        if (pat[i + 1] === '*') {
          const slashAfter = pat[i + 2] === '/';
          src += slashAfter ? '(?:.*/)?' : '.*';
          i += slashAfter ? 2 : 1;
        } else {
          src += '[^/]*';
        }
      } else if (ch === '?') {
        src += '[^/]';
      } else {
        src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }
    // `dir/**` also matches `dir` itself; a plain path also matches everything under it.
    if (src.endsWith('/.*')) src = `${src.slice(0, -3)}(?:/.*)?`;
    else if (plain) src += '(?:/.*)?';
    re = new RegExp(`^${src}$`, IS_WIN ? 'i' : '');
    globCache.set(key, re);
  }
  return re.test(rel);
}

// ---------------------------------------------------------------- shell lexer

const SEPARATORS = ['&&', '||', ';', '|', '&', '\n'];

/**
 * Lex a bash command line into segments split on && || ; | & and newlines, respecting quotes.
 * Each segment: {raw, start, end, sep, tokens:[{value, raw}], redirects:[{op, target, targetRaw}], subst}.
 */
export function lexCommand(cmd) {
  const s = String(cmd ?? '');
  const segments = [];
  let seg = newSeg(0);
  let tok = null; // {value, raw}
  let i = 0;
  let error = null;

  function newSeg(start) {
    return { raw: '', start, end: start, sep: null, tokens: [], redirects: [], subst: false };
  }
  function endTok() {
    if (tok) {
      seg.tokens.push(tok);
      tok = null;
    }
  }
  function endSeg(sep, at, nextStart) {
    endTok();
    seg.end = at;
    seg.sep = sep;
    seg.raw = s.slice(seg.start, at).trim();
    segments.push(seg);
    seg = newSeg(nextStart);
  }
  function ensureTok() {
    if (!tok) tok = { value: '', raw: '' };
    return tok;
  }
  // Reads one word (with quotes) starting at i; returns {value, raw, next}.
  function readWord(j) {
    let value = '';
    let raw = '';
    while (j < s.length) {
      const c = s[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === ';' || c === '&' || c === '|' || c === '<' || c === '>') break;
      if (c === "'") {
        const k = s.indexOf("'", j + 1);
        if (k < 0) { error = 'unbalanced single quote'; return { value, raw, next: s.length }; }
        value += s.slice(j + 1, k); raw += s.slice(j + 1, k); j = k + 1; continue;
      }
      if (c === '"') {
        j++;
        while (j < s.length && s[j] !== '"') {
          if (s[j] === '\\' && j + 1 < s.length && '"\\$`\n'.includes(s[j + 1])) { value += s[j + 1]; raw += s[j] + s[j + 1]; j += 2; continue; }
          if (s[j] === '`' || (s[j] === '$' && s[j + 1] === '(')) seg.subst = true;
          value += s[j]; raw += s[j]; j++;
        }
        if (j >= s.length) { error = 'unbalanced double quote'; return { value, raw, next: s.length }; }
        j++; continue;
      }
      if (c === '\\' && j + 1 < s.length) { value += s[j + 1]; raw += c + s[j + 1]; j += 2; continue; }
      if (c === '`' || (c === '$' && s[j + 1] === '(')) seg.subst = true;
      value += c; raw += c; j++;
    }
    return { value, raw, next: j };
  }

  while (i < s.length && !error) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r') { endTok(); i++; continue; }
    if (c === '#' && !tok) {
      // comment to end of line
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') { endSeg('\n', i, i + 1); i++; continue; }
    if (c === ';') { endSeg(';', i, i + 1); i++; continue; }
    if (c === '&' && s[i + 1] === '&') { endSeg('&&', i, i + 2); i += 2; continue; }
    if (c === '|' && s[i + 1] === '|') { endSeg('||', i, i + 2); i += 2; continue; }
    if (c === '|') { const two = s[i + 1] === '&'; endSeg('|', i, i + (two ? 2 : 1)); i += two ? 2 : 1; continue; }
    if ((c === '<' || c === '>') && s[i + 1] === '(') { seg.subst = true; ensureTok().raw += c; tok.value += c; i++; continue; }
    if (c === '>' || c === '<' || (c === '&' && s[i + 1] === '>')) {
      // An all-digit token right before the operator is a file descriptor.
      if (tok && /^\d+$/.test(tok.raw)) tok = null;
      else endTok();
      let op = '';
      if (c === '&') { op = '&>'; i += 2; if (s[i] === '>') { op += '>'; i++; } }
      else if (c === '>') { op = '>'; i++; if (s[i] === '>' || s[i] === '|') { op += s[i]; i++; } }
      else { op = '<'; i++; if (s[i] === '<') { op += '<'; i++; if (s[i] === '<') { op += '<'; i++; } } else if (s[i] === '>') { op = '<>'; i++; } }
      if ((op === '>' || op === '<') && s[i] === '&') {
        // >&1, <&0, >&-
        let j = i + 1;
        while (j < s.length && /[0-9-]/.test(s[j])) j++;
        seg.redirects.push({ op: `${op}&`, target: `&${s.slice(i + 1, j)}`, targetRaw: `&${s.slice(i + 1, j)}` });
        i = j;
        continue;
      }
      while (s[i] === ' ' || s[i] === '\t') i++;
      if (op === '<<' && s[i] === '-') i++;
      const w = readWord(i);
      seg.redirects.push({ op, target: w.value, targetRaw: w.raw });
      i = w.next;
      continue;
    }
    if (c === '&') { endSeg('&', i, i + 1); i++; continue; }
    const w = readWord(i);
    const t = ensureTok();
    t.value += w.value;
    t.raw += w.raw;
    i = w.next;
  }
  if (!error) {
    endTok();
    seg.end = s.length;
    seg.raw = s.slice(seg.start).trim();
    segments.push(seg);
  }
  return { segments: segments.filter((x) => x.tokens.length || x.redirects.length), error };
}

/** Split a command line on && || ; | (and & / newlines), respecting quotes. Returns trimmed parts. */
export function splitCommand(cmd) {
  return lexCommand(cmd).segments.map((x) => x.raw).filter(Boolean);
}

// ---------------------------------------------------------------- helpers

function normCmd(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

function configCommands(config) {
  const out = new Set();
  const add = (v) => {
    if (Array.isArray(v)) v.forEach(add);
    else if (typeof v === 'string' && v.trim()) out.add(normCmd(v));
  };
  for (const v of Object.values(config?.commands || {})) add(v); // includes commands.extra[]
  for (const v of Object.values(config?.checks || {})) add(v);
  return out;
}

// Extra arguments after a configured command may not carry shell operators, redirection or substitution.
const UNSAFE_EXTRA = /[;&|<>`\n\r]|\$\(/;

/**
 * Contracts §12.3: text equals a configured command string, or starts with one followed by extra
 * arguments that contain no shell operators, redirection, backticks or `$(`.
 */
export function matchesConfigCommand(text, cmds) {
  const norm = normCmd(text);
  if (!norm) return false;
  for (const c of cmds) {
    if (norm === c) return true;
    if (norm.startsWith(`${c} `) && !UNSAFE_EXTRA.test(norm.slice(c.length))) return true;
  }
  return false;
}

// Contracts §13.2: `id_*` means SSH key names only, so normal files like id_utils.ts stay readable.
const SECRET_RE = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i];

function isSecretPath(p) {
  const base = path.posix.basename(toSlash(p));
  return SECRET_RE.some((re) => re.test(base));
}

/** Resolve a path written by an agent (raw token, Windows or POSIX form) against base. */
function resolveArg(raw, base) {
  let s = toSlash(raw);
  if (s.startsWith('~')) return null;
  if (IS_WIN && /^\/[a-zA-Z](\/|$)/.test(s)) s = `${s[1]}:${s.slice(2) || '/'}`;
  return normPath(s, base || process.cwd());
}

const NULL_TARGETS = new Set(['/dev/null', 'nul', 'NUL']);

function bareProgram(value) {
  let p = toSlash(value).split('/').pop().toLowerCase();
  if (p.endsWith('.exe')) p = p.slice(0, -4);
  return p;
}

const NETWORK = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'nc', 'ncat', 'netcat',
  'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'rsync', 'start-bitstransfer']);
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'grep', 'rg', 'find']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'merge-base', 'blame', 'grep', 'branch']);
const GIT_AUTHOR_WRITE = new Set(['add', 'commit', 'switch', 'checkout', 'restore', 'stash']);

// ---------------------------------------------------------------- context

function buildState(ctx, role) {
  const home = ctx.home ? normPath(ctx.home) : null;
  const run = ctx.run || null;
  const worktree = ctx.worktreePath ? normPath(ctx.worktreePath) : (run?.worktree_path ? normPath(run.worktree_path) : null);
  const kind = run?.kind || null;
  return {
    ctx,
    role,
    home,
    repoRoot: home ? normPath(path.dirname(home)) : null,
    dataDir: ctx.pluginDataDir ? normPath(ctx.pluginDataDir) : null,
    cli: ctx.cliPath ? normPath(ctx.cliPath) : (ctx.pluginRoot ? normPath(path.join(ctx.pluginRoot, 'scripts', 'factory.mjs')) : null),
    run,
    task: ctx.task || null,
    worktree,
    writer: Boolean(worktree && run && ['author', 'fixup', 'integrate'].includes(kind)),
    integrator: Boolean(worktree && kind === 'integrate' && role === 'devops-release'),
    configCmds: configCommands(ctx.config),
    cwd: ctx.cwd ? normPath(ctx.cwd) : null,
  };
}

function ownedGlobs(st) {
  // Contracts §12.1: for devops-release integrate runs, files_owned = the conflict files.
  if (st.run?.kind === 'integrate') {
    const conflict = st.ctx.integrate?.conflict_files || st.run?.integrate?.conflict_files;
    if (Array.isArray(conflict)) return conflict.filter(Boolean);
  }
  return [...(st.task?.files_owned || []), ...(st.task?.files_shared || [])].filter(Boolean);
}

function owns(st, rel) {
  return ownedGlobs(st).some((g) => matchGlob(g, rel));
}

// ---------------------------------------------------------------- Read

function decideRead(input, st) {
  const p = input?.file_path || input?.path || input?.notebook_path;
  if (!p) return allow();
  const abs = resolveArg(p, st.worktree || st.repoRoot);
  if (st.dataDir && abs && isInside(abs, st.dataDir)) return deny('the plugin data folder holds the factory key and is off limits; ask in open_questions');
  if (isSecretPath(p)) return deny('secret files (.env*, *.pem, *.key, id_*) are off limits; ask in open_questions if you need a value');
  return allow();
}

// Contracts §13.3: Glob and Grep may not target secret files or the plugin data folder.
const SECRET_PATTERN_RE = /(^|[\\/*{,])\.env|\.pem\b|\.key\b|\bid_(rsa|dsa|ecdsa|ed25519)\b/i;

function decideSearch(input, st) {
  const p = input?.path;
  if (p) {
    const abs = resolveArg(p, st.worktree || st.repoRoot);
    if (st.dataDir && abs && isInside(abs, st.dataDir)) return deny('the plugin data folder holds the factory key and is off limits; ask in open_questions');
    if (isSecretPath(p)) return deny('secret files (.env*, *.pem, *.key, id_*) are off limits; ask in open_questions if you need a value');
  }
  for (const pat of [input?.pattern && st.ctx.__tool === 'Glob' ? input.pattern : null, input?.glob].filter(Boolean)) {
    if (SECRET_PATTERN_RE.test(String(pat))) return deny('searching secret files (.env*, *.pem, *.key, id_*) is off limits; ask in open_questions if you need a value');
  }
  return allow();
}

// ---------------------------------------------------------------- Edit / Write

const RUN_DIR_BLOCKED = /^(evidence(\/|$)|run\.json$|result\.json$|brief\.md$)/i;

/** Contracts §12.4: the brief's output_paths (relative paths resolve against the factory home). */
function outputAllowed(abs, st) {
  const relHome = st.home ? relInside(abs, st.home) : null;
  for (const op of st.ctx.outputPaths || []) {
    if (!op) continue;
    if (/[*?]/.test(op)) {
      if (path.isAbsolute(op)) {
        // Absolute glob: match against the path itself.
        if (matchGlob(toSlash(op).replace(/^([a-zA-Z]):/, (m, d) => `${d.toUpperCase()}:`), abs)) return true;
      } else if (relHome != null && matchGlob(op, relHome)) {
        return true;
      }
      continue;
    }
    if (isInside(abs, normPath(op, st.home || st.repoRoot))) return true;
  }
  return false;
}

/** JSON state under the factory home (never writable by agents, even when listed as an output). */
function isHomeState(abs, st) {
  const rel = st.home ? relInside(abs, st.home) : null;
  if (rel == null) return false;
  if (/^docs\//i.test(rel)) return false;
  return /\.jsonl?$/i.test(rel) || /^(state|run|inbox|events|goals|epics|tasks|gates|sync|setup)(\/|$)/i.test(rel);
}

function decideWrite(input, st) {
  const p = input?.file_path || input?.notebook_path || input?.path;
  if (!p) return deny('no file path given');
  const abs = resolveArg(p, st.worktree || st.repoRoot);
  if (!abs) return deny('use an absolute path inside your worktree');
  if (st.dataDir && isInside(abs, st.dataDir)) return deny('the plugin data folder is off limits');

  // 1. Own run folder (handoff, checkpoint, notes) except CLI-owned files.
  if (st.home && st.run?.id) {
    const runRel = relInside(abs, path.join(st.home, 'runs', st.run.id));
    if (runRel != null && runRel !== '') {
      if (RUN_DIR_BLOCKED.test(runRel)) return deny('run.json, result.json, the brief and evidence/ are written only by the factory CLI; use `evidence run` for proof');
      return allow();
    }
  }
  // 1b. Worktree outbox: isolated agents cannot write outside their worktree, so their handoff and
  // reports go to <worktree>/.factory-out/ and the CLI imports them on collect.
  if (st.worktree && st.run?.id) {
    const outRel = relInside(abs, path.join(st.worktree, '.factory-out'));
    if (outRel != null && outRel !== '') return allow();
  }
  // 2. Output paths from the brief.
  if (outputAllowed(abs, st) && !isHomeState(abs, st)) return allow();

  // 3. Code authors: inside the worktree within files_owned / files_shared.
  const inWorktree = st.worktree && isInside(abs, st.worktree);
  if (inWorktree && st.writer) {
    const rel = relInside(abs, st.worktree);
    if (rel === '' || /^(\.git|\.factory)(\/|$)/i.test(rel)) return deny(`${rel || 'the worktree root'} is off limits; edit only your task files`);
    if (!ownedGlobs(st).length) return deny(`${st.task?.id || 'this task'} owns no files; ask in open_questions which files you may change`);
    if (owns(st, rel)) return allow();
    return deny(`${rel} is not in files_owned or files_shared for ${st.task?.id || 'this task'}; ask in open_questions`);
  }

  const relHome = st.home ? relInside(abs, st.home) : null;
  if (relHome != null) {
    if (relHome.startsWith('docs/')) return deny(`${relHome} is not one of your output paths; write only the paths named in your brief`);
    return deny('factory state under .factory/ is written only by the factory CLI; write your handoff and outputs only');
  }
  if (st.writer) return deny(`edit only inside your worktree ${st.worktree}`);
  return deny('your role does not edit project files; write only the output paths in your brief');
}

// ---------------------------------------------------------------- Bash

function decideBash(command, st, depth = 0) {
  const text = String(command ?? '');
  if (!text.trim()) return deny('empty command');
  const lex = lexCommand(text);
  if (lex.error) return deny(`could not parse the command (${lex.error}); ${REASON_DEFAULT}`);
  const segs = lex.segments;
  if (!segs.length) return deny('empty command');
  if (segs.some((x) => x.subst)) return deny('command substitution ($(...), backticks, <(...)) is not allowed; run each command on its own');

  // Whole command (or command after a leading cd) is a configured command (§12.3).
  if (matchesConfigCommand(text, st.configCmds)) return allow();
  if (segs.length > 1 && isCd(segs[0]) && segs[0].sep === '&&') {
    const rest = text.slice(segs[1].start);
    if (matchesConfigCommand(rest, st.configCmds)) {
      const r = cdTarget(segs[0], st, st.cwd);
      return r.deny ? deny(r.deny) : allow();
    }
  }

  let cwd = st.cwd;
  for (const seg of segs) {
    if (isCd(seg)) {
      const r = cdTarget(seg, st, cwd);
      if (r.deny) return deny(r.deny);
      cwd = r.cwd;
      continue;
    }
    const r = checkSegment(seg, st, cwd, depth);
    if (r.decision !== 'allow') return r;
  }
  return allow();
}

function isCd(seg) {
  return seg.tokens.length >= 1 && seg.tokens[0].value === 'cd' && !seg.redirects.length;
}

function cdTarget(seg, st, cwd) {
  if (seg.tokens.length !== 2) return { deny: 'use `cd "<your worktree>"` with one path' };
  const target = resolveArg(seg.tokens[1].raw, cwd || st.worktree || st.repoRoot);
  if (!target) return { deny: 'use an absolute path with cd' };
  if (st.worktree && isInside(target, st.worktree)) return { cwd: target };
  if (st.repoRoot && isInside(target, st.repoRoot)) return { cwd: target };
  return { deny: `stay inside your worktree${st.worktree ? ` (${st.worktree})` : ''}; cd elsewhere is blocked` };
}

function checkRedirects(seg, st, cwd) {
  let writes = false;
  for (const r of seg.redirects) {
    const out = r.op.includes('>');
    if (r.op.endsWith('&') || r.target.startsWith('&')) continue; // fd duplication, e.g. 2>&1
    if (out && NULL_TARGETS.has(r.target)) continue;
    if (r.op.startsWith('<<')) continue; // here-doc / here-string feeds stdin only
    const abs = resolveArg(r.targetRaw || r.target, cwd || st.worktree || st.repoRoot);
    if (abs && st.home && isInside(abs, st.home)) return { deny: 'do not write factory files with shell redirection; the factory CLI owns .factory/' };
    if (abs && st.dataDir && isInside(abs, st.dataDir)) return { deny: 'the plugin data folder is off limits' };
    if (!out && isSecretPath(r.target)) return { deny: 'secret files are off limits' };
    if (out) writes = true;
  }
  return { writes };
}

function checkSegment(seg, st, cwd, depth) {
  const red = checkRedirects(seg, st, cwd);
  if (red.deny) return deny(red.deny);
  if (!seg.redirects.length ? matchesConfigCommand(seg.raw, st.configCmds) : st.configCmds.has(normCmd(seg.raw))) return allow();
  if (red.writes) return deny('output redirection is not allowed; use `evidence run` to capture output');
  if (!seg.tokens.length) return deny(REASON_DEFAULT);

  const argv = seg.tokens;
  const prog = bareProgram(argv[0].value);
  const first = argv[0].value;

  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return deny(`environment assignments are ${REASON_DEFAULT}`);
  if (NETWORK.has(prog)) return deny('network tools are blocked for factory agents; ask in open_questions');
  if (prog === 'gh') return deny('gh is run only by the factory CLI; agents never call GitHub');
  if (prog === 'node') return checkNode(argv, st, cwd, depth);
  if (['python', 'python3', 'py'].includes(prog) && argv.some((t) => t.value === '-c')) return deny('python -c is blocked; ask in open_questions');
  if (prog === 'git') return checkGit(argv.slice(1), st, cwd);
  if (prog === 'rm') return checkRm(argv.slice(1), st, cwd);
  if (READ_ONLY.has(prog) && first === prog) return checkReadOnly(prog, argv.slice(1), st, cwd);
  return deny(`\`${first}\` is ${REASON_DEFAULT}`);
}

function isNodeExe(tok) {
  const v = tok.value;
  if (v === 'node' || v === 'node.exe') return true;
  return Boolean(process.execPath) && normPath(tok.raw) === normPath(process.execPath);
}

function isCliPath(tok, st, cwd) {
  if (!st.cli) return false;
  const abs = resolveArg(tok.raw, cwd || st.repoRoot);
  if (!abs) return false;
  return IS_WIN ? abs.toLowerCase() === st.cli.toLowerCase() : abs === st.cli;
}

function checkNode(argv, st, cwd, depth) {
  if (!isNodeExe(argv[0])) return deny(`\`${argv[0].value}\` is ${REASON_DEFAULT}`);
  const a1 = argv[1]?.value;
  if (['-e', '--eval', '-p', '--print', '-i', '--interactive'].includes(a1) || /^--(eval|print)=/.test(a1 || '')) {
    return deny('node -e is blocked; ask in open_questions');
  }
  // QA may run its own throwaway check scripts from <worktree>/.factory-out/qa/ (contracts §19.1).
  if (st.role === 'qa-engineer' && st.worktree && argv[1]) {
    const scriptTok = a1 === '--test' ? argv[2] : argv[1];
    const script = scriptTok ? resolveArg(scriptTok.raw ?? scriptTok.value, cwd || st.worktree) : null;
    const qaDir = path.join(st.worktree, '.factory-out', 'qa');
    if (script && isInside(script, qaDir) && /\.(mjs|cjs|js)$/i.test(script)) {
      const extra = argv.slice(a1 === '--test' ? 3 : 2).map((t) => t.value);
      if (extra.some((v) => v.startsWith('-'))) return deny('QA check scripts take plain arguments only');
      return allow();
    }
  }
  if (!argv[1] || !isCliPath(argv[1], st, cwd)) {
    return deny('node may run only the factory CLI at the path in your brief; use the exact project commands for anything else (QA: put check scripts in .factory-out/qa/)');
  }
  return checkCli(argv.slice(2), st, cwd, depth);
}

function checkCli(args, st, cwd, depth) {
  const positionals = [];
  const flags = {};
  let rest = null;
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    if (v === '--') { rest = args.slice(i + 1); break; }
    if (v === '--json') continue;
    if (v.startsWith('--')) {
      const eq = v.indexOf('=');
      if (eq > 0) { flags[v.slice(2, eq)] = { value: v.slice(eq + 1), raw: v.slice(eq + 1) }; continue; }
      const next = args[i + 1];
      if (next && !next.value.startsWith('--')) { flags[v.slice(2)] = next; i++; } else flags[v.slice(2)] = { value: 'true', raw: 'true' };
      continue;
    }
    positionals.push(v);
  }
  if (flags.home && st.home && normPath(flags.home.raw) !== st.home) return deny('use the factory home from your brief');
  if (!positionals.length) return deny('name a factory CLI subcommand');
  const sub = CLI_SINGLE.has(positionals[0]) ? positionals[0] : positionals.slice(0, 2).join(' ');
  const allowed = cliSubcommandsFor(st.role);
  if (!allowed.has(sub)) return deny(`factory CLI \`${sub}\` is not allowed for ${st.role}; ask in open_questions`);

  if (sub === 'worktree prepare' || sub === 'evidence run') {
    const runFlag = flags.run?.value;
    if (!st.run?.id || runFlag !== st.run.id) return deny(`use --run ${st.run?.id || '<your run id>'} (your own run)`);
  }
  if (sub === 'evidence run') {
    if (!rest || !rest.length) return deny('evidence run needs `-- <command>`');
    if (depth > 0) return deny('evidence run cannot be nested');
    const inner = rest.length === 1 ? rest[0].value : rest.map((t) => t.value).join(' ');
    const r = decideBash(inner, { ...st, cwd }, depth + 1);
    if (r.decision !== 'allow') return deny(`evidence command blocked: ${r.reason}`);
  }
  return allow();
}

const GIT_GLOBAL_OK = new Set(['--no-pager', '-P', '--no-optional-locks']);

function checkGit(args, st, cwd) {
  let i = 0;
  let gitCwd = cwd;
  while (i < args.length && args[i].value.startsWith('-')) {
    const v = args[i].value;
    if (v === '-C') {
      if (!args[i + 1]) return deny('git -C needs a path');
      gitCwd = resolveArg(args[i + 1].raw, cwd || st.worktree || st.repoRoot);
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_OK.has(v)) { i++; continue; }
    return deny(`git option ${v} is ${REASON_DEFAULT}`);
  }
  const sub = args[i]?.value;
  const rest = args.slice(i + 1).map((t) => t.value);
  if (!sub) return deny('name a git subcommand');
  if (sub === 'push') return deny('agents never push; the factory CLI pushes after review');

  if (GIT_READ.has(sub)) {
    if (rest.some((a) => a === '--output' || a.startsWith('--output='))) return deny('git --output writes files; read output directly instead');
    if (sub === 'grep' && rest.some((a) => a === '-O' || a.startsWith('--open-files-in-pager') || /^-O/.test(a))) return deny('git grep -O runs a pager; drop it');
    if (sub === 'branch') return checkGitBranch(rest);
    return allow();
  }

  const isWrite = GIT_AUTHOR_WRITE.has(sub) || sub === 'merge';
  if (!isWrite) return deny(`git ${sub} is ${REASON_DEFAULT}`);
  if (sub === 'merge' ? !st.integrator : !st.writer) {
    return deny(sub === 'merge' ? 'git merge is allowed only in devops-release integrate runs' : `git ${sub} is allowed only in author runs inside the run worktree`);
  }
  if (!gitCwd) return deny(`start the command with cd "${st.worktree}" && so git runs in your worktree`);
  if (!isInside(gitCwd, st.worktree)) return deny(`git ${sub} must run inside your worktree ${st.worktree}`);

  switch (sub) {
    case 'add':
    case 'restore':
      return allow();
    case 'commit':
      if (rest.some((a) => a === '--no-verify' || /^-[A-Za-z]*n[A-Za-z]*$/.test(a))) return deny('commit hooks must run; drop --no-verify');
      return allow();
    case 'switch': {
      const own = [st.run?.branch, st.task?.branch].filter(Boolean);
      const pos = rest.filter((a) => !['-q', '--quiet'].includes(a));
      if (pos.length === 1 && !pos[0].startsWith('-') && own.includes(pos[0])) return allow();
      return deny(`git switch is allowed only to your task branch ${own[0] || ''}`.trim());
    }
    case 'checkout': {
      const idx = rest.indexOf('--');
      if (idx >= 0 && idx <= 1 && rest.length > idx + 1 && rest.slice(0, idx).every((a) => !a.startsWith('-'))) return allow();
      return deny('only `git checkout -- <file>` is allowed; use git switch for your task branch');
    }
    case 'stash': {
      const verb = rest[0] || 'push';
      if (['push', 'save', 'list', 'show'].includes(verb) || verb.startsWith('-')) return allow();
      return deny('the stash stack is shared by all worktrees; commit work in progress instead of pop/apply/drop');
    }
    case 'merge':
      if (rest.includes('--no-verify')) return deny('merge hooks must run; drop --no-verify');
      return allow();
    default:
      return deny(`git ${sub} is ${REASON_DEFAULT}`);
  }
}

const BRANCH_MUTATE = new Set(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force',
  '-u', '--set-upstream-to', '--unset-upstream', '--edit-description', '--track', '-t', '--no-track']);

function checkGitBranch(rest) {
  if (rest.some((a) => BRANCH_MUTATE.has(a) || a.startsWith('--set-upstream-to=') || a.startsWith('--track='))) {
    return deny('git branch may only list branches (git branch --list)');
  }
  const listing = rest.includes('--list') || rest.includes('-l');
  const VALUE_FLAGS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format']);
  const positional = [];
  for (let k = 0; k < rest.length; k++) {
    if (VALUE_FLAGS.has(rest[k])) { k++; continue; }
    if (!rest[k].startsWith('-')) positional.push(rest[k]);
  }
  if (positional.length && !listing) return deny('git branch may only list branches (git branch --list)');
  return allow();
}

function checkRm(args, st, cwd) {
  if (!st.writer) return deny(`rm is ${REASON_DEFAULT}`);
  const targets = [];
  let opts = true;
  for (const t of args) {
    if (opts && t.value === '--') { opts = false; continue; }
    if (opts && t.value.startsWith('-')) continue;
    targets.push(t);
  }
  if (!targets.length) return deny('rm needs a file path');
  for (const t of targets) {
    if (/[*?[\]]/.test(t.value)) return deny('name each file to remove; wildcards are blocked');
    if (!cwd) return deny(`start the command with cd "${st.worktree}" &&`);
    const abs = resolveArg(t.raw, cwd);
    if (!abs || !isInside(abs, st.worktree)) return deny(`rm outside your worktree ${st.worktree} is blocked`);
    const rel = relInside(abs, st.worktree);
    if (!rel || /^(\.git|\.factory)(\/|$)/i.test(rel)) return deny('that path is off limits for rm');
    if (!owns(st, rel)) return deny(`${rel} is not in files_owned or files_shared; ask in open_questions`);
  }
  return allow();
}

function checkReadOnly(prog, args, st, cwd) {
  const vals = args.map((t) => t.value);
  if (prog === 'find' && vals.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a))) {
    return deny('find may only list files; -exec, -delete and -fprint are blocked');
  }
  if (prog === 'rg' && vals.some((a) => a === '--pre' || a.startsWith('--pre='))) return deny('rg --pre runs a program; drop it');
  if (['cat', 'head', 'tail', 'wc', 'grep', 'rg'].includes(prog)) {
    for (const t of args) {
      if (t.value.startsWith('-')) continue;
      if (isSecretPath(t.value)) return deny('secret files (.env*, *.pem, *.key, id_*) are off limits');
      const abs = resolveArg(t.raw, cwd || st.worktree || st.repoRoot);
      if (abs && st.dataDir && isInside(abs, st.dataDir)) return deny('the plugin data folder is off limits');
    }
  }
  return allow();
}

/** Contracts §12.3: only QA may start `commands.run` in the background (optionally after cd into its worktree). */
function decideBackground(command, st) {
  const runCmd = st.ctx.config?.commands?.run;
  const deny_ = deny('background commands are only for QA starting the app with commands.run; run commands in the foreground');
  if (st.role !== 'qa-engineer' || typeof runCmd !== 'string' || !runCmd.trim()) return deny_;
  const only = new Set([normCmd(runCmd)]);
  const text = String(command ?? '');
  const lex = lexCommand(text);
  if (lex.error || !lex.segments.length || lex.segments.some((x) => x.subst)) return deny_;
  if (matchesConfigCommand(text, only)) return allow();
  const segs = lex.segments;
  if (segs.length > 1 && isCd(segs[0]) && segs[0].sep === '&&' && matchesConfigCommand(text.slice(segs[1].start), only)) {
    const r = cdTarget(segs[0], st, st.cwd);
    return r.deny ? deny(r.deny) : allow();
  }
  return deny_;
}

// ---------------------------------------------------------------- entry point

/**
 * @param {{tool_name:string, tool_input:object, agent_type?:string, agent_id?:string}} call
 * @param {{home, pluginRoot, pluginDataDir, cliPath, run, task, config, role, worktreePath, outputPaths, cwd?}} ctx
 * @returns {{decision:'allow'|'deny'|'pass', reason:string}}
 */
export function decide({ tool_name, tool_input, agent_type } = {}, ctx = {}) {
  if (typeof agent_type !== 'string' || !agent_type.startsWith(PREFIX) || PASS_AGENTS.has(agent_type)) {
    return { decision: 'pass', reason: '' };
  }
  const role = ctx.role || agent_type.slice(PREFIX.length);
  const st = buildState(ctx || {}, role);
  try {
    switch (tool_name) {
      case 'Read':
        return decideRead(tool_input, st);
      case 'Edit':
      case 'Write':
      case 'MultiEdit':
      case 'NotebookEdit':
        if (!st.home) return deny('no factory context found; reply HANDOFF none blocked');
        return decideWrite(tool_input, st);
      case 'Bash':
        if (tool_input?.run_in_background) return decideBackground(tool_input.command, st);
        return decideBash(tool_input?.command, st, 0);
      case 'PowerShell':
        return deny('factory agents use the Bash tool; PowerShell commands are not brokered');
      case 'Glob':
      case 'Grep':
        return decideSearch(tool_input, { ...st, ctx: { ...st.ctx, __tool: tool_name } });
      default:
        return { decision: 'pass', reason: '' };
    }
  } catch (e) {
    return deny(`broker error (${String(e.message || e).slice(0, 120)}); ${REASON_DEFAULT}`);
  }
}
