import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertRefusal, setup } from "./helpers.mjs";

const SPAWN = ["spawn", "project", "P-APP-30", "--name", "Name"];
const NAME = "(P) Name P-APP-30";

// Before/after snapshot of everything a failed spawn must leave untouched.
function snapshot(ctx) {
  return { commits: ctx.commits(), files: ctx.stateFiles(), dirty: ctx.untracked(), dirs: fs.readdirSync(ctx.state).sort() };
}

function calls(ctx, verb) {
  return ctx.fakeCalls().filter((call) => call.argv[0] === verb);
}

function writeJob(ctx, jobId, state) {
  fs.mkdirSync(path.join(ctx.claudeHome, "jobs", jobId));
  fs.writeFileSync(path.join(ctx.claudeHome, "jobs", jobId, "state.json"), JSON.stringify({ sessionId: `${jobId}-session`, ...state }));
}

// protects: claude printing no `backgrounded` line → exit 2, no record, no card, no new folder, no commit; and since claude exited 0, no claim that no job exists
// fails_when: any state file, folder or commit is left behind, the exit code is not 2, or "no job was started" is claimed after exit 0
// no_claim: that a job exists (the fake started none)
test("no backgrounded line: exit 2 and nothing left", (t) => {
  const ctx = setup(t);
  ctx.init();
  const before = snapshot(ctx);
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "noline" });
  assertRefusal(result, { code: 2, first: /^flow spawn: claude --bg printed no "backgrounded · <jobId> · <name>" line for "\(P\) Name P-APP-30"$/, fix: /check and clean-up commands above/ });
  assert.match(result.stderr, /^ {2}fake claude: nothing started$/m);
  assert.match(result.stderr, /^outcome unknown: job \(id unknown\)/m);
  assert.doesNotMatch(result.stderr, /no job was started/);
  assert.deepEqual(snapshot(ctx), before);
  assert.equal(fs.existsSync(path.join(ctx.state, "projects")), false);
  assert.equal(fs.existsSync(path.join(ctx.state, "sessions")), false);
});

// protects: claude exiting non-zero with no trace → exit 2 with claude's output on stderr, state unchanged, "no job was started"
// fails_when: claude's error text is swallowed, a record is written, or a clean failure is reported as outcome unknown
// no_claim: claude's exact error wording
test("claude exits non-zero: exit 2 with its output", (t) => {
  const ctx = setup(t);
  ctx.init();
  const before = snapshot(ctx);
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "fail" });
  assertRefusal(result, { code: 2, first: /^flow spawn: claude --bg exited 1 for "\(P\) Name P-APP-30"$/ });
  assert.match(result.stderr, /Error: fake claude was told to fail/);
  assert.match(result.stderr, /^rollback: no job was started$/m);
  assert.deepEqual(snapshot(ctx), before);
});

// protects: a printed job id in a format flow does not know is named in the clean-up lines and never acted on
// fails_when: the id is dropped and "no job was started" is claimed, or flow runs claude stop/rm on it
// no_claim: what a future id format looks like
test("printed job id of an unknown format: named, nothing acted on", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "badid" });
  assertRefusal(result, { code: 2, first: /unexpected Claude Code data: job id "JOB-0001"/, fix: /check and clean-up commands above/ });
  assert.match(result.stderr, /^outcome unknown: job JOB-0001, [0-9a-f]{8} /m);
  assert.match(result.stderr, /^clean up, once the check shows it: claude stop JOB-0001$/m);
  assert.deepEqual(calls(ctx, "stop"), []);
  assert.equal(ctx.worktreeExists("p-app-30"), true);
});

