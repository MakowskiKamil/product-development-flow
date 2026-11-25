This repo's workflow: GitHub pull requests into `main`, specs and issues in Linear. The repo path, the Linear workspace and the base branch are in this playbook's `config.json`. The commands below say `main`; if `baseBranch` in `config.json` names another branch, read that branch wherever they say `main`.

### Read first
`CLAUDE.md` (and `README.md`) in the repo, then the project's spec (section 6 of your card), then your Linear issue. `CLAUDE.md` is binding on every session; where this playbook and `CLAUDE.md` differ, `CLAUDE.md` wins and you say so to your parent (a coordinator: to the owner).

### Setup (issue sessions)
1. Your worktree was created by `claude --bg -w`. First: `git fetch origin main`.
   - **build:** `git checkout -B <the issue's Linear git branch name> origin/main` (Linear's "copy git branch name"). Always branch from today's `origin/main`. A follow-up PR for QA findings gets a new branch the same way, with a suffix (`…-qa-fixes`).
   - **review:** check out the PR head detached (the review playbook gives the commands); never the branch by name, which the build session's worktree holds.
   - **qa:** `git checkout --detach origin/main` when you need the code at all.
2. Never touch the main checkout (the `repo` folder in `config.json`), another session's worktree or branch, or anything outside your worktree that `CLAUDE.md` does not name.
3. Install the repo's dependencies in your worktree the way `CLAUDE.md` or `README.md` says, if they are missing.

### Merging
- `merge: "self"` in your plan entry is the owner's approval of that PR given in advance. `merge: "owner"` means you merge only after `go`.
- Merge-check test command (the merge rule's "test command"): the test command `CLAUDE.md` or `README.md` names, exit 0, in a clean checkout of the PR head commit. A passing count with a non-zero exit is red.
- CI: every check GitHub reports on the PR green on the head commit. CI success never wakes you on its own; failures do. Start **one** background `gh pr checks <n> --watch` (with `run_in_background`): it ends, and wakes you, the moment the checks finish. Don't check CI yourself in a loop, and never start a second wait on the same PR.
- Merge command: `gh pr merge <n> --merge --match-head-commit <sha>`. Never force-push, never push to `main`.

### Servers and parallel sessions
- Other sessions run at the same time. A server you start for QA runs on the port your plan notes name (`Port <n>.`), never on the repo's default port, which another session may hold; check that the port is yours (`lsof -nP -iTCP:<port> -sTCP:LISTEN`) before trusting a response. No port in your notes: ask your parent for one.
- Anything that writes a shared file outside your worktree (a database, a cache, a port) runs one session at a time.
- A test that fails only while many sessions run is a load flake when it passes on a rerun of that test alone: say so in the PR body. A test that fails again is red.

### Out of scope and Linear
- Anything out of scope is an observation in Linear: your team's Triage (or Backlog when the team has no Triage), no project. Log it, don't define it: no options or questions in it. Never a TODO file or a code comment alone, never widened into your PR.
- Copy nothing from Linear into the repo that the repo would not hold anyway (Linear may be private while the repo is not).
- Status lives in Linear, never in repo files.

### Never
Production, its secrets or a deploy; another repo; a release, except the one a project session runs under its plan's `release` setting (project playbook). These are the owner's.
