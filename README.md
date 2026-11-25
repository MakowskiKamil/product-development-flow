# product-development-flow

[![test](https://github.com/MakowskiKamil/product-development-flow/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/MakowskiKamil/product-development-flow/actions/workflows/test.yml)

Requires macOS, Claude Code with `claude --bg` and Remote Control, Linear and gstack. Experimental: depends on Claude Code internals.

## What it is

`flow` runs many Claude Code sessions in parallel as a hierarchy that mirrors Linear: one session per initiative, one per project under it, and one per issue and role (build, review, QA) under each project, plus a long-lived hygiene session for small fixes outside any project.

```
                     you, in the Claude app (Remote Control)
                                  │
  initiative session   (I)·<name> I-1          priorities, starts projects
                                  │
  project session      (P) I-1·<name> P-APP-1  spec, issues, plan, release
          ┌───────────────────────┼───────────────────────┐
  build session          review session            qa session
  code, tests, PR        independent review        tests what merged

  hygiene session      (H)·Hygiene             small fixes outside projects
  keeper               LaunchAgent             keeps sessions alive, cleans up
```

Each session knows its parent and reports to it with `SendMessage`, so you talk to the initiative and project sessions and they drive the rest.

- **Roles.** Six role briefs in `roles/` (initiative, project, hygiene, build, review, qa) say what each session does and never does. They name no repo.
- **Cards.** Every session gets one Markdown card (`~/.product-dev-flow/state/sessions/<slug>/card.md`) and a system prompt that tells it to read the card first. The card holds who it is and who its parent is, its role brief, its repo's playbook, the project notes, its plan entry and its links. `flow refresh` rebuilds cards when a brief, a playbook, the notes or the plan change.
- **Playbooks.** A playbook carries one repo's workflow (how to branch, test, open a PR, merge, where findings go in Linear) and its config (repo path, base branch, Linear workspace, models). The briefs stay the same for every repo; the playbook changes.
- **Plans and phases.** A project moves `intake → spec → issues → running → closed`. Its plan of sessions (`flow plan`) names each issue, the model and effort per role, whether a review and a QA follow the build, and who merges.
- **Test cards.** Every test states in three comment lines what it protects, what wrong result it rejects (`fails_when`) and what a green run does not prove (`no_claim`), and the briefs ask sessions to write tests the same way. A green suite is never called a review.
- **State.** Plans, notes, phases and session records are JSON and Markdown files in a local git repo (`~/.product-dev-flow/state/`); `git log` there is the history of every change.

> **Experimental:** `flow` relies on Claude Code internals (`~/.claude/jobs`, pins, the Remote Control roster), which can change without notice. A Claude Code update can break spawning, the keeper or cleanup until `flow` catches up. `lib/claudeJobs.mjs` is the only file that reads them.

## Check your prerequisites

Run these four and compare the first line of each:

```sh
claude --version               # 2.1.330 (Claude Code), or newer
claude --help | grep -- --bg   # --bg, --background  Start the session in …
gh auth status                 # github.com, then ✓ Logged in to github.com …
node --version                 # v22.0.0 or newer
```

Then open the Claude app → Remote Control: the list of sessions must load. Sessions `flow` starts show up there.

## Prerequisites

- **macOS.** The keeper runs as a launchd LaunchAgent, and live sessions are used on macOS only. The test suite also runs on Linux in CI.
- **Claude Code** with `claude --bg` (background sessions) and Remote Control, signed in.
- **Linear connected to Claude Code** (the Linear MCP connector). Sessions read their spec and issues and write status there.
- **gstack installed.** The briefs invoke its skills: `/spec`, `/autoplan`, `/review`, `/qa`, `/investigate`, `/codex`. Without them a session can still read its card, write code and open a PR, but cannot write a spec, run the review pipeline, review its diff or run QA the way its brief demands, so it stops and asks.
- **`gh` authenticated** (`gh auth status`). Sessions open PRs, watch checks and merge with it.
- **Node.js ≥ 22 and git.** No npm install: there are no dependencies.

Not on npm: clone and symlink.

## Install

1. Clone and link the CLI. `~/.local/bin` must be on your `PATH` (if `echo $PATH` does not show it, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc`, then open a new terminal or run `source ~/.zshrc`; the shell already open does not see the change). The link points into your clone, so `flow` runs whatever is checked out there; `ln -sfn` replaces an older link, e.g. one into an earlier clone. It replaces any other `~/.local/bin/flow` too, so if `command -v flow` already prints something that is not this tool, pick another name for the link.

   ```sh
   git clone https://github.com/MakowskiKamil/product-development-flow.git
   mkdir -p ~/.local/bin && ln -sfn "$PWD/product-development-flow/bin/flow.mjs" ~/.local/bin/flow
   flow --help
   ```

2. Trust your repo in Claude Code once: run `claude` in it and accept the trust prompt (then quit). `claude --bg` refuses a repo it does not trust, and a repo nested inside a trusted folder is not trusted by itself. The repo needs at least one commit and an `origin` on GitHub with its base branch pushed: sessions push branches and open PRs there, and the keeper cleans up only worktrees whose commits `origin` holds.

3. Create your playbook and the state dir:

   ```sh
   flow init --playbook <name> --repo <path to your repo> --linear https://linear.app/<your-workspace>
   ```

   This copies `playbooks/example/` to `~/.product-dev-flow/playbooks/<name>/` with your repo path and workspace set, creates `~/.product-dev-flow/state/` with `<name>` as the default playbook, and prints the next steps (its `ln -s` line is step 1, already done). Add `--base <branch>` if your PRs do not go into `main`. Without `--linear` it ends with a line telling you which `config.json` to edit before the first spawn.

### Let sessions run flow without a prompt

Add this to `~/.claude/settings.json` (merge it into an existing `permissions.allow` list):

```json
{
  "permissions": {
    "allow": ["Bash(flow:*)"]
  }
}
```

It lets every Claude Code session on this Mac, in any project, run any `flow` command without asking you: `flow spawn` (which starts new background sessions in the playbook's `permissionMode`, `auto` in the example), `flow archive` (which stops them), `flow plan`, `flow note` and the rest. The coordinator sessions need it, because they spawn and archive their children unattended; without it a session stops at its first `flow` command to wait for your approval. If that is too broad for you, allow only the commands a session may run on its own, e.g. `"Bash(flow tree:*)"`, `"Bash(flow set:*)"`, `"Bash(flow note:*)"`, and approve each spawn and archive yourself.

The keeper is optional for a first session. Without it, sessions die when the Mac reboots and Claude Code retires any background session that sits idle for 8 hours; nothing cleans up their worktrees. See [Keeper](#keeper) to install it.

## First session

Each step says what success looks like and what usually goes wrong.

1. **Create one initiative and one project in Linear**, the project inside the initiative. The ids are the ones Linear shows on them (an initiative like `I-1`, a project like `P-APP-1`). `flow` does not check them; the sessions need them to exist, because they read their spec and issues there. Success: both show in Linear with those ids. Fails later, in the session: [a session cannot find its initiative or project](#a-session-says-it-cannot-find-its-initiative-project-or-issue-in-linear).

2. **Start the initiative session.** `--model haiku` because a first session mostly reads its card and answers you; it is the cheapest model and starts fast.

   ```sh
   flow spawn initiative I-1 --name "Try flow" --model haiku
   ```

   Success: `flow` reads the `backgrounded · <jobId> · <name>` line `claude --bg` prints and answers with

   ```
   started "(I)·Try flow I-1"
     slug: i-1
     job: <jobId> (session <sessionId>)
     card: /Users/<you>/.product-dev-flow/state/sessions/i-1/card.md
   ```

   Fails: [the repo is not trusted](#claude---bg-exited-1-workspace-not-trusted); [a name in use](#name--is-already-used-by-claude-code-job-id).

3. **Find it in the Claude app.** Within about a minute it shows in the Remote Control list under its name, `(I)·Try flow I-1`. Open it: it has read its card and waits for you. Fails: [Remote Control didn't finish connecting](#the-app-shows-remote-control-didnt-finish-connecting-for-new-sessions).

4. **Start the project session under it.**

   ```sh
   flow spawn project P-APP-1 --name "First project" --initiative I-1 --model haiku
   ```

   Success: `started "(P) I-1·First project P-APP-1"`, slug `p-app-1`. Its card names the initiative session as its parent. Fails: `initiative I-1 does not exist` when step 2 did not run (or used another id); [a name in use](#name--is-already-used-by-claude-code-job-id).

5. **Look at the tree.**

   ```sh
   flow tree
   ```

   Success: both sessions, with role, model, effort and `running`:

   ```
   I-1 Try flow
     (I)·Try flow I-1 — initiative · claude-haiku-5-5 · high · running
     P-APP-1 First project (intake)
       (P) I-1·First project P-APP-1 — project · claude-haiku-5-5 · high · running
   ```

   Fails: right after a spawn the job's worktree path is recorded a few seconds late ([worktree not there yet](#right-after-a-spawn-the-worktree-is-not-there-yet)).

6. **Send one message down the hierarchy.** In the initiative session, write: `Send the project session a SendMessage asking it to read its card and reply with the name in section 1.` Success: the project session's reply arrives in the initiative session, which shows it to you. Fails: [`Failed to send`](#sendmessage-says-failed-to-send).

7. **Stop them** when you are done trying:

   ```sh
   flow archive p-app-1
   flow archive i-1
   ```

   Each prints `archived "<name>" (<slug>)`, `  stopped job <jobId>` and `  unpinned` (or `  was not pinned`). With the keeper installed, it removes the job, worktree and branches on a later run. Without it, run `claude rm <jobId>` for each job a few seconds later. Fails: [`claude rm` refused right after the stop](#claude-rm-is-refused-right-after-a-stop).

From here the project session takes it: in phase `spec` it runs `/spec` with you, then creates issues, writes the plan with you and starts build, review and QA sessions.

## Write a playbook

A playbook is a folder: `config.json` (repo path, base branch, Linear workspace, permission mode, model ids and the default model and effort per role) and one Markdown file per role plus `common.md`, which `flow` puts into section 3 of each card. `playbooks/example/` is a complete, generic workflow for GitHub pull requests into `main` with specs and issues in Linear; `flow init --repo` copies it for your first repo. [`playbooks/example/README.md`](playbooks/example/README.md) describes every file and key, the example's model defaults, the `--model`/`--effort` overrides, and the `cp -R` recipe for a second repo's playbook.

Your playbooks live in `~/.product-dev-flow/playbooks/<name>/`, outside the clone, so pulling never touches them. Names are found there first, then in the clone's `playbooks/`.

A second repo's playbook, once the state dir exists (`flow init` refuses then):

```sh
mkdir -p ~/.product-dev-flow/playbooks && cp -R <your clone>/playbooks/example ~/.product-dev-flow/playbooks/<name>
```

Then edit `~/.product-dev-flow/playbooks/<name>/config.json`: set `repo`, `linearWorkspaceUrl` and `baseBranch`, and delete the `"template": true` line, or every spawn with it is refused as a template. Start that repo's sessions with `--playbook <name>`, and trust the repo in Claude Code as in [Install](#install).

## Commands

| Command | Effect |
| -- | -- |
| `flow init [--playbook <name>]` | Creates the state dir (a git repo) with one commit; refuses if it exists. `--playbook` sets the default playbook, which must exist already; `example` is refused as a template. |
| `flow init --playbook <name> --repo <path> [--linear <url>] [--base <branch>]` | Copies `playbooks/example/` to `~/.product-dev-flow/playbooks/<name>/` with `repo`, `linearWorkspaceUrl` and `baseBranch` set, then creates the state dir with `<name>` as default. Refused before anything is written when the name is not lowercase letters, digits and dashes, the state dir or the playbook exists, or the repo path does not. If creating the state dir fails, the copied playbook is removed again. |
| `flow spawn initiative <I-id> --name <n> [--playbook <pb>] [--model <m>] [--effort <e>]` | Writes `initiatives/<I-id>/`, a card and a record, and starts the session. |
| `flow spawn project <P-id> --name <n> [--initiative <I-id>] [--playbook <pb>] [--model <m>] [--effort <e>]` | Writes `projects/<P-id>/` (phase `intake`, empty plan), a card and a record; the initiative's session is its parent. |
| `flow spawn hygiene [--playbook <pb>] [--model <m>] [--effort <e>]` | Writes `projects/H/`, a card and a record; only one live hygiene session. |
| `flow spawn <issue-id> <build\|review\|qa> --project <P-id\|H> [--model <m>] [--effort <e>] [--again]` | Starts an issue session from the issue's plan entry; the project's session is its parent. Only in phase `running`, for an issue in the plan whose step is not `"skip"`. |
| `flow plan <P-id\|H> --file <path>` | Validates and stores the plan (phases `issues` and `running`; hygiene always); prints the live issue sessions to tell `Card updated`. Refused if it drops an issue or step with a non-archived session, or note lines `flow note` added. |
| `flow phase <P-id> <phase>` | Moves the project one step forward: `intake → spec → issues → running → closed`. `running` needs a valid plan with an issue; `closed` needs every issue session archived. Not for `H`. |
| `flow note <P-id\|I-id\|H\|issue-id> --text <t> [--project <P-id\|H>]` | Appends `- <date> <text>` (further lines indented) to the notes file, or for an issue to its plan entry's `notes`; rebuilds the affected live cards and prints the names to tell `Card updated`. An issue in two plans needs `--project`. |
| `flow refresh <slug\|P-id\|H\|all>` | Rebuilds live cards from the current role briefs, playbook, notes and plan; prints the names whose card changed. |
| `flow tree [--all]` | Prints initiative → project (phase) → sessions with role, model, effort, status, PR and waits; `ORPHAN` marks an open session whose parent is archived or missing. `--all` adds archived sessions. Reads only, under the state lock: while another command writes, it waits (up to 45 s, like any command) instead of showing files that command may still roll back. |
| `flow set <slug> pr=<n> \| branch=<b> \| status=done` | Updates the session's record (one or more pairs) and rebuilds its card. Any other key or value is refused; an archived record no longer changes. |
| `flow archive <slug>` | Sets the record to `archived`, runs `claude stop` on its job and unpins it; the keeper cleans up the worktree later. Running it again repeats stop and unpin. A failing `claude stop` exits 2 with the record archived; a job folder that no longer holds the session is neither stopped nor unpinned (exit 1); a held `pins.json.lock` leaves the pin and warns. |

`flow --help` lists the commands. Exit codes: 0 done, 1 refused or invalid, 2 claude failed. Every refusal prints what was wrong on its first stderr line and `fix: …` on its last.

Rules worth knowing:

- **Playbook**: `--playbook`, else the initiative's (for a project), else the state dir's default. Issue sessions use their project's.
- **Model and effort**: `--model` takes a key of the playbook's `models` (`opus`) or a full id (`claude-opus-5-5`). Each of `--model` and `--effort` overrides on its own; the other comes from the plan entry, then the playbook's defaults.
- **Re-spawn**: once a coordinator's session is archived, `flow spawn initiative|project|hygiene` again reuses its folder (phase, notes, plan) and starts a new session with the next suffix (`p-app-25-2`, `… P-APP-25 2`). Flags that differ from the stored folder are refused.
- **Plan file**: `{"project": "<P-id|H>", "release": "self"|"owner", "issues": [...]}`. `release` is required for a project, with no default, and refused for `H`: `self`, the project session releases once its issues are in; `owner`, it waits for the owner's "release approved". Either way a session runs the release. The project card shows it, and `flow plan` prints a change of it (`release owner → self`) and names it in the state dir's commit. Each issue has `id`, `title`, `build` (an object), `review` and `qa` (an object or `"skip"`), `merge` (`"self"` or `"owner"`, no default), and optional `notes` (string) and `waits` (strings, shown, never evaluated). A step object may set `model` (a key of the playbook's `models`) and `effort`; left out, spawn uses the playbook default. Every error names the issue and field, e.g. `APP-309 review.model: "opsu" not in fable, opus, sonnet, haiku`.
- **`--again`**: an issue slug held by any record is refused; `--again` takes the next free suffix (`-2`, `-3`, …).
- **Refused up front**: a name held by a live session or by any Claude Code job, an existing `<repo>/.claude/worktrees/<slug>` or branch `worktree-<slug>`, a repo path that is missing, not a git repo, or not the top level of its repo.
- **Interrupting**: Ctrl-C or a kill signal does not stop `flow` halfway; the command runs to its end (claude gets 30 s) and rolls back if it fails, so the state dir and lock are never left half-written.
- **Spec link**: a card's spec link is the first URL on the last line of the project notes that mentions "spec" and has a URL, so a later spec note (the accepted spec) replaces an earlier one (a draft), e.g. `flow note P-APP-25 --text "Spec: https://linear.app/<your-workspace>/document/…"`.

What spawn runs, from the playbook's repo:

```sh
claude --bg -w <slug> -n "<name>" --remote-control "<name>" --permission-mode <mode> \
  --model <model id> --effort <effort> --append-system-prompt "<rendered system prompt>" \
  "Read your card at <state>/sessions/<slug>/card.md and begin."
```

## Keeper

`keeper/flow-keeper.mjs` keeps every Remote Control background session alive until it is archived, and cleans up after archived sessions that `flow` started. It is optional, macOS only, and runs as the LaunchAgent `com.product-dev-flow.keeper`.

Each run (launchd, at login and every 300 s; log `~/Library/Logs/flow-keeper.log`):

- **Live** session (latest Remote Control event in its transcript is "active"): pinned; started again with a bare `claude --bg --resume <sessionId>` if its process is gone, unless the background service still holds it (resuming then makes a copy; a copy that appears anyway is stopped and removed).
- **Archived** session (the app's 4090 notice, or a record with `status: archived`): unpinned and stopped. A 4090 notice sets the record to `archived`. Records `running` and `done` both count as live.
- **Cleanup**, only for sessions with a record, once the process is gone: `git fetch origin <baseBranch>` in the worktree; if it has no uncommitted changes and no unpushed commits, `claude rm <jobId>`, `git worktree remove` if the worktree is still there, then `git branch -d` of `worktree-<slug>` and of the lane branch (the record's `branch`, else the branch the worktree was on), each only when `origin/<baseBranch>` contains it; then `cleanedAt` is set. Otherwise the log says why (`uncommitted: <paths>`, `unpushed: <n> commits`) and the next run tries again. Ignored files (`node_modules`, `.env`, build output) go with a cleaned worktree.
- **Branches left by cleanup**: a branch `origin/<baseBranch>` does not contain yet (the lane was archived before its PR merged) is logged as `branch … not merged into origin/<baseBranch>; left` and listed in the record's `branchesLeft` with its reason. Each later run fetches `origin/<baseBranch>` in the repo's main checkout (with `--no-write-fetch-head`, so a `git pull` running there is not disturbed; every keeper fetch uses it) and checks each listed branch: a branch now merged is deleted with `git branch -d`, a branch deleted by hand is dropped. A branch that waits (still not merged, or merged but refused by `git branch -d` because a worktree has it checked out or it has no upstream and the main checkout is behind) stays listed and is retried every run; its reason is logged only when it changes. While that fetch fails the lists wait; the failure is logged once (the record keeps it in `branchesFetchError`), and again only when its reason changes or the fetch works again. A PR closed without merging, or squash-merged, never becomes reachable, so its branch stays listed until you delete it by hand.
- **Orphans**: an archived parent with open children is logged once as `ORPHAN <parent>: <children>`. No script can push to the phone, so the log and `flow tree` carry it.
- Sessions without a record (started by hand) get the keep-alive rules only; they are never cleaned.

```sh
node keeper/flow-keeper.mjs --dry-run                     # print decisions; acts on nothing (no stop, rm, resume, fetch, pin or record writes)
node keeper/flow-keeper.mjs --install                     # print the install and rollback commands; installs nothing
node keeper/flow-keeper.mjs --install --replace <label>   # the same, switching away from an older keeper LaunchAgent
node keeper/flow-keeper.mjs --plist                       # print the rendered LaunchAgent plist
```

**Install**: run `node keeper/flow-keeper.mjs --dry-run` first and read its decisions, then `--install` (if `~/Library/LaunchAgents` does not exist yet, `mkdir -p ~/Library/LaunchAgents` first), and paste the printed lines one at a time: render the plist into `~/Library/LaunchAgents/com.product-dev-flow.keeper.plist`, `launchctl enable` and `bootstrap` it, then check `launchctl print gui/$(id -u)/com.product-dev-flow.keeper` (`last exit code = 0` after a run) and the log. The rollback block it prints (`bootout` and `disable`) turns it off again.

**Replacing an older keeper**: if another keep-alive LaunchAgent already runs (an older copy of this keeper under another label, or a script of your own), use `--install --replace <its label>`. It prints the same lines plus `launchctl bootout` and `disable` of the old label before the new one starts, and a rollback that brings the old one back. A plain `--install` next to a loaded old keeper leaves two keepers running on the same sessions. Run the switch right after the old keeper's run has finished (the last line of its log; for an older copy of this keeper `tail -n 3 ~/Library/Logs/flow-keeper.log`): a `bootout` in the middle of a run stops a cleanup that may hold the state lock. `--replace` takes a plain launchd label only (`[A-Za-z0-9._-]`).

`--install` and `--plist` run only from your clone; from a session worktree under `.claude/worktrees/` they refuse, because that worktree is removed once its session is archived. The plist runs node through a login shell (sessions it resumes get a terminal's environment) with absolute paths for node, claude (`FLOW_CLAUDE`) and git (`FLOW_GIT`). A run starts no new step after 120 s (`FLOW_KEEPER_BUDGET_MS`), so even its slowest step ends inside the 300 s interval. If it cannot read the background service's roster, it starts and cleans nothing that run.

## Layout

```
bin/flow.mjs            CLI entry: argument parsing, exit codes
lib/                    state store and lock, ids and names, records, cards, playbooks, spawn,
                        the private-terms guard, Claude Code internals
                        (lib/claudeJobs.mjs is the only reader of ~/.claude)
templates/              system prompts (issue, coordinator) and the card
roles/<role>.md         role briefs (initiative, project, hygiene, build, review, qa), repo-agnostic
playbooks/example/      the template playbook flow init --repo copies; your own playbooks live in
                        ~/.product-dev-flow/playbooks/<name>/
keeper/                 the keeper and its LaunchAgent plist template
test/                   node --test suites; fixtures/ holds the fake claude, a test playbook, the
                        expected card for each role (fixtures/cards/) and a state dir written by
                        an older flow (fixtures/state-b913f36/)
```

After changing a role brief, regenerate the expected cards with `FLOW_UPDATE_FIXTURES=1 npm test` (it fails on purpose after rewriting them), read the diff of `test/fixtures/cards/`, run `npm test` again without the variable, and commit the cards with the change. Running sessions pick up the change after `flow refresh all`.

State dir (`~/.product-dev-flow/state/`, a local git repo; `git log` there is the history of every change):

```
initiatives/<I-id>/{initiative.json,notes.md}
projects/<P-id>/{project.json,notes.md,plan.json}
projects/H/{project.json,notes.md,plan.json}
sessions/<slug>/{record.json,card.md}
config.json                                     {defaultPlaybook}
.lock                                           held while a command writes
```

Cards (`sessions/<slug>/card.md`) have six sections: 1 who you are, 2 role brief (`roles/<role>.md`), 3 playbook (`common.md` + `<role>.md`), 4 notes (the project's, or the initiative's), 5 the plan entry's notes, waits and merge setting (issue sessions only), 6 links (Linear issue, spec, PR). A missing brief or playbook file shows `—`.

### Environment variables

| Variable | What it overrides | Default |
| -- | -- | -- |
| `FLOW_STATE` | The state dir. | `~/.product-dev-flow/state` |
| `FLOW_CLAUDE` | The claude binary (the keeper's plist sets it to an absolute path). | `claude` on `PATH` |
| `FLOW_CLAUDE_HOME` | Claude Code's home, where jobs, pins and the roster live. | `CLAUDE_CONFIG_DIR`, else `~/.claude` |
| `FLOW_PLAYBOOKS` | The playbooks dir. Replaces both places playbooks are searched (`~/.product-dev-flow/playbooks/` first, then the clone's `playbooks/`). | unset: both places |
| `FLOW_ROLES` | The role briefs dir. | the clone's `roles/` |
| `FLOW_NOW` | Timestamps written into files (the lock uses the real clock). | now |
| `FLOW_GIT` | The git binary. | `git` on `PATH` |
| `FLOW_PRIVATE_TERMS_FILE` | The private-terms guard's list (see [CONTRIBUTING.md](CONTRIBUTING.md)). | `~/.product-dev-flow/private-terms.txt` |
| `FLOW_KEEPER_BUDGET_MS` | How long a keeper run may start new steps, in ms. | `120000` |
| `FLOW_TEST_FAIL` | Tests only: makes a named step fail, to test rollback. Ignored outside `node --test`. | unset |
| `FLOW_UPDATE_FIXTURES` | Tests only: `1` rewrites `test/fixtures/cards/` and fails on purpose. | unset |

Tests set `FLOW_STATE`, `FLOW_CLAUDE`, `FLOW_CLAUDE_HOME`, `FLOW_PLAYBOOKS`, `FLOW_ROLES` and `FLOW_NOW` to temp paths; under `node --test` a missing `FLOW_STATE`, `FLOW_CLAUDE` or `FLOW_CLAUDE_HOME` is refused. Tests of the two playbook directories leave `FLOW_PLAYBOOKS` unset and set `HOME` to a temp path instead (under `node --test`, a `HOME` outside the temp dir without `FLOW_PLAYBOOKS` is refused).

## Troubleshooting

### `claude --bg exited 1`: Workspace not trusted

The spawn's `claude output:` shows `Workspace not trusted`. Run `claude` once in the playbook's repo (the `repo` in its `config.json`), accept the trust prompt and quit, then spawn again. A repo inside a folder you trusted is not trusted by itself.

### `name "…" is already used by Claude Code job <id>`

Another Claude Code session (started by hand, or not yet removed) has that name, so it would share the `SendMessage` address. Use that session, or stop and remove it first (`claude stop <id>`, then `claude rm <id>`).

### Right after a spawn, the worktree is not there yet

Claude Code writes the job's worktree path into `~/.claude/jobs/<jobId>/state.json` a few seconds after `claude --bg` returns, and creates `<repo>/.claude/worktrees/<slug>` about then. `flow` accepts the missing path; wait a few seconds before you look for the worktree.

### `state is locked by pid <n>`

Another `flow` command is writing; retry. A command waits up to 45 s. A lock is removed automatically only when it is older than 120 s and its pid is dead. If `ps -p <n>` shows no process and you cannot wait, move the lock away by hand: `mv <state>/.lock ~/.Trash/` (the state dir is `~/.product-dev-flow/state` unless `FLOW_STATE` says otherwise).

### A failed spawn says `outcome unknown: job <id> "<name>" may be live`

`flow` could not tell for sure whether claude started the session, so it touched nothing: no job stopped, no worktree or branch removed. Run the `check:` line it printed. If the job is there, run the `clean up` lines one at a time (`claude stop <id>`, then `claude rm <id>`), then the `git … worktree remove` line if the worktree is still there. Then run the spawn again. Nothing was written to the state dir.

### A failed spawn says `left behind: …`

The job was stopped and removed, but its worktree had changes or its branch could not be deleted with `git branch -d`. Look at it, then run the command on that line.

### `playbook "<name>" not found in …`

The record or `--playbook` names a playbook in neither `~/.product-dev-flow/playbooks/` nor the clone's `playbooks/`. The fix line names the directory to copy or scaffold it into and the names that exist.

### The app shows "Remote Control didn't finish connecting" for new sessions

If the Remote Control server's log shows `spawn error: ENOENT … posix_spawn '…/versions/<old version>'`, the server outlived a Claude Code auto-update and points at a deleted binary; running sessions keep working. Check that none of its sessions is busy, then restart the Remote Control server the way you started it (for a LaunchAgent: `launchctl kickstart -k gui/$(id -u)/<its label>`).

### A session says it cannot find its initiative, project or issue in Linear

`flow` never checks the ids you give it; the session looks them up in Linear. Check that the id is the one Linear shows (`I-1`, `P-APP-1`), that the project sits in that initiative, and that Linear is connected to Claude Code (the session can list your teams). Then tell the session the right id, or archive it and spawn again with the right one.

### `SendMessage` says `Failed to send`

A message to a busy session can report `Failed to send` and still arrive. Look in the receiving session before sending again, so it does not get the message twice.

### `claude rm` is refused right after a stop

`claude rm` refuses while the stopped process is still exiting ("A Claude Code lock on the worktree names a process that is still running"). Wait a few seconds and run it again. `claude rm` does not always remove the worktree and branches: it keeps both branches once the worktree has switched from `worktree-<slug>` to a branch of its own, and it leaves a worktree it does not judge safe. Remove only that session's leftovers: `git -C <your repo> worktree remove <your repo>/.claude/worktrees/<slug>` and `git -C <your repo> branch -d worktree-<slug>` (and its lane branch once its PR merged). Other worktrees under `.claude/worktrees/` may belong to sessions still running.

### Start over

The state dir is how the keeper knows which sessions you archived: a job left behind without its record looks like a session started by hand, and the keeper starts it again. A fresh state dir also counts slugs from the start (`i-1`, `p-app-1`), and a spawn is refused while `<repo>/.claude/worktrees/<slug>` or the branch `worktree-<slug>` is still there. So, in this order:

1. Archive every session: `ls ~/.product-dev-flow/state/sessions/` lists the slugs (note them; steps 3 and 4 need them); run `flow archive <slug>` for each that `flow tree --all` does not show as archived.
2. Turn the keeper off if you installed it, right after a run has finished (`tail -n 3 ~/Library/Logs/flow-keeper.log` shows its last line; a `bootout` mid-run stops a cleanup that may hold the state lock), so it neither runs now nor comes back at the next login:

   ```sh
   launchctl bootout gui/$(id -u)/com.product-dev-flow.keeper
   launchctl disable gui/$(id -u)/com.product-dev-flow.keeper
   ```

3. Remove every job that still holds one of `flow`'s sessions. Found by session id, not by the job id in the record, because the job holding a session can change. This prints the job folders (with `CLAUDE_CONFIG_DIR` set, use `$CLAUDE_CONFIG_DIR/jobs` instead of `~/.claude/jobs`):

   ```sh
   for s in $(sed -n 's/.*"sessionId": *"\([^"]*\)".*/\1/p' ~/.product-dev-flow/state/sessions/*/record.json); do find ~/.claude/jobs/ -mindepth 2 -maxdepth 2 -name state.json -exec grep -lE "\"sessionId\": *\"$s\"" {} +; done
   ```

   Each line is `~/.claude/jobs/<jobId>/state.json`: run `claude rm <jobId>` for each. Then run the loop again: it must print nothing. While it still prints a job, wait a few seconds and `claude rm` it again; move on only when the loop prints nothing.
4. Remove what `claude rm` left in your repo, for the slugs from step 1 only (other worktrees under `.claude/worktrees/` and other `worktree-*` branches belong to sessions `flow` did not start; leave them). First `git -C <your repo> worktree prune`, which drops entries whose folder is already gone. Then, for each slug: if `<your repo>/.claude/worktrees/<slug>` is still there, look inside first (`git worktree remove` also deletes ignored files such as a `.env`), then `git -C <your repo> worktree remove <your repo>/.claude/worktrees/<slug>`; and `git -C <your repo> branch -d worktree-<slug>` if that branch exists, plus the session's lane branch once its PR merged. `-d` refuses a branch with work no other branch holds; use `git branch -D <branch>` only after you looked at it and do not need it.
5. Move the state dir to the Trash, under a name that cannot collide with an earlier one, and your private playbooks too if you want to start them over:

   ```sh
   mv ~/.product-dev-flow/state ~/.Trash/flow-state-$(date +%Y%m%d-%H%M%S)
   mv ~/.product-dev-flow/playbooks ~/.Trash/flow-playbooks-$(date +%Y%m%d-%H%M%S)
   ```

6. Create the state dir again. With your playbooks kept: `flow init --playbook <name>`. With them moved away: `flow init --playbook <name> --repo <path to your repo> --linear https://linear.app/<your-workspace>` (plus `--base <branch>` if your PRs do not go into `main`); skip the `ln -s` line it prints, the link is still there. A bare `flow init` sets no default playbook, so the walkthrough's spawns would be refused.
7. Turn the keeper back on if you use it. First `node keeper/flow-keeper.mjs --dry-run` in your clone: no line may say `down, starting it again`; one that does names a job step 3 missed, so `claude rm` it. Then:

   ```sh
   launchctl enable gui/$(id -u)/com.product-dev-flow.keeper
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.product-dev-flow.keeper.plist
   ```

## Tests

```sh
npm test
```

Runs `test/*.test.mjs` with `node --test` (about 45 s: one test waits out the full lock budget). Tests never start a real session: they use the fake claude in `test/fixtures/`, a temp state dir and a temp `~/.claude`. Every test states its card in the three comment lines above it (`protects`, `fails_when`, `no_claim`). How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md). License: [MIT](LICENSE).