// protects: a job started without the line is found by name + worktree + start time, stopped, removed, and its worktree goes
// fails_when: the job is left running, removed before being stopped, or its worktree/branch stays
// no_claim: real claude's stop/rm semantics (fake mimics them)
test("job started without the line is stopped and removed", (t) => {
  const ctx = setup(t);
  ctx.init();
  const before = snapshot(ctx);
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "noline-job" });
  assert.equal(result.status, 2, result.stderr);
  const [bg] = calls(ctx, "--bg");
  assert.deepEqual(ctx.fakeCalls().slice(1).map((call) => call.argv), [["stop", bg.jobId], ["rm", bg.jobId]]);
  assert.match(result.stderr, new RegExp(`^rollback: stopped and removed job ${bg.jobId}$`, "m"));
  assert.doesNotMatch(result.stderr, /outcome unknown/);
  assert.deepEqual(ctx.jobIds(), []);
  assert.equal(ctx.worktreeExists("p-app-30"), false);
  assert.equal(ctx.branchExists("worktree-p-app-30"), false);
  assert.deepEqual(snapshot(ctx), before);
});

// protects: a line but no state.json after 10 × 200 ms → exit 2; flow cannot verify the job, so it acts on none and says so
// fails_when: flow stops a job it could not match, or exits without the outcome-unknown lines
// no_claim: that the job is really live (it may be)
test("no state.json: outcome unknown, acts on nothing", (t) => {
  const ctx = setup(t);
  ctx.init();
  const before = snapshot(ctx);
  const started = Date.now();
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "nostate" });
  // gstack-timing-ok: a lower bound only; proves the 10 × 200 ms retry ran before giving up
  assert.ok(Date.now() - started >= 1800, "did not retry state.json for ~2 s");
  assertRefusal(result, { code: 2, first: /^flow spawn: job [0-9a-f]{8} has no state\.json after 2 s for/, fix: /check and clean-up commands above/ });
  const [bg] = calls(ctx, "--bg");
  assert.match(result.stderr, new RegExp(`^outcome unknown: job ${bg.jobId} "\\(P\\) Name P-APP-30" may be live$`, "m"));
  assert.match(result.stderr, /^check: claude agents --json --all \| grep -F '\(P\) Name P-APP-30'$/m);
  assert.match(result.stderr, new RegExp(`^clean up, once the check shows it: claude stop ${bg.jobId}\nthen: claude rm ${bg.jobId}$`, "m"));
  assert.deepEqual(calls(ctx, "stop"), []);
  assert.equal(ctx.worktreeExists("p-app-30"), true, "worktree of a possibly live job was removed");
  assert.deepEqual(snapshot(ctx), before);
});

// protects: a second job in the spawn's new worktree → act on none, even though the printed job id matches one
// fails_when: flow stops the printed job and leaves the other one running unreported
// no_claim: how two such jobs could arise in real use
test("two jobs in the new worktree: acts on none", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "twin", FLOW_TEST_FAIL: "record" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^rollback: 2 jobs in this worktree \([0-9a-f]{8}, [0-9a-f]{8}\); acted on none$/m);
  assert.match(result.stderr, /^outcome unknown:/m);
  assert.deepEqual(calls(ctx, "stop"), []);
  assert.equal(ctx.jobIds().length, 2);
});

// protects: a record-write failure after claude started stops and removes the job and leaves the state as before
// fails_when: the job leaks, or a card/folder/record stays in the state dir
// no_claim: real disk errors (FLOW_TEST_FAIL simulates the failure point)
test("record write fails: job rolled back, state unchanged", (t) => {
  const ctx = setup(t);
  ctx.init();
  const before = snapshot(ctx);
  const result = ctx.run(SPAWN, { FLOW_TEST_FAIL: "record" });
  assertRefusal(result, { code: 2, first: /^flow spawn: test fault at record for "\(P\) Name P-APP-30"$/ });
  const [bg] = calls(ctx, "--bg");
  assert.deepEqual(ctx.fakeCalls().slice(1).map((call) => call.argv), [["stop", bg.jobId], ["rm", bg.jobId]]);
  assert.deepEqual(ctx.jobIds(), []);
  assert.deepEqual(snapshot(ctx), before);
});

