---
name: approve
description: Reviews and decides pending software-factory gates - PRD (G1), spec (G2), mockups (G3), pull request (G4), budget, destructive, tracker and CTO improvement-proposal gates - showing the artifacts and recording approve, request changes or reject. Use when the user runs /software-factory:approve or asks to approve, review or decide a gate, PRD, spec, mockup, factory PR or CTO proposal.
argument-hint: "[GATE-0001]"
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion, Read
---

# Approve

Arguments: `$ARGUMENTS`. Run every command exactly as written. Only the user decides. Never pick an
answer for them, and never decide a gate they did not see.

## 1. Pick the gate

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" gate list`.
- None pending: say "No gates are waiting for you." and stop.
- A gate id in the arguments: use it.
- One pending: use it.
- More: ask with AskUserQuestion which one (oldest 3 as options, plus "Go through them in order").

## 2. Show it

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" gate show <GATE-id>`. Show, in at most 12 lines:
type, goal and subject, the summary, each artifact path as an absolute path, and the PR URL and
diffstat when present. Say the user can read the files in their editor or in the Approvals view of
`/software-factory:control-center`. If they ask a question about an artifact, read it and answer.
For a small goal, G1 and G2 open together: show both, then decide each one.

## 3. Ask and decide

Ask with AskUserQuestion. Then run:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" gate decide <GATE-id> --decision <approve|changes|reject> --notes '<notes>' --via cli`
(single quotes; write a single quote inside notes as `'\''`). For "changes" and "reject", ask in one
line "What should change?" (or "Why reject?") and wait; notes are required. For approve, notes are optional.

By gate type:
- G1, G2, G3: options "Approve", "Request changes", "Reject".
- G4 (pull request): say first: "You merge this pull request on GitHub. The factory sees the merge and
  closes the epic." Options: "Approve for merge", "Request changes", "Reject".
  After "Approve for merge" and the decide command, ask a second, separate question (header "Merge"):
  "Do you want me to merge pull request <url> into <base> now with the GitHub CLI? This cannot be undone
  from here." Options: "No, I will merge on GitHub (Recommended)", "Merge now (merge commit)",
  "Merge now (squash)". Only on an explicit "Merge now" choice run
  `gh pr merge <url> --merge` or `gh pr merge <url> --squash`. Never pass `--admin`.
- budget: show spent, limit and the suggested top-up. Options: "Add <suggested> tokens (Recommended)",
  "Add <2 x suggested> tokens", "Keep the goal blocked". Approve with `--add-tokens <N>`; "Keep the goal
  blocked" is `--decision reject`.
- destructive: show `request.action` and every `impact` line. Ask in full sentences: "This will <action>.
  It cannot be undone. Do you want to allow it?" Options: "Allow it", "Do not allow it" (reject).
- tracker: show what the tracker change wants to do. Options: "Accept", "Reject".
- improvement (a CTO proposal): run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" gate show <GATE-id> --json` and
  read `request.proposal`. Before you ask, show its title, why, expected effect, risk, and the
  change in plain words:
  - `config`: each key and its new value, next to the current value from
    `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" config get <key>`.
  - `overlay_note`: the role and the exact note that goes under "Local notes" in `.factory/roles/<role>.md`.
  - `advice`: say that approving only records it; nothing changes.
  Give the report path (`artifact.paths`) so the user can read the reasons. Options: "Approve and
  apply", "Request changes", "Reject". After the decide command, run `gate show <GATE-id> --json` and
  read `decision.notes`. Notes that start with `not applied:` mean the change failed and nothing
  changed; say why. Otherwise an approved `config` or `overlay_note` change was applied, and
  `advice` shows `advice recorded`.

## 4. Report

One line per decided gate: id, type, decision. If the CLI exits with code 1 and mentions human intent,
say: "Type /software-factory:approve yourself so the factory knows a person decided." If more gates are
pending, ask whether to continue with the next one.
