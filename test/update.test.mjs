import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertRefusal, setup } from "./helpers.mjs";

// An initiative and a project session started through flow spawn with the fake claude,
// so each has a real fake job (jobs/<jobId>/state.json) to stop.
function startTwo(ctx) {
  ctx.init();
  for (const args of [
    ["spawn", "initiative", "I-9", "--name", "Fees"],
    ["spawn", "project", "P-APP-25", "--name", "Books", "--initiative", "I-9"],
  ]) {
    const result = ctx.run(args);
    assert.equal(result.status, 0, result.stderr);
  }
  return { initiative: ctx.readJson("sessions/i-9/record.json"), project: ctx.readJson("sessions/p-app-25/record.json") };
}

function pinsFile(ctx) {
  return path.join(ctx.claudeHome, "jobs", "pins.json");
}

function writePins(ctx, pins) {
  fs.writeFileSync(pinsFile(ctx), JSON.stringify(pins));
}

function readPins(ctx) {
  return JSON.parse(fs.readFileSync(pinsFile(ctx), "utf8"));
}

function stopCalls(ctx) {
  return ctx.fakeCalls().filter((call) => call.argv[0] === "stop").map((call) => call.argv.slice(1));
}

// protects: flow set writes pr, branch and status=done into the record in one commit; the same values again change nothing and make no commit
// fails_when: a field is not stored (or stored as text for pr), other fields change, or a no-op makes a commit
// no_claim: that the PR or branch exists on GitHub (flow never calls GitHub)
test("flow set updates pr, branch and status in one commit", (t) => {
  const ctx = setup(t);
  const { project } = startTwo(ctx);
  const before = ctx.commits().length;
  const result = ctx.run(["set", "p-app-25", "pr=#12", "branch=dev/pro-6-flow-tree", "status=done"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "p-app-25: pr=12 branch=dev/pro-6-flow-tree status=done\n");
  assert.deepEqual(ctx.readJson("sessions/p-app-25/record.json"), { ...project, pr: 12, branch: "dev/pro-6-flow-tree", status: "done" });
  assert.equal(ctx.commits().length, before + 1);
  assert.equal(ctx.commits()[0], "set p-app-25: pr=12 branch=dev/pro-6-flow-tree status=done");

  const again = ctx.run(["set", "p-app-25", "pr=12"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, "p-app-25: no change\n");
  assert.equal(ctx.commits().length, before + 1);
});

// protects: flow set refuses unknown keys and bad values with exit 1 and the d5 shape, and writes nothing
// fails_when: an unknown key (or status other than done, a bad pr or branch, a repeated key, no pair) is accepted or changes the record
// no_claim: every invalid git branch name is caught (only the common mistakes are)
test("flow set rejects unknown keys and bad values", (t) => {
  const ctx = setup(t);
  const { project } = startTwo(ctx);
  const before = ctx.commits();
  const cases = [
    [["model=opus"], /^flow set: unknown key "model" in "model=opus"$/, /pr, branch, status/],
    [["pr"], /^flow set: pr has no value$/],
    [["pr=abc"], /^flow set: pr="abc" is not a PR number$/],
    [["pr=0"], /^flow set: pr="0" is not a PR number$/],
    [["branch=my branch"], /^flow set: branch="my branch" is not a branch name$/],
    [["branch=--force"], /^flow set: branch="--force" is not a branch name$/],
    [["status=archived"], /^flow set: status="archived" is not allowed$/, /flow archive/],
    [["status=running"], /^flow set: status="running" is not allowed$/],
    [["pr=1", "pr=2"], /^flow set: pr given twice$/],
    [[], /^flow set: nothing to set$/],
  ];
  for (const [pairs, first, fix] of cases) assertRefusal(ctx.run(["set", "p-app-25", ...pairs]), { first, fix });
  assertRefusal(ctx.run(["set", "p-app-99", "pr=1"]), { first: /^flow set: no session with slug "p-app-99"$/, fix: /flow tree --all/ });
  assertRefusal(ctx.run(["set"]), { first: /^flow set: no slug given$/ });
  assert.deepEqual(ctx.readJson("sessions/p-app-25/record.json"), project);
  assert.deepEqual(ctx.commits(), before);
});

// protects: an archived record cannot be changed by flow set (archived is final)
// fails_when: flow set status=done (or any key) un-archives or edits an archived record
// no_claim: —
test("flow set refuses an archived record", (t) => {
  const ctx = setup(t);
  startTwo(ctx);
  assert.equal(ctx.run(["archive", "p-app-25"]).status, 0);
  assertRefusal(ctx.run(["set", "p-app-25", "status=done"]), { first: /^flow set: session p-app-25 is archived/ });
  assert.equal(ctx.readJson("sessions/p-app-25/record.json").status, "archived");
});

// protects: flow archive sets status archived (one commit), calls claude stop with the record's job id, and removes exactly that pin from pins.json
// fails_when: the status is not archived, stop gets another id (or is not called), claude rm is called, or other pins change
// no_claim: that a real session stops (live check), or that the keeper later cleans it up (PRO-5)
test("flow archive sets the status, stops the job and unpins it", (t) => {
  const ctx = setup(t);
  const { initiative, project } = startTwo(ctx);
  writePins(ctx, ["aaaaaaaa", project.jobId, initiative.jobId]);
  const before = ctx.commits().length;
  const result = ctx.run(["archive", "p-app-25"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `archived "${project.name}" (p-app-25)\n  stopped job ${project.jobId}\n  unpinned\n`);
  assert.deepEqual(ctx.readJson("sessions/p-app-25/record.json"), { ...project, status: "archived" });
  assert.equal(ctx.commits().length, before + 1);
  assert.equal(ctx.commits()[0], `archive p-app-25: ${project.name}`);
  assert.deepEqual(stopCalls(ctx), [[project.jobId]]);
  assert.equal(ctx.fakeCalls().filter((call) => call.argv[0] === "rm").length, 0);
  assert.deepEqual(readPins(ctx), ["aaaaaaaa", initiative.jobId]);
});

// protects: flow archive is idempotent: an archived record whose job still exists gets stop and unpin again, with no new commit
// fails_when: a second archive refuses, skips the stop or the unpin, or commits
// no_claim: how real claude answers a stop on an already stopped session (live check)
test("flow archive again stops and unpins again", (t) => {
  const ctx = setup(t);
  const { project } = startTwo(ctx);
  assert.equal(ctx.run(["archive", "p-app-25"]).status, 0);
  const commits = ctx.commits();
  writePins(ctx, [project.jobId]); // something pinned it again
  const result = ctx.run(["archive", "p-app-25"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^already archived "/);
  assert.deepEqual(stopCalls(ctx), [[project.jobId], [project.jobId]]);
  assert.deepEqual(readPins(ctx), []);
  assert.deepEqual(ctx.commits(), commits);
});

// protects: a failing claude stop leaves the record archived (committed) and exits 2 with claude's message; the pin is still removed
// fails_when: the status is rolled back, the exit code is not 2, or the message hides claude's output
// no_claim: why claude stop failed
test("flow archive with a failing claude stop keeps the record archived and exits 2", (t) => {
  const ctx = setup(t);
  const { project } = startTwo(ctx);
  writePins(ctx, [project.jobId]);
  const result = ctx.run(["archive", "p-app-25"], { FAKE_CLAUDE_STOP_FAILS: "1" });
  assertRefusal(result, { code: 2, first: new RegExp(`^flow archive: claude stop ${project.jobId} failed: Error: fake claude stop failed$`), fix: /flow archive p-app-25 again/ });
  assert.match(result.stderr, /record: p-app-25 is archived/);
  assert.equal(ctx.readJson("sessions/p-app-25/record.json").status, "archived");
  assert.equal(ctx.untracked(), "");
  assert.deepEqual(readPins(ctx), []);
});

// protects: a pins.json flow cannot read does not hide the outcome: a failed stop still exits 2 naming claude's error, a good stop exits 0; both warn that pins were left unchanged
// fails_when: the shape error replaces the stop result (exit 1 "unexpected error"), or no warning is printed
// no_claim: what wrote the malformed pins.json
test("flow archive with an unreadable pins.json still reports the stop", (t) => {
  const ctx = setup(t);
  const { initiative, project } = startTwo(ctx);
  fs.writeFileSync(pinsFile(ctx), "{}");
  const failed = ctx.run(["archive", "p-app-25"], { FAKE_CLAUDE_STOP_FAILS: "1" });
  assertRefusal(failed, { code: 2, first: new RegExp(`^flow archive: claude stop ${project.jobId} failed`) });
  assert.match(failed.stderr, /warning: .*pins\.json is not an array of job ids .*; pins left unchanged/);
  const ok = ctx.run(["archive", "i-9"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`stopped job ${initiative.jobId}`));
  assert.match(ok.stderr, /^flow archive: warning: .*pins left unchanged/);
  assert.equal(fs.readFileSync(pinsFile(ctx), "utf8"), "{}");
});

// protects: while the CLI holds pins.json.lock, flow archive leaves the pin, warns on stderr and still exits 0
// fails_when: pins.json is written under the lock, the warning is missing, or the exit code is not 0
// no_claim: that the keeper unpins it later (PRO-5)
test("flow archive with pins.json.lock held leaves the pin and warns", (t) => {
  const ctx = setup(t);
  const { project } = startTwo(ctx);
  writePins(ctx, [project.jobId]);
  fs.mkdirSync(`${pinsFile(ctx)}.lock`);
  const result = ctx.run(["archive", "p-app-25"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^flow archive: warning: .*pins\.json\.lock exists/);
  assert.doesNotMatch(result.stdout, /unpinned/);
  assert.deepEqual(readPins(ctx), [project.jobId]);
  assert.equal(ctx.readJson("sessions/p-app-25/record.json").status, "archived");
  assert.deepEqual(stopCalls(ctx), [[project.jobId]]);
});

// protects: flow archive stops and unpins only the job that holds the record's session: a job folder holding another session is neither stopped nor unpinned (exit 1, claude never ran); a removed job is nothing to stop (exit 0); a moved session is stopped under its new id
// fails_when: claude stop is called on, or the pin removed from, a job whose state.json names another session; that case exits 0; a removed job fails; or the moved job is not followed
// no_claim: —
test("flow archive acts only on the job that holds the session", (t) => {
  const ctx = setup(t);
  const { initiative, project } = startTwo(ctx);
  const jobs = path.join(ctx.claudeHome, "jobs");
  // The project's job folder now names another session: act on nothing (no stop, no unpin), and say so.
  const stateFile = path.join(jobs, project.jobId, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, sessionId: "someone-else" }));
  writePins(ctx, [project.jobId]);
  const mismatch = ctx.run(["archive", "p-app-25"]);
  assertRefusal(mismatch, { code: 1, first: new RegExp(`^flow archive: job ${project.jobId} does not hold session .*; acted on nothing$`), fix: /claude agents/ });
  assert.match(mismatch.stderr, /record: p-app-25 is archived/);
  assert.equal(ctx.readJson("sessions/p-app-25/record.json").status, "archived");
  assert.deepEqual(stopCalls(ctx), []);
  assert.deepEqual(readPins(ctx), [project.jobId]);

  // Once the job is removed (claude rm), archiving again is nothing to stop.
  fs.rmSync(path.join(jobs, project.jobId), { recursive: true });
  const gone = ctx.run(["archive", "p-app-25"]);
  assert.equal(gone.status, 0, gone.stderr);
  assert.match(gone.stdout, /no job holds session .*; nothing to stop/);
  assert.deepEqual(stopCalls(ctx), []);

  // The initiative's session moved to another job id: that one is stopped and both ids unpinned.
  const moved = "bbbbbbbb";
  fs.renameSync(path.join(jobs, initiative.jobId), path.join(jobs, moved));
  writePins(ctx, [initiative.jobId, moved, "cccccccc"]);
  const result = ctx.run(["archive", "i-9"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stopCalls(ctx), [[moved]]);
  assert.deepEqual(readPins(ctx), ["cccccccc"]);
});

// protects: archiving a parent names its open children (now ORPHAN); an unknown slug or a stray argument is refused
// fails_when: open children are not listed, an archived child is listed, or an unknown slug exits 0 or stops anything
// no_claim: that the children are archived too (they are not; the parent session does that)
test("flow archive lists open children and refuses an unknown slug", (t) => {
  const ctx = setup(t);
  const { project } = startTwo(ctx);
  const result = ctx.run(["archive", "i-9"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`open children, now ORPHAN until archived: "${project.name.replace(/[()]/g, "\\$&")}" \\(p-app-25\\)`));
  assert.match(ctx.run(["tree"]).stdout, /ORPHAN \(parent "\(I\)·Fees I-9" archived\)/);

  const calls = ctx.fakeCalls().length;
  assertRefusal(ctx.run(["archive", "p-app-99"]), { first: /^flow archive: no session with slug "p-app-99"$/ });
  assertRefusal(ctx.run(["archive", "../sessions/i-9"]), { first: /^flow archive: no session with slug "\.\.\/sessions\/i-9"$/ });
  assertRefusal(ctx.run(["archive", "i-9", "p-app-25"]), { first: /^flow archive: unexpected argument "p-app-25"$/ });
  assertRefusal(ctx.run(["archive"]), { first: /^flow archive: no slug given$/ });
  assert.equal(ctx.fakeCalls().length, calls);
});