// protects: a commit failure after the record was written puts the state dir back and rolls back the job
// fails_when: the record or card stays uncommitted in the tree, or the job leaks
// no_claim: real git failures (FLOW_TEST_FAIL simulates the failure point)
test("commit fails: state restored, job rolled back", (t) => {
  const ctx = setup(t);
  ctx.init();
  const before = snapshot(ctx);
  const result = ctx.run(SPAWN, { FLOW_TEST_FAIL: "commit" });
  assertRefusal(result, { code: 2, first: /^flow spawn: test fault at commit for/ });
  assert.equal(calls(ctx, "rm").length, 1);
  assert.deepEqual(snapshot(ctx), before);
});

// protects: when claude rm leaves the worktree and branch, flow removes them itself (they are clean and new)
// fails_when: a clean worktree-<slug> worktree or branch of a rolled-back spawn stays behind
// no_claim: dirty worktrees (left alone and reported)
test("rollback removes a clean worktree and branch claude rm left", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FLOW_TEST_FAIL: "record", FAKE_CLAUDE_RM_KEEPS_WORKTREE: "1" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^rollback: removed worktree .*p-app-30$/m);
  assert.match(result.stderr, /^rollback: deleted branch worktree-p-app-30$/m);
  assert.equal(ctx.worktreeExists("p-app-30"), false);
  assert.equal(ctx.branchExists("worktree-p-app-30"), false);
});

// protects: a Claude Code job that already uses the name (in another worktree) blocks the spawn before claude runs, and is never touched
// fails_when: a second session gets the same SendMessage address, or anything stops the existing job
// no_claim: the rollback's own worktree filter (claudeJobs.test covers findSpawnedJobs)
test("same-name job elsewhere: refused up front, left alone", (t) => {
  const ctx = setup(t);
  ctx.init();
  writeJob(ctx, "decafbad", { name: NAME, worktreePath: "/elsewhere/.claude/worktrees/p-app-30", createdAt: new Date().toISOString() });
  assertRefusal(ctx.run(SPAWN), { first: /^flow spawn: name "\(P\) Name P-APP-30" is already used by Claude Code job decafbad$/, fix: /claude stop decafbad/ });
  assert.deepEqual(ctx.fakeCalls(), []);
  assert.deepEqual(ctx.jobIds(), ["decafbad"]);
});

// protects: one matching job next to an unreadable job → act on none (the unreadable one could be ours)
// fails_when: the unreadable check is dropped and flow stops a job while it cannot see them all, or prints stop/rm lines for the unreadable id
// no_claim: why a state.json is unreadable
test("one match plus a fresh unreadable job: acts on none", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "noline-job", FAKE_CLAUDE_UNREADABLE: "1" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^rollback: 1 jobs in this worktree \([0-9a-f]{8}\), and jobs started since this spawn began whose state cannot be read: badbadba; acted on none$/m);
  assert.match(result.stderr, /^outcome unknown: job [0-9a-f]{8} /m);
  assert.match(result.stderr, /^could not read: badbadba \(one may be this spawn's job/m);
  assert.doesNotMatch(result.stderr, /claude (stop|rm) badbadba/);
  assert.deepEqual(calls(ctx, "stop"), []);
  assert.equal(ctx.worktreeExists("p-app-30"), true);
});

// An unrelated job whose state.json is broken and whose folder predates the spawn.
// WHY a real wait, not utimes: only macOS moves a folder's birth time back with utimes; Linux
// keeps the real one. Waiting past rollback's 2 s creation slack makes the folder truly old on both.
async function oldUnreadableJob(ctx) {
  const dir = path.join(ctx.claudeHome, "jobs", "deadbeef");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "state.json"), '{"name":"unrelated sess');
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.ok(fs.statSync(dir).birthtimeMs < Date.now() - 2_000, "the folder's birth time is not older than the slack");
}

// protects: an old unreadable job elsewhere neither blocks a clean "no job was started" nor gets named
// fails_when: one corrupt state.json anywhere turns every failed spawn into "outcome unknown" naming a stranger's job
// no_claim: systems without folder birth times (such jobs still count)
test("old unreadable job elsewhere, claude exits 1: no job was started", async (t) => {
  const ctx = setup(t);
  ctx.init();
  await oldUnreadableJob(ctx);
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "fail" });
  assertRefusal(result, { code: 2, first: /claude --bg exited 1/, fix: /^fix: read the output above/ });
  assert.match(result.stderr, /^rollback: no job was started$/m);
  assert.doesNotMatch(result.stderr, /deadbeef/);
});

