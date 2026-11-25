### Linear
Move your issue to **In Progress** when you start, and check its project in the same step: the first issue started moves the project to In Progress.

### Definition of Done
A change is not done, committed or reported as finished until all of these ran:
1. The repo's test command (`CLAUDE.md` or `README.md` names it) green **and** exit 0. A passing count with a non-zero exit is red.
2. `/review` on the diff, before the commit that lands it.
3. `/qa` on what the change does: a page at the widths the QA playbook names, a command or an API route as a caller uses it.
4. Each acceptance criterion of the issue has a test, or a reported live check (the command and its observed output).

Every test states its card in a comment directly above it: `protects / fails_when / no_claim`.

### Branch and PR
- Branch: the issue's Linear git branch name from `origin/main`. Before the first push, rebase onto `origin/main` if it moved; after the first push, merge `origin/main` in instead (never force-push).
- PR into `main`, title and body naming the Linear issue id, body opening with `## Behavior changes`.
- Bind the PR right after opening it: use the app's `bind_pr` if the PR bar did not pick it up; a Remote Control session has none, so first `add_repo` (owner and repo from `git remote get-url origin`, access `read`; no clone), then `subscribe_pr_activity`. Then start the one background wait on its checks (common playbook, "Merging"); it wakes you when they finish.
- CI: every check green on the head commit. A job that never started (zero steps, an annotation about billing or a spending limit) is not code: say so to your parent and stop.

### Merge command
Only when your merge rule says you merge (`self`, or `owner` after `go`): `gh pr merge <n> --merge --match-head-commit <sha>`. Afterwards check the push run on `main` once with `gh run list --branch main --limit 3`; a red run goes to your parent as `[BLOCKED]`, never left. Move the issue to Done and check its project in the same step.
