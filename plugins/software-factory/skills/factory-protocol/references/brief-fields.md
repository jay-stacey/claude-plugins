# Brief fields

The CLI renders `<factory_home>/runs/<run_id>/brief.md`: YAML front matter, then the task description
and the inlined overlay. Paths are absolute. Fields that do not apply to your role may be empty.

| Field | Meaning |
|---|---|
| `run_id`, `task_id`, `goal_id`, `epic_id` | Ids. `epic_id` is empty for planning tasks. |
| `role`, `kind` | Your role id and the task kind (`intake, prd, spec, mockup, breakdown, sequence, code, docs, qa_epic, qa_goal, review_epic, pr_feedback, escalation, research`). Run kinds such as `review`, `qa`, `fixup` and `integrate` also appear here. |
| `tier` | Goal tier `S`, `M` or `L`. Sets template line caps (`artifact-templates`). |
| `round` | 1 on the first attempt; 2+ on rework or a new review round. |
| `factory_home` | Absolute path to the main checkout's factory folder. The only `.factory` you use. |
| `cli` | Absolute path to the factory CLI script. |
| `constitution`, `overlay` | Absolute paths. Read both at start-up. |
| `goal_outcome` | The goal's outcome text, for context. |
| `acceptance_criteria` | `[{id, text}]`, verbatim. Fixed. Never edit. |
| `files_owned`, `files_shared`, `files_read` | Your write scope, append-only hotspots, and context. |
| `setup` | Exact first command for worktree roles (`worktree prepare --run <run_id>`). It creates the worktree and prints `PREPARED <path> <branch> <sha>` (`detached` instead of a branch for reviewers and QA). |
| `worktree`, `cd_prefix` | Worktree roles: your absolute worktree path, and `cd "<worktree>" && `. Start every Bash command with `cd_prefix`. |
| `workspace`, `repos` | Workspace mode only: `true`, and `[{name, path, stack, base_branch}]` for every repo the factory drives. |
| `repo` | Code runs in workspace mode: `{name, path, base_branch}` of your repo. Work only there. |
| `repo_worktrees`, `commands_by_repo` | `qa_goal` runs only: `[{repo, epic_id, path, branch, head_sha}]` and each repo's `commands`. |
| `validate` | Exact handoff validation command. Run before your final message. |
| `base_ref`, `branch` | Where your branch starts and your task (or epic) branch name. |
| `head_sha` | Reviewers and QA: the commit under test. |
| `evidence_required` | Labels the CLI expects to see (for example `build, lint, unit`). |
| `commands` | `build, test, lint, typecheck, run, e2e` strings from the config (from your repo in workspace mode). Run these exact strings. |
| `diff_cmd` | Reviewers: the exact read-only git command that shows the change under review. |
| `artifacts` | `prd, spec, plan, design` absolute paths when they exist. |
| `output_paths` | The only document paths you may write (planners and bench). |
| `feedback` | Prior findings, check logs and review reports to address (`{source, ref, path}`). |
| `answers` | Answers to earlier questions (`{question_id, text}` or a path). |
| `resume_from` | `{branch, commit, checkpoint_path}` when a paused or partial run is resumed. Read the checkpoint first. |
| `handoff_path` | Where you write `handoff.json`. |
| `token_hint` | Rough budget for this run. Aim to finish well inside it. |

If a field you need is missing or empty, do not guess a path. Use what the brief gives, and add a
non-blocking question for `cto` naming the missing field.