// protects: an old unreadable job elsewhere does not stop the rollback of this spawn's own, unambiguous job
// fails_when: our job is leaked (left running) because of an unrelated unreadable file, or the stranger is named
// no_claim: systems without folder birth times
test("old unreadable job elsewhere, job without the line: ours is rolled back", async (t) => {
  const ctx = setup(t);
  ctx.init();
  await oldUnreadableJob(ctx);
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "noline-job" });
  assert.equal(result.status, 2, result.stderr);
  const [bg] = calls(ctx, "--bg");
  assert.match(result.stderr, new RegExp(`^rollback: stopped and removed job ${bg.jobId}$`, "m"));
  assert.doesNotMatch(result.stderr, /deadbeef|outcome unknown/);
  assert.deepEqual(ctx.jobIds().sort(), ["deadbeef"]);
});

// protects: when claude stop fails, rollback runs no rm, keeps the worktree and reports outcome unknown
// fails_when: rm runs after a failed stop, or the worktree of a possibly live job is removed
// no_claim: real claude's stop failure modes (the fake exits 1)
test("claude stop fails: outcome unknown, worktree kept", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FLOW_TEST_FAIL: "record", FAKE_CLAUDE_STOP_FAILS: "1" });
  assertRefusal(result, { code: 2, first: /test fault at record/, fix: /check and clean-up commands above/ });
  assert.match(result.stderr, /^rollback: claude stop [0-9a-f]{8} failed: Error: fake claude stop failed$/m);
  assert.match(result.stderr, /^outcome unknown:/m);
  assert.deepEqual(calls(ctx, "rm"), []);
  assert.equal(ctx.worktreeExists("p-app-30"), true);
});

// protects: claude failing after it made the worktree, with no job state yet, is NOT "no job was started": nothing is removed
// fails_when: rollback removes the worktree/branch a job may still be starting in, and tells the owner to retry
// no_claim: how long a real job takes to write its state.json
test("claude fails after making the worktree: acts on nothing", (t) => {
  const ctx = setup(t);
  ctx.init();
  const before = snapshot(ctx);
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "fail-after-worktree" });
  assertRefusal(result, { code: 2, first: /^flow spawn: claude --bg exited 1 for/, fix: /check and clean-up commands above/ });
  assert.match(result.stderr, /but claude left a worktree or branch; acted on none$/m);
  assert.match(result.stderr, /^outcome unknown: job \(id unknown\)/m);
  assert.match(result.stderr, /^clean up: run claude stop with the job id the check shows/m);
  assert.equal(ctx.worktreeExists("p-app-30"), true);
  assert.equal(ctx.branchExists("worktree-p-app-30"), true);
  assert.deepEqual(snapshot(ctx), before);
});

// protects: claude killed by a signal (timeout, Ctrl-C) with no trace yet is NOT "no job was started": the background service may still start it
// fails_when: rollback claims certainty and tells the owner to simply retry
// no_claim: the 30 s timeout itself (the fake dies at once; same exit shape)
test("claude killed before any trace: outcome unknown", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "killed" });
  assertRefusal(result, { code: 2, first: /^flow spawn: claude --bg exited without a status/, fix: /check and clean-up commands above/ });
  assert.match(result.stderr, /but claude did not exit with an error \(exit 0, timeout or signal\), so a job may still be starting; acted on none$/m);
  assert.match(result.stderr, /^outcome unknown: job \(id unknown\)/m);
});

