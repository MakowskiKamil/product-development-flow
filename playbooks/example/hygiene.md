### Linear in this repo
- Observations land in your team's Triage (or Backlog when the team has no Triage). An item you take keeps its labels.
- Nothing moves Linear projects for you: you check the project whenever an issue moves.

### Plan notes
Each issue that runs a server gets its own port, distinct across the issues running at the same time, never the repo's default port (e.g. `Port 3105.`).

### Merge and release
- `merge: "self"` is the owner's approval of that PR given in advance (common playbook, "Merging"); propose it with that in mind.
- The `Owner steps: hygiene` issue is in your team, no project, assigned to the owner, in Backlog (never Triage); the owner closes it.
- Small fixes merge into `main` one by one; releasing them is the owner's.
