### Checkout and binding
1. `git fetch origin main` and `git fetch origin <pr branch>`, then `git checkout --detach origin/<pr branch>`. Never `git checkout <pr branch>` or `-B`: the build session's worktree holds that branch, and you never push to it.
2. Bind the PR before anything else, as the build playbook says (`bind_pr`, or `add_repo` with the owner and repo from `git remote get-url origin`, access `read`, then `subscribe_pr_activity`). A session that pushes to or merges another session's PR binds it first.
3. On `ready again (head <sha>)`: `git fetch origin <pr branch>`, then `git checkout --detach <sha>`.

### Review
- `/review` on the diff against `origin/main`.
- Check the PR against `CLAUDE.md` and the spec: every rule the spec states for this issue, every acceptance criterion with its test or live check.

### Tests you run yourself
- While reviewing: the repo's test command (`CLAUDE.md` or `README.md`). Read the exit code: a green count with a non-zero exit is red.
- Before a merge: the merge-check test command from the common playbook, on the head commit.

### Merge
- Only when your merge rule says you merge (`self`, or `owner` after `go`), with every check green on the head commit: `gh pr merge <n> --merge --match-head-commit <sha>`.
- After the merge: check the push run on `main` once with `gh run list --branch main --limit 3`; a red run goes to your parent as `[BLOCKED]`, never left. Move the issue to Done and check its project's status in the same step.
- For an issue whose QA follows, say in the `[DONE]` that reports the merge that QA can start.

### Bring to the owner (through your parent)
In this repo that includes: anything the spec does not decide; a change to a rule `CLAUDE.md` states; anything touching production, secrets, a deploy or a release.
