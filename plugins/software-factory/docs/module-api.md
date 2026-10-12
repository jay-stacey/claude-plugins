# Module API between build teams (v1)

All modules are ES modules under `scripts/lib/`, Node >= 20, built-ins only, Windows-safe
(use `path`, `child_process.spawnSync/execFileSync` with arg arrays, never shell strings except where a
user command string must run through a shell). Every function is synchronous unless marked `async`.
Paths stored in records use forward slashes.

## Owned by Team CORE (A1a)

`paths.mjs`
- `findHome(cwd = process.cwd()) -> string|null` (git common dir rule; honors `FACTORY_HOME`)
- `repoRoot(home) -> string` (main checkout root = parent of home)
- `pluginRoot() -> string` (from `import.meta.url`)
- `cliPath() -> string` (absolute path to `scripts/factory.mjs`)
- `p(home, ...parts) -> string`

`fsutil.mjs`: `readJson(file, fallback)`, `writeJsonAtomic(file, obj)`, `appendLine(file, obj)`,
`ensureDir(dir)`, `withMutex(home, fn)`.

`store.mjs`
- `kinds`: `goal | epic | task | run | gate`
- `get(home, kind, id) -> record|null`
- `list(home, kind, filterFn?) -> record[]`
- `create(home, kind, fields) -> record` (assigns id, rev, timestamps, validates, updates index)
- `update(home, kind, id, mutator(rec) -> void|rec, {expectRev}?) -> record` (validates, bumps rev, updates index)
- `nextId(home, kind) -> string`

`events.mjs`: `emit(home, {type, source, actor, goal_id?, epic_id?, task_id?, run_id?, msg, data?, session_id?})`

`config.mjs`: `load(home) -> config (defaults merged)`, `defaults() -> config`

`hmac.mjs`
- `keyPath(home, pluginDataDir) -> string`
- `getKey(home, {pluginDataDir}?) -> Buffer` (creates the key on first use; reads `run/machine.json` for the plugin data dir when not given)
- `sign(req, key) -> hex` over `type + "\n" + canonicalJson(payload) + "\n" + id`
- `verify(req, key) -> bool`
- `canonicalJson(value) -> string` (sorted keys, no spaces)

`inbox.mjs`
- `HUMAN_TYPES` (types that require `sig`)
- `validate(req) -> {ok, errors[]}`
- `write(home, {type, payload, source, actor, needs_confirmation?, auto_apply?, dedupe_key?}, {sign: bool, key?}) -> req`
  (assigns id + created_at, signs when asked, writes tmp then renames; filename per contracts)
- `process(home, ctx) -> results[]` (used by `tick plan`)

`usage.mjs`
- `parseTranscript(file) -> {requests, by_model, bad_lines, first_ts, last_ts}` (dedupe by message.id, skip `<synthetic>`)
- `billed(byModel, weights) -> number`
- `writeSnapshot(home, snapshot)`, `latestSnapshots(home) -> Map(key -> snapshot)`
- `findAgentTranscript(sessionTranscriptPath, agentId) -> string`

`lifecycle.mjs`: `canMove(task, to, actor) -> {ok, reason}`, `move(home, taskId, to, {actor, reason, data})`

`flow.mjs`: `onTaskDone(home, task)`, `onGateDecided(home, gate)`, `advance(home)` (see contracts §5)

`brief.mjs`: `render(home, run) -> path`

`tick.mjs`: `begin(home, {session})`, `plan(home, {session})`, `end(home, {session, loop})`

`collect.mjs`: `collect(home) -> results[]`

`intent.mjs`: `writeIntent(home, sessionId, command)`, `hasIntent(home, sessionId, command, maxAgeS=900) -> bool`

## Owned by Team DELIVERY (A1b) — pure functions, no record I/O

`git.mjs`
- `git(args[], {cwd}) -> {code, stdout, stderr}`
- `headSha(cwd, ref = "HEAD") -> string|null`
- `branchExists(cwd, branch) -> bool`
- `worktreeList(cwd) -> [{path, head, branch|null, detached}]`
- `currentBranch(cwd) -> string|null`
- `isAncestor(cwd, a, b) -> bool`
- `slugify(text, max = 30) -> string`

`worktree.mjs`
- `prepare({cwd, repoRoot, branch, fromRef, mergeFirst[], detachSha?}) -> {worktree_path, branch, head_sha}`
  (removes any OTHER worktree holding `branch`; switches/creates the branch; merges `mergeFirst`;
  detaches at `detachSha` for reviewers/QA; throws `Error` with `.code = "MERGE_CONFLICT"` and `.files`)
- `removeAgentWorktree({repoRoot, worktreePath, agentBranch?}) -> {removed: bool}`
- `addDetached({repoRoot, dir, sha}) -> dir`, `remove({repoRoot, dir})`
- `pruneBranches({repoRoot, branches[]})`

`evidence.mjs`
- `run({runDir, label, command (string), cwd, source: "agent"|"cli", headSha?}) -> entry`
  (shell: `cmd.exe /d /s /c` on Windows, `/bin/sh -c` elsewhere; tee to `evidence/<label>-<n>.log`;
  append `evidence/index.jsonl`; ids `EV-<n>`)
- `readIndex(runDir) -> entry[]`

`checks.mjs`
- `spawnDetached({cliPath, home, runId}) -> pid` (spawns `node <cli> checks run --run R --home H`, detached, windowsHide)
- `runChecks({repoRoot, home, runId, runDir, sha, commands[], includeFiles[]}) -> {status: "pass"|"fail", failed_command|null, evidence[]}`
  (writes `run/checks/<runId>.json` at the end)
- `readResult(home, runId) -> {status, failed_command, finished_at}|null`

`integrate.mjs`
- `mergeTasks({repoRoot, home, epicBranch, baseRef, taskBranches[] (ordered), postMerge[]}) -> {merged: [branch], conflict: {branch, files[]}|null, post_merge: {status, failed_command}|null, head_sha}`

`gh.mjs` (honors env `FACTORY_GH` as the gh executable for tests)
- `available() -> {ok, user?, reason?}`
- `prCreate({cwd, base, head, title, bodyFile}) -> {number, url}`
- `prView({cwd, number}) -> {state, mergedAt, reviewDecision, mergeable, headRefOid}`
- `push({cwd, remote, branch}) -> {ok, stderr}`

`broker.mjs`
- `decide({tool_name, tool_input, agent_type, agent_id}, ctx) -> {decision: "allow"|"deny"|"pass", reason}`
  where `ctx = {home, pluginRoot, pluginDataDir, cliPath, run|null, task|null, config, role, worktreePath|null, outputPaths[]}`
  (`pass` = not a factory agent, let Claude Code decide). Rules: contracts §8.
- `splitCommand(cmd) -> string[]`

## Consumed by Team DASHBOARD (A4)

Reads files directly (read-only) per contracts §2-3. Writes inbox only via
`import { write } from '../../scripts/lib/inbox.mjs'` with `{sign: true}` and `hmac.getKey(home)`.
Uses `paths.findHome`. Must not import anything else from `scripts/lib` that writes.