// protects: a claude binary that cannot be started at all is the one failure where "no job was started" is certain
// fails_when: a missing binary is reported as outcome unknown, or as anything but exit 2 with the cause
// no_claim: a binary that starts and then hangs (the killed test)
test("claude binary missing: no job was started", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FLOW_CLAUDE: path.join(ctx.root, "no-such-claude") });
  assertRefusal(result, { code: 2, first: /claude --bg exited without a status \(.*ENOENT/, fix: /^fix: read the output above/ });
  assert.match(result.stderr, /^rollback: no job was started$/m);
  assert.doesNotMatch(result.stderr, /outcome unknown/);
});

// protects: claude rm refused while the stopped process still holds its worktree lock is retried until it succeeds
// fails_when: one refusal leaves the job and worktree behind with "outcome unknown" (as the live smoke showed for a single try)
// no_claim: processes that take longer than the retries (about 5 s)
test("claude rm refused right after stop: retried", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FLOW_TEST_FAIL: "record", FAKE_CLAUDE_RM_REFUSES: "2" });
  assert.equal(result.status, 2, result.stderr);
  const [bg] = calls(ctx, "--bg");
  assert.match(result.stderr, new RegExp(`^rollback: stopped and removed job ${bg.jobId}$`, "m"));
  assert.equal(calls(ctx, "rm").length, 3);
  assert.deepEqual(ctx.jobIds(), []);
  assert.equal(ctx.worktreeExists("p-app-30"), false);
});

// protects: only the worktree-lock refusal is retried; any other rm failure ends at once and is reported
// fails_when: rm is retried on unrelated failures (holding the state lock), or the failure is hidden
// no_claim: rm timeouts (not retried either; not simulated)
test("claude rm fails for another reason: not retried, outcome unknown", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FLOW_TEST_FAIL: "record", FAKE_CLAUDE_RM_FAILS: "1" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^rollback: claude rm [0-9a-f]{8} failed: Error: fake claude rm failed for another reason$/m);
  assert.equal(calls(ctx, "rm").length, 1);
  assert.match(result.stderr, /^outcome unknown:/m);
});

// protects: the rm retry gives up after 6 lock refusals (bounded time under the state lock)
// fails_when: the retry loops longer, or reports success
// no_claim: the exact wait between tries
test("claude rm refused every time: gives up after 6 tries", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FLOW_TEST_FAIL: "record", FAKE_CLAUDE_RM_REFUSES: "99" });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(calls(ctx, "rm").length, 6);
  assert.match(result.stderr, /^rollback: claude rm [0-9a-f]{8} failed: kept /m);
  assert.match(result.stderr, /^outcome unknown:/m);
});

// protects: at real Claude Code timing (worktreePath written late), a second job in the new worktree still blocks the rollback
// fails_when: the twin without worktreePath is invisible, so flow stops one job and removes the worktree the other uses
// no_claim: jobs created in another repo at the same moment (excluded by their cwd)
test("two jobs, neither with worktreePath yet: acts on none", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "twin", FLOW_TEST_FAIL: "record", FAKE_CLAUDE_LATE_WORKTREE: "1" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^rollback: 2 jobs in this worktree \([0-9a-f]{8}, [0-9a-f]{8}\); acted on none$/m);
  assert.deepEqual(calls(ctx, "stop"), []);
  assert.equal(ctx.worktreeExists("p-app-30"), true);
});

// protects: at real timing, a job started without the line (and without worktreePath yet) is still found by name and rolled back
// fails_when: the job is invisible to rollback and left running
// no_claim: a job that also has another name
test("job without the line and without worktreePath yet: rolled back", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "noline-job", FAKE_CLAUDE_LATE_WORKTREE: "1" });
  assert.equal(result.status, 2, result.stderr);
  const [bg] = calls(ctx, "--bg");
  assert.match(result.stderr, new RegExp(`^rollback: stopped and removed job ${bg.jobId}$`, "m"));
  assert.deepEqual(ctx.jobIds(), []);
  assert.equal(ctx.worktreeExists("p-app-30"), false);
});

