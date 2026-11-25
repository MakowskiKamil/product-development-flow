# state-b913f36: state written by flow at commit b913f36

Input and expected output for `test/compat.test.mjs`, the gate that today's `flow` and keeper still read state an older `flow` wrote. Commit b913f36 is the last one before playbooks could live outside the repo (`~/.product-dev-flow/playbooks/`).

## What is here

| Path | What |
| -- | -- |
| `state/` | A state dir written by b913f36's `flow` and keeper with the fake claude: `init`, `spawn initiative I-1`, `spawn project P-DEMO-1` (under I-1) and `P-DEMO-2`, `set`, `archive p-demo-2`, one keeper run (cleaned p-demo-2, left `dev/demo-2` in `branchesLeft`), `phase`, `note`, `plan`, `spawn DEMO-1 build`, `set pr=7`, `archive p-demo-1` (its build is now an orphan). Its `.git` is not checked in; the test makes one commit. |
| `claude/` | The claude home those runs left (`jobs/<id>/state.json`), plus what the background service and the app would hold: `agents.json` (what `claude agents --json --all` prints), `jobs/pins.json`, `daemon/roster.json` and one transcript per job with a Remote Control "active" event. |
| `legacy/config.json` | The playbook the records name. The test puts it only in `<temp HOME>/.product-dev-flow/playbooks/legacy/`. |
| `fake-claude.mjs` | Answers `agents --json --all` from `agents.json`; refuses every other call. |
| `tree-all.expected.txt` | `flow tree --all` from b913f36 on this input. |
| `keeper-dry-run.expected.txt` | `node keeper/flow-keeper.mjs --dry-run` from b913f36 on this input, ISO timestamp prefix stripped, the temp root as `__ROOT__`. |

Placeholders the test fills in: `__ROOT__` (the temp dir), `"__ALIVE_PID__"` (the test's own pid) and `"__DEAD_PID__"` (the pid of a child it started and reaped).

## Never regenerate

The two expected files were captured by hand, by running b913f36's own code (with `FLOW_PLAYBOOKS` pointing at the playbook, since b913f36 searches one directory) on this input. No script rewrites them. If the test fails, today's code reads old state differently: fix the code, or, if the change is intended, say so in the PR and explain what happens to state written before it. A fresh-history copy of this repo cannot check out b913f36, so the files cannot be captured again there.
