---
name: report
description: Shows the latest software-factory CTO report and the improvement proposals waiting for a decision; --now asks the CTO for a fresh report and --baseline shows the factory baseline of open pull requests and in-flight work. Use when the user runs /software-factory:report or asks for the CTO report, how the factory or a team is doing, what the CTO proposes, or what work is already in flight.
argument-hint: "[--now | --baseline]"
allowed-tools: Bash(node:*), Read
---

# Report

Arguments: `$ARGUMENTS`. Run every command exactly as written. This skill only shows and requests.
It never decides a gate and never changes config. On exit code 4 from any command, say "The factory
is not set up here. Run /software-factory:setup." and stop.

## `--baseline`

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" baseline show`. Relay the output as it is, at most 40 lines. If it
says there is no baseline yet, say: "The factory collects the first baseline when it starts. Run
/software-factory:start." Stop.

## `--now`

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" report request`. Show its output line. Then run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" status`:
- The factory is running: "The CTO writes the report on a coming tick. Run /software-factory:report
  again in a few minutes."
- Otherwise: "The report is queued. Run /software-factory:start so the CTO can write it."
Stop.

## No arguments

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" report list`.
   The first line reads `last report: <path|none> (<age>); last assess <age>`. The rows after it
   read `<YYYY-MM-DDTHH:MMZ> <kind> <path>`, newest first, and mix reports, assessments and cycle
   plans.
2. Use the path on the `last report:` line. If it says `none`, use the newest row whose kind is
   `report`. If there is neither, say "No CTO report yet. The first one comes
   after the factory finishes its first task, or ask for one with /software-factory:report --now."
   Then go to step 3. The path is relative
   to the factory folder (`.factory/` in this project, or in the workspace folder). Read it and
   show, in at most 12 lines:
   - its path, kind and time;
   - the 3 headline lines, as written;
   - the titles in its "Proposals" section.
   If the user asks about any part of the report, read it and answer from it.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" gate list`. List each pending gate of type `improvement`, one line
   each: gate id, proposal id and title. `gate list` cuts the summary at 80 characters; when the
   user asks for the full proposal, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" gate show <id> --json` and show
   `request.proposal`.
4. Close with one line:
   - Improvement gates are pending: "Approve or reject each proposal with /software-factory:approve.
     Approving a proposal applies its change."
   - None: "No proposals are waiting for you."

Do not add your own analysis, ratings or advice. The report is the CTO's.
