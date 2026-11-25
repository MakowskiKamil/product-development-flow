# CLAUDE.md — product-development-flow

**At the start of every task, read the spec and the task's Linear issue before writing any code.** The spec is the one your card links in section 6; it is binding. Where an issue and the spec differ, the spec wins and you say so in the PR.

## What This Is

Tooling for running many Claude Code sessions in parallel on one Mac as a hierarchy that mirrors Linear: initiative session → project session → issue sessions per role (build, review, QA), plus a long-lived hygiene coordinator. Three parts:

- `flow`, a Node CLI that starts sessions (`claude --bg -w … --remote-control …`) with a name, a record, a card and a thin system prompt, and keeps plans, notes and phases in a local git store (`~/.product-dev-flow/state/`).
- Role briefs (`roles/`, repo-agnostic) and per-repo playbooks (the template `playbooks/example/`; real ones live outside the repo in `~/.product-dev-flow/playbooks/<name>/`) that carry the gstack flow and each repo's workflow into every session.
- The keeper (`keeper/`), a LaunchAgent that keeps sessions alive until they are archived and cleans up after them.

One maintainer; do not generalize beyond what the spec asks.

## About the User

Strong systems thinking, not an experienced software engineer; most coding is AI-assisted. Keep code simple and readable, no magic, comments explain WHY. Small steps, each testable. When a design decision is not covered by the spec, stop and ask.

## Tech Stack

- Node.js ≥ 22, ES modules, **no dependencies**. Tests with `node --test`.
- Shell out with `child_process.execFileSync` (argument arrays, never a shell string).
- State is JSON and Markdown files in a local git repo; every write goes through `lib/state.mjs` (lock, write, commit).

## Rules

- `roles/*.md` and `lib/` stay repo-agnostic. Repo names, paths, ports and Linear workspace live only in playbooks, and a real repo's playbook never in this repo (`playbooks/example/` names no real repo, person or workspace).
- Tests never start a real session against a real repo. Use the fake claude binary (`FLOW_CLAUDE`), a temp state dir (`FLOW_STATE`) and a fake claude home (`FLOW_CLAUDE_HOME`). Live smokes use `haiku` and a scratch repo, and remove what they start (`claude stop`, then `claude rm`).
- Every test states its card in a comment directly above it: `// protects: … // fails_when: … // no_claim: …`.
- Never edit, load or unload a LaunchAgent. LaunchAgent changes are printed for the maintainer to run.
- Never touch `~/.claude/jobs`, `pins.json` or `roster.json` outside the code paths the spec defines, and never a session you did not start.
- Never write to another repo's worktrees or checkouts.

## Definition of Done

A change is not done, committed or reported as finished until:

1. `npm test` is green and the process exits 0.
2. `/review` ran on the diff before the commit that lands it.
3. Each acceptance criterion of the issue has a test with its card, or a reported live check (command and observed output).

## Branching and merging

- `main` is the only long-lived branch. One branch per issue (Linear's git branch name, e.g. `dev/pro-1-…`), one PR into `main`.
- Never commit on `main` and never push to `main`; the only exception was the owner-approved first commit.
- Merging follows the issue's merge setting in the plan of sessions (`self` or `owner`). Without a setting, the owner merges.
- Never force-push, never rebase another session's branch.

## Planning in Linear

- Specs, issues and status live in the maintainer's Linear; no status is written into repo files. Team and workspace details are in the private playbook, never in this repo.
- Move your issue to In Progress when work starts, and check the project's status in the same step (first issue started → project In Progress; last issue done → project Completed).
- Findings outside the issue's scope go to Linear as an observation (where exactly: the playbook says), never widened into the PR.

## gstack

gstack is the only skill suite. Flow per project: `/spec` → owner accepts → issues → `/autoplan` → plan of sessions → build → `/review` → PR. Use `/investigate` for bugs and `/codex` or a fresh session for a second opinion.
