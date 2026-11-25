# The example playbook

A playbook carries one repo's workflow into every session that works on it. `flow` puts its text into section 3 of each session's card, next to the role brief from `roles/`, which stays the same for every repo. This folder is a complete playbook for a repo that works with GitHub pull requests into `main` and keeps its specs and issues in Linear. In the repo it is a template (its `config.json` says `"template": true`): `flow` refuses to start a session from it directly. A copy made by `flow init --repo` drops that mark and is your own playbook.

## Start a playbook from it

```
flow init --playbook <name> --repo <path to your repo> --linear https://linear.app/<your-workspace>
```

This copies the folder to `~/.product-dev-flow/playbooks/<name>/`, sets `repo`, `linearWorkspaceUrl` (and `baseBranch` with `--base <branch>`) in its `config.json`, removes `"template": true`, and creates the state dir with `<name>` as its default playbook. The md files work as they are; edit them when your repo's workflow differs.

A second repo's playbook, once the state dir exists:

```
mkdir -p ~/.product-dev-flow/playbooks && cp -R <your clone>/playbooks/example ~/.product-dev-flow/playbooks/<name>/
```

then edit its `config.json` (set `repo`, `linearWorkspaceUrl` and `baseBranch`, delete the `"template": true` line) and start sessions with `--playbook <name>`.

Playbooks are found in `~/.product-dev-flow/playbooks/` first, then in the repo's own `playbooks/`; a name in both takes the private one. `FLOW_PLAYBOOKS` replaces both (tests).

## config.json

| Key | What it is | What to change |
| -- | -- | -- |
| `template` | Marks this folder as the template; `flow` refuses a playbook that still carries it. | Nothing: `flow init --repo` removes it. Delete it by hand in a `cp -R` copy. |
| `repo` | The main checkout of your repo. Sessions get their worktrees under it (`claude --bg -w`); `~/` is expanded. | Your repo's path (`--repo` sets it). |
| `baseBranch` | The branch PRs go into; the keeper reads it to tell merged branches. | Your base branch (`--base` sets it). The md files say `main` and tell sessions to read `baseBranch` for it. |
| `linearWorkspaceUrl` | Your Linear workspace, e.g. `https://linear.app/<your-workspace>`. Cards link each issue under it. | Your workspace (`--linear` sets it). |
| `permissionMode` | The Claude Code permission mode sessions start in. `auto` lets a session run without a prompt for each tool. | Keep `auto` unless you want to approve every step. |
| `models` | Short names for model ids, used by `defaults`, plan entries and `--model`. | Add or remove ids your account has. |
| `defaults` | `[model, effort]` per role: `initiative`, `project`, `hygiene`, `build`, `review`, `qa`. | Here every role starts on `opus` at effort `high`. |

A single session overrides its defaults with `flow spawn … --model <key or claude-… id> --effort <low|medium|high|xhigh|max>`; a project's plan of sessions sets model and effort per issue and role. A first session that only reads its card can start with `--model haiku`.

## The md files

| File | Goes into the card of | What it says |
| -- | -- | -- |
| `common.md` | every role | Read first, worktree setup per role, merging and the CI wait, parallel servers, out-of-scope findings, what is never yours. |
| `initiative.md` | the initiative session | How initiatives and projects are named and share `main`. |
| `project.md` | each project session | The owner-steps issue, what goes into plan notes, models, merge and release. |
| `hygiene.md` | the hygiene session | Where observations land, plan notes, merge and release for small fixes. |
| `build.md` | build sessions | Linear status, Definition of Done, branch and PR, the merge command. |
| `review.md` | review sessions | Checking out the PR head detached, what to review, tests, merge, what goes to the owner. |
| `qa.md` | QA sessions | Where and how to test, findings, browser rules. |

What to change: anything that is not true for your repo. The test command, CI checks and install steps come from your repo's `CLAUDE.md` or `README.md`, so the md files never name them; if your repo has neither, add one line with the test command to `common.md`. Names of real repos, people or workspaces belong in your private copy only, never in this template.