// protects: a job whose state.json names a worktree elsewhere is refused, and flow acts on nothing
// fails_when: it is recorded as this session, or flow stops it on the strength of the printed id alone
// no_claim: why claude would report another worktree
test("job in another worktree: refused, acts on nothing", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "elsewhere" });
  assertRefusal(result, { code: 2, first: /^flow spawn: job [0-9a-f]{8} runs as "\(P\) Name P-APP-30" in \/elsewhere\/\.claude\/worktrees\/x, not as expected/, fix: /check and clean-up commands above/ });
  assert.deepEqual(calls(ctx, "stop"), []);
  assert.equal(ctx.jobIds().length, 1);
});

// protects: a job whose state.json does not list its worktree yet (real claude writes it seconds later) is still rolled back by its printed id
// fails_when: the late field makes the job unmatched and it is left running
// no_claim: how late real claude writes it (seen live: more than 2.6 s)
test("job without worktreePath yet: rolled back by its printed id", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FLOW_TEST_FAIL: "record", FAKE_CLAUDE_LATE_WORKTREE: "1" });
  assert.equal(result.status, 2, result.stderr);
  const [bg] = calls(ctx, "--bg");
  assert.match(result.stderr, new RegExp(`^rollback: stopped and removed job ${bg.jobId}$`, "m"));
  assert.deepEqual(ctx.jobIds(), []);
  assert.equal(ctx.worktreeExists("p-app-30"), false);
});

// protects: a job whose state.json carries another name is refused and rolled back by the job id claude printed
// fails_when: the mismatch is recorded as a session, or the job is left running
// no_claim: whether real claude ever changes a name (the live smoke checks the real one)
test("job running under another name: rolled back by its id", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FAKE_CLAUDE_MODE: "rename" });
  assertRefusal(result, { code: 2, first: /^flow spawn: job [0-9a-f]{8} runs as "\(P\) Name P-APP-30 \(renamed\)"/ });
  const [bg] = calls(ctx, "--bg");
  assert.deepEqual(ctx.fakeCalls().slice(1).map((call) => call.argv), [["stop", bg.jobId], ["rm", bg.jobId]]);
  assert.deepEqual(ctx.jobIds(), []);
});

// protects: after the job is stopped and removed, a dirty worktree is left in place and reported as left behind, not as a live job
// fails_when: flow removes uncommitted files, or reports "outcome unknown" for a job it removed
// no_claim: what the uncommitted files are
test("dirty worktree after rollback is left behind and named", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(SPAWN, { FLOW_TEST_FAIL: "record", FAKE_CLAUDE_RM_KEEPS_WORKTREE: "1", FAKE_CLAUDE_DIRTY: "1" });
  assertRefusal(result, { code: 2, first: /test fault at record/, fix: /^fix: remove what is listed as left behind/ });
  assert.match(result.stderr, /^rollback: stopped and removed job [0-9a-f]{8}$/m);
  assert.match(result.stderr, /^left behind: worktree .*p-app-30 \(has changes\); check it, then git -C '/m);
  assert.doesNotMatch(result.stderr, /outcome unknown/);
  assert.equal(ctx.worktreeExists("p-app-30"), true);
});

// protects: a failed issue spawn leaves the existing project folder and records exactly as they were
// fails_when: the rollback deletes or edits files that existed before the command
// no_claim: anything outside the state dir besides the job and its worktree
test("failed issue spawn keeps existing files", (t) => {
  const ctx = setup(t);
  ctx.init();
  assert.equal(ctx.run(SPAWN).status, 0);
  ctx.seed({ "projects/P-APP-30/plan.json": { project: "P-APP-30", issues: [{ id: "APP-400", title: "Title", build: { model: "opus", effort: "high" }, merge: "self" }] }, "projects/P-APP-30/project.json": { ...ctx.readJson("projects/P-APP-30/project.json"), phase: "running" } });
  const before = snapshot(ctx);
  assert.equal(ctx.run(["spawn", "APP-400", "build", "--project", "P-APP-30"], { FAKE_CLAUDE_MODE: "fail" }).status, 2);
  assert.deepEqual(snapshot(ctx), before);
  assert.equal(ctx.readJson("sessions/p-app-30/record.json").status, "running");
});
