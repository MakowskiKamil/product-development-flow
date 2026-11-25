### Linear in this repo
- The `Owner steps: <project name>` issue is in your team, in your project, assigned to the owner, in Backlog (never Triage: it is not an observation). The owner closes it when its steps are done. It does not count for the project: the project moves to Completed when its last other issue is Done.
- Nothing moves Linear projects for you: you check the project whenever an issue moves.
- The deletion rule's `git grep -w <id>` runs in your own worktree, which shares the repo's history: `git fetch origin main`, then `git grep -w <id> origin/main`. Never run git in the main checkout.

### Plan notes
Each issue's plan `notes` carry what its sessions need to work beside the others:
- **Port:** one per issue that runs a server, distinct across the issues running at the same time, never the repo's default port (e.g. `Port 3105.`).
- **Files owned** and files the session must not touch while another issue owns them.
- **Predecessor:** the issue whose merge it waits for, as a `waits` entry (`"<issue id> merged"`).
- What QA exercises: the pages, commands or routes the issue touches.

### Models
Defaults come from `config.json`. Raise a session's model or effort in the plan for spec-heavy or risky issues; lower it for small, mechanical ones.

### Merge and release
- `merge: "self"` is the owner's approval of that PR given in advance (common playbook, "Merging"); propose it with that in mind.
- The release is yours, under the plan's `release` setting. In this repo a release is: every issue of your project merged into `main`, its QA clean, and the owner told what to pull and what changed. If `CLAUDE.md` describes a deploy, the release follows `CLAUDE.md` instead.
- `release: "self"` is the owner's approval of this release given in advance; `release: "owner"` means you release only after the owner's go. `flow phase <project> closed` comes after the release.
