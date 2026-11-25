// The keeper (keeper/flow-keeper.mjs) against a fake ~/.claude, a temp state dir and a
// temp repo with a local bare origin. Sessions are fake: job folders with state.json,
// transcripts and a pid that is alive (this test process) or dead (a finished child).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { remoteControlStatus } from "../lib/claudeJobs.mjs";
import { FIXED_NOW, ROOT, assertRefusal, gitIn, removeTempDir, setup } from "./helpers.mjs";

const KEEPER = path.join(ROOT, "keeper", "flow-keeper.mjs");
const ALIVE = process.pid;
const DEAD = spawnSync(process.execPath, ["-e", ""]).pid;

const ACTIVE = { type: "system", content: "/remote-control is active · Code in CLI or at https://claude.ai/code" };
const ARCHIVED = { type: "system", content: "Remote Control session ended or archived from another device or app (code 4090)" };

function world(t) {
  const ctx = setup(t);
  ctx.init();
  const origin = path.join(ctx.root, "origin.git");
  gitIn(ctx.root, ["init", "-q", "--bare", "-b", "main", origin]);
  gitIn(ctx.repo, ["remote", "add", "origin", origin]);
  gitIn(ctx.repo, ["push", "-q", "-u", "origin", "main"]);
  const jobsDir = path.join(ctx.claudeHome, "jobs");
  const w = {
    ...ctx,
    origin,
    worktreePath: (slug) => path.join(ctx.repo, ".claude", "worktrees", slug),
    // A job as claude --bg leaves it. events: transcript events after a first user line.
    job({ id, slug, name = slug, events = [ACTIVE], pid = DEAD, bridge = true, worktree = true }) {
      const sessionId = `${id}-1111-4222-8333-444455556666`;
      const worktreePath = w.worktreePath(slug);
      if (worktree) gitIn(ctx.repo, ["worktree", "add", "-q", "-b", `worktree-${slug}`, worktreePath]);
      const transcript = path.join(ctx.claudeHome, "projects", "-fake", `${sessionId}.jsonl`);
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      const lines = [{ type: "user", message: { content: "Read your card and begin." } }, ...events];
      fs.writeFileSync(transcript, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      fs.mkdirSync(path.join(jobsDir, id), { recursive: true });
      const state = { state: "done", name, sessionId, cwd: ctx.repo, worktreePath, worktreeBranch: `worktree-${slug}`, createdAt: "2026-10-26T08:00:00.000Z" };
      if (bridge) state.bridgeSessionId = `cse_${id}`;
      if (pid) state.fakePid = pid;
      fs.writeFileSync(path.join(jobsDir, id, "state.json"), JSON.stringify(state, null, 2));
      return { id, sessionId, worktreePath, slug, name };
    },
    // A flow record for a job (or for a session that has no job any more).
    record(slug, fields) {
      const record = {
        slug,
        jobId: null,
        sessionId: null,
        name: slug,
        role: "build",
        parentSlug: null,
        parentName: null,
        initiative: null,
        project: "P-X-1",
        issue: null,
        model: "claude-opus-5-5",
        effort: "high",
        playbook: "test",
        worktree: slug,
        branch: null,
        pr: null,
        status: "running",
        orphanAlertedAt: null,
        cleanedAt: null,
        createdAt: FIXED_NOW,
        ...fields,
      };
      ctx.seed({ [`sessions/${slug}/record.json`]: record }, `seed ${slug}`);
    },
    recordOf: (slug) => ctx.readJson(`sessions/${slug}/record.json`),
    pins: (ids) => fs.writeFileSync(path.join(jobsDir, "pins.json"), JSON.stringify(ids)),
    readPins: () => JSON.parse(fs.readFileSync(path.join(jobsDir, "pins.json"), "utf8")),
    roster(workers) {
      fs.mkdirSync(path.join(ctx.claudeHome, "daemon"), { recursive: true });
      fs.writeFileSync(path.join(ctx.claudeHome, "daemon", "roster.json"), JSON.stringify({ proto: 1, supervisorPid: ALIVE, workers }));
    },
    // A copy of keeper/ and lib/ at <root>/<relative>, so --install and --plist can be
    // tested from a main checkout and from a session worktree wherever this repo sits.
    checkout(relative) {
      const dir = path.join(ctx.root, relative);
      for (const sub of ["keeper", "lib"]) fs.cpSync(path.join(ROOT, sub), path.join(dir, sub), { recursive: true });
      return dir;
    },
    keeper(args = [], extraEnv = {}, script = KEEPER) {
      const result = spawnSync(process.execPath, [script, ...args], { env: { ...ctx.env, ...extraEnv }, encoding: "utf8", timeout: 120_000 });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    calls: () => ctx.fakeCalls().map((call) => call.argv),
  };
  return w;
}

// Every case from the issue's acceptance in one world: a record-less session and flow
// records in each state.
function everyCase(w) {
  const s = {};
  s.live = w.job({ id: "a0000001", slug: "live", pid: ALIVE }); // record-less, active, running, not pinned
  s.down = w.job({ id: "a0000002", slug: "down" }); // record done, active, dead
  w.record("down", { jobId: s.down.id, sessionId: s.down.sessionId, status: "done" });
  s.gone4090 = w.job({ id: "a0000003", slug: "gone4090", events: [ACTIVE, ARCHIVED], pid: ALIVE });
  w.record("gone4090", { jobId: s.gone4090.id, sessionId: s.gone4090.sessionId });
  s.recArchived = w.job({ id: "a0000004", slug: "rec-archived", pid: ALIVE }); // transcript still active
  w.record("rec-archived", { jobId: s.recArchived.id, sessionId: s.recArchived.sessionId, status: "archived" });
  s.held = w.job({ id: "a0000005", slug: "held" }); // record-less, active, dead, roster still holds it
  w.roster({ [s.held.id]: { pid: DEAD } });
  s.clean = w.job({ id: "a0000006", slug: "clean" });
  w.record("clean", { jobId: s.clean.id, sessionId: s.clean.sessionId, status: "archived" });
  s.dirty = w.job({ id: "a0000007", slug: "dirty" });
  fs.writeFileSync(path.join(s.dirty.worktreePath, "scratch.txt"), "work in progress\n");
  w.record("dirty", { jobId: s.dirty.id, sessionId: s.dirty.sessionId, status: "archived" });
  s.unpushed = w.job({ id: "a0000008", slug: "unpushed" });
  fs.writeFileSync(path.join(s.unpushed.worktreePath, "change.txt"), "committed, never pushed\n");
  gitIn(s.unpushed.worktreePath, ["add", "-A"]);
  gitIn(s.unpushed.worktreePath, ["commit", "-q", "-m", "local only"]);
  w.record("unpushed", { jobId: s.unpushed.id, sessionId: s.unpushed.sessionId, status: "archived" });
  s.missing = w.job({ id: "a0000009", slug: "missing", worktree: false });
  w.record("missing", { jobId: s.missing.id, sessionId: s.missing.sessionId, status: "archived" });
  // Orphan: an archived project session (its job already removed) with a live child.
  w.record("p-x-1", { role: "project", name: "(P) Parent P-X-1", jobId: "b0000001", sessionId: "b0000001-gone", status: "archived", cleanedAt: FIXED_NOW });
  w.record("child", { name: "P-X-1·X-2 Child", parentSlug: "p-x-1", parentName: "(P) Parent P-X-1", worktree: "child", jobId: "b0000002", sessionId: "b0000002-gone" });
  // Record-less, archived in the app, dead: old rules only (unpin), never cleaned.
  s.handArchived = w.job({ id: "a000000a", slug: "hand-archived", events: [ACTIVE, ARCHIVED] });
  w.pins([s.down.id, s.gone4090.id, s.recArchived.id, s.held.id, s.handArchived.id]);
  return s;
}

function logLines(stdout) {
  return stdout.trim().split("\n").map((line) => line.replace(/^\[[^\]]+\] /, ""));
}

function assertLine(lines, pattern) {
  assert.ok(
    lines.some((line) => pattern.test(line)),
    `no line matches ${pattern}:\n${lines.join("\n")}`,
  );
}

// protects: --dry-run prints the expected decision for every case of the issue's acceptance, and acts on nothing
// fails_when: a case gets the wrong decision (e.g. an archived record resumed, a dirty worktree cleaned), or the dry run stops, removes, resumes, writes pins or records
// no_claim: that the real run does the same (next test), or that real Claude Code data has these shapes
test("keeper --dry-run prints the decision for each case and changes nothing", (t) => {
  const w = world(t);
  const s = everyCase(w);
  const pinsBefore = w.readPins();
  const commitsBefore = w.commits();

  const result = w.keeper(["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = logLines(result.stdout);
  for (const line of lines) assert.match(line, /^\(dry run\) /);

  // live RC: pin
  assertLine(lines, /a0000001: pinned$/);
  // dead live (record done counts as live): resume bare
  assertLine(lines, /a0000002 \(down\): down, starting it again$/);
  // 4090 on a recorded session: record archived, stop, unpin
  assertLine(lines, /a0000003 \(gone4090\): archived in the app; record gone4090 set to archived$/);
  assertLine(lines, /a0000003 \(gone4090\): archived in the app, stopping its process$/);
  assertLine(lines, /a0000003: archived in the app, unpinned$/);
  // record archived without 4090: stop, unpin, no resume
  assertLine(lines, /a0000004 \(rec-archived\): record archived, stopping its process$/);
  assertLine(lines, /a0000004: record archived, unpinned$/);
  assert.ok(!lines.some((line) => /a0000004.*starting it again/.test(line)));
  // roster-held: skipped, not started
  assertLine(lines, /a0000005 \(held\): down, but the background service still holds it; not started$/);
  assert.ok(!lines.some((line) => /a0000005.*starting it again/.test(line)));
  // archived clean: rm, branch delete, cleanedAt
  assertLine(lines, /clean: clean and pushed; would claude rm a0000006, delete worktree-clean if merged into origin\/main, set cleanedAt$/);
  // archived dirty / unpushed: logged, left
  assertLine(lines, /dirty: uncommitted: scratch\.txt$/);
  assertLine(lines, /unpushed: unpushed: 1 commits$/);
  // worktree missing: cleanedAt, logged
  assertLine(lines, /missing: worktree missing \(.*missing\); would claude rm a0000009; would set cleanedAt$/);
  // orphan
  assertLine(lines, /ORPHAN \(P\) Parent P-X-1: P-X-1·X-2 Child$/);
  // record-less, archived in the app: unpinned, never cleaned
  assertLine(lines, /a000000a: archived in the app, unpinned$/);
  assert.ok(!lines.some((line) => /hand-archived:/.test(line)), "a record-less session is never cleaned");

  assert.deepEqual(w.calls(), [["agents", "--json", "--all"]], "a dry run only lists sessions");
  assert.deepEqual(w.readPins(), pinsBefore);
  assert.deepEqual(w.commits(), commitsBefore);
  for (const slug of ["clean", "dirty", "unpushed"]) assert.ok(w.worktreeExists(slug));
  assert.equal(w.recordOf("gone4090").status, "running");
});

// protects: a real run acts on each case: pins, bare resume, stop, record archived, cleanup, cleanedAt, orphan alert once; record-less sessions get the old rules only
// fails_when: an archived session is resumed, a dirty/unpushed worktree is removed, a record-less session is cleaned, cleanedAt is set without cleanup, or the orphan line repeats
// no_claim: real claude stop/rm/resume behaviour (fake claude), timing on the real machine
test("keeper run acts on each case; a second run is quiet about orphans", (t) => {
  const w = world(t);
  const s = everyCase(w);

  const first = w.keeper();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const lines = logLines(first.stdout);

  assert.deepEqual(w.readPins().sort(), [s.live.id, s.down.id, s.held.id].sort());
  const calls = w.calls();
  const resumes = w.fakeCalls().filter((call) => call.argv[1] === "--resume");
  assert.deepEqual(resumes.map((call) => [call.argv, call.cwd]), [[["--bg", "--resume", s.down.sessionId], s.down.worktreePath]]);
  assert.ok(calls.some((argv) => argv.join(" ") === `stop ${s.gone4090.id}`));
  assert.ok(calls.some((argv) => argv.join(" ") === `stop ${s.recArchived.id}`));
  assert.deepEqual(
    calls.filter((argv) => argv[0] === "rm").sort(),
    [["rm", s.clean.id], ["rm", s.missing.id]].sort(),
    "only the clean archived session and the one whose worktree is gone are removed",
  );

  assert.equal(w.recordOf("gone4090").status, "archived");
  assert.equal(w.recordOf("down").status, "done");
  // clean: job, worktree and worktree-<slug> branch gone; cleanedAt set
  assert.equal(w.recordOf("clean").cleanedAt, FIXED_NOW);
  assert.ok(!w.worktreeExists("clean"));
  assert.ok(!w.branchExists("worktree-clean"));
  assert.ok(!fs.existsSync(path.join(w.claudeHome, "jobs", s.clean.id)));
  // dirty, unpushed: left, retried
  for (const slug of ["dirty", "unpushed"]) {
    assert.equal(w.recordOf(slug).cleanedAt, null);
    assert.ok(w.worktreeExists(slug));
  }
  assert.equal(w.recordOf("missing").cleanedAt, FIXED_NOW);
  assertLine(lines, /missing: worktree missing \(.*\); claude rm a0000009; cleanedAt set$/);
  assert.ok(!fs.existsSync(path.join(w.claudeHome, "jobs", s.missing.id)), "the job of a missing worktree is removed");
  // still running after its stop: cleanup waits
  assertLine(lines, /gone4090: archived, its process still runs; cleanup next run$/);
  assert.equal(w.recordOf("gone4090").cleanedAt, null);
  // record-less: never cleaned
  assert.ok(w.worktreeExists("hand-archived"));
  // orphan once
  assertLine(lines, /ORPHAN \(P\) Parent P-X-1: P-X-1·X-2 Child$/);
  assert.equal(w.recordOf("p-x-1").orphanAlertedAt, FIXED_NOW);
  assert.ok(w.commits().some((message) => message === "keeper: clean cleaned"));

  const second = w.keeper();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const again = logLines(second.stdout);
  assert.ok(!again.some((line) => line.startsWith("ORPHAN")), `second run repeated the orphan alert:\n${again.join("\n")}`);
  assertLine(again, /dirty: uncommitted: scratch\.txt$/);
  assert.ok(!again.some((line) => /^clean:|^missing:/.test(line)), "cleaned records are not touched again");
});

// protects: a lane that switched to its Linear branch and was merged is cleaned fully: claude rm, worktree-<slug> and the lane branch deleted
// fails_when: worktree-<slug> survives because claude rm keeps it after a branch switch, or the lane branch is deleted with -D
// no_claim: GitHub merges (a local fast-forward stands in for the merge)
test("keeper deletes worktree-<slug> and the merged lane branch after a branch switch", (t) => {
  const w = world(t);
  const lane = w.job({ id: "c0000001", slug: "lane" });
  gitIn(lane.worktreePath, ["checkout", "-q", "-b", "dev/x-1-lane"]);
  fs.writeFileSync(path.join(lane.worktreePath, "feature.txt"), "done\n");
  gitIn(lane.worktreePath, ["add", "-A"]);
  gitIn(lane.worktreePath, ["commit", "-q", "-m", "feature"]);
  gitIn(lane.worktreePath, ["push", "-q", "-u", "origin", "dev/x-1-lane"]);
  gitIn(w.repo, ["merge", "-q", "--ff-only", "dev/x-1-lane"]);
  gitIn(w.repo, ["push", "-q", "origin", "main"]);
  w.record("lane", { jobId: lane.id, sessionId: lane.sessionId, status: "archived" });

  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertLine(logLines(result.stdout), /lane: claude rm c0000001; deleted branch worktree-lane; deleted branch dev\/x-1-lane; cleanedAt set$/);
  assert.ok(!w.worktreeExists("lane"));
  assert.ok(!w.branchExists("worktree-lane"));
  assert.ok(!w.branchExists("dev/x-1-lane"));
  assert.equal(w.recordOf("lane").cleanedAt, FIXED_NOW);
});

// protects: a lane branch origin/<base> does not contain (squash merge) is kept and logged `not merged`; the record's branch wins over the worktree's
// fails_when: an unmerged branch is deleted, or cleanup never finishes because of it
// no_claim: detecting squash merges as merged (the plan logs them instead)
test("keeper keeps a squash-merged lane branch and logs it", (t) => {
  const w = world(t);
  const lane = w.job({ id: "c0000002", slug: "squash" });
  gitIn(lane.worktreePath, ["checkout", "-q", "-b", "dev/x-2-squash"]);
  fs.writeFileSync(path.join(lane.worktreePath, "feature.txt"), "done\n");
  gitIn(lane.worktreePath, ["add", "-A"]);
  gitIn(lane.worktreePath, ["commit", "-q", "-m", "feature"]);
  gitIn(lane.worktreePath, ["push", "-q", "-u", "origin", "dev/x-2-squash"]);
  w.record("squash", { jobId: lane.id, sessionId: lane.sessionId, status: "archived", branch: "dev/x-2-squash" });

  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertLine(logLines(result.stdout), /squash: claude rm c0000002; deleted branch worktree-squash; branch dev\/x-2-squash not merged into origin\/main; left; cleanedAt set$/);
  assert.ok(w.branchExists("dev/x-2-squash"));
  assert.ok(!w.branchExists("worktree-squash"));
  assert.equal(w.recordOf("squash").cleanedAt, FIXED_NOW);
});

// --- PRO-9: a lane archived before its PR merges --------------------------------------

// A lane on its Linear branch with one commit pushed to origin, archived while its PR
// is still open.
function openPrLane(w, id, slug, branch) {
  const lane = w.job({ id, slug });
  gitIn(lane.worktreePath, ["checkout", "-q", "-b", branch]);
  fs.writeFileSync(path.join(lane.worktreePath, `${slug}.txt`), "done\n");
  gitIn(lane.worktreePath, ["add", "-A"]);
  gitIn(lane.worktreePath, ["commit", "-q", "-m", slug]);
  gitIn(lane.worktreePath, ["push", "-q", "-u", "origin", branch]);
  w.record(slug, { jobId: lane.id, sessionId: lane.sessionId, status: "archived", branch });
  return lane;
}

// The PR merges on the remote with a merge commit, as GitHub's merge button makes it.
// The local repo learns of it only by fetching.
function mergeOnRemote(w, branch) {
  const clone = fs.mkdtempSync(path.join(w.root, "merger-"));
  gitIn(w.root, ["clone", "-q", w.origin, clone]);
  gitIn(clone, ["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, `origin/${branch}`]);
  gitIn(clone, ["push", "-q", "origin", "main"]);
}

const linesOf = (lines, slug) => lines.filter((line) => line.startsWith(`${slug}:`));

// protects: a lane cleaned before its PR merged has its branch deleted (git branch -d) by the first run after the merge reaches origin; the keeper fetches for it; the not-merged reason is logged once
// fails_when: the branch survives the merge (cleanedAt ends the keeper's interest), runs between cleanup and merge repeat the reason, the merge is missed because the keeper does not fetch, or the record keeps listing a deleted branch
// no_claim: squash merges (never reachable, see the never-merged test), real GitHub
test("keeper deletes a lane branch once the PR of a lane archived before its merge is merged", (t) => {
  const w = world(t);
  const branch = "dev/x-9-early";
  openPrLane(w, "c1000001", "early", branch);

  const first = w.keeper();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(linesOf(logLines(first.stdout), "early"), [
    "early: claude rm c1000001; deleted branch worktree-early; branch dev/x-9-early not merged into origin/main; left; cleanedAt set",
  ]);
  assert.ok(!w.worktreeExists("early"));
  assert.ok(w.branchExists(branch));
  assert.deepEqual(w.recordOf("early").branchesLeft, [{ branch, reason: "not merged" }]);

  const waiting = w.keeper();
  assert.equal(waiting.status, 0, waiting.stdout + waiting.stderr);
  assert.deepEqual(linesOf(logLines(waiting.stdout), "early"), [], "the not-merged reason is logged once");

  mergeOnRemote(w, branch);
  const merged = w.keeper();
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert.deepEqual(linesOf(logLines(merged.stdout), "early"), ["early: branch dev/x-9-early merged into origin/main; deleted"]);
  assert.ok(!w.branchExists(branch));
  assert.deepEqual(w.recordOf("early").branchesLeft, []);
  assert.equal(w.recordOf("early").cleanedAt, FIXED_NOW, "cleanedAt keeps the first cleanup's time");
  assert.ok(w.commits().includes("keeper: early branches"));

  const after = w.keeper();
  assert.deepEqual(linesOf(logLines(after.stdout), "early"), []);
});

// protects: a lane branch that never merges (abandoned PR, squash merge) stays, is logged once at cleanup, and stays listed
// fails_when: an unmerged branch is deleted, or every run logs it again
// no_claim: that anyone notices the branch later (the one log line is all there is)
test("keeper leaves a never-merged lane branch and logs it once", (t) => {
  const w = world(t);
  const branch = "dev/x-9-never";
  openPrLane(w, "c1000002", "never", branch);
  const first = w.keeper();
  assertLine(linesOf(logLines(first.stdout), "never"), /branch dev\/x-9-never not merged into origin\/main; left; cleanedAt set$/);
  for (const run of [w.keeper(), w.keeper()]) {
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(linesOf(logLines(run.stdout), "never"), []);
  }
  assert.ok(w.branchExists(branch));
  assert.deepEqual(w.recordOf("never").branchesLeft, [{ branch, reason: "not merged" }]);
});

// protects: a listed branch deleted by hand is dropped from the list with one log line
// fails_when: the keeper fails or logs every run for a branch that no longer exists, or keeps it listed
// no_claim: a branch recreated later under the same name (it would be followed again only if listed)
test("keeper drops a listed lane branch that was deleted by hand", (t) => {
  const w = world(t);
  const branch = "dev/x-9-hand";
  openPrLane(w, "c1000003", "hand", branch);
  w.keeper();
  assert.deepEqual(w.recordOf("hand").branchesLeft, [{ branch, reason: "not merged" }]);
  gitIn(w.repo, ["branch", "-q", "-D", branch]);

  const second = w.keeper();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual(linesOf(logLines(second.stdout), "hand"), ["hand: branch dev/x-9-hand is gone; dropped"]);
  assert.deepEqual(w.recordOf("hand").branchesLeft, []);
  assert.deepEqual(linesOf(logLines(w.keeper().stdout), "hand"), []);
});

// protects: --dry-run reports a listed branch that is now merged and acts on nothing; it does not fetch (uses the last fetched refs)
// fails_when: a dry run deletes the branch, writes the record, or fetches
// no_claim: that the real run fetches (the merge test covers it)
test("keeper --dry-run reports a listed branch that merged and changes nothing", (t) => {
  const w = world(t);
  const branch = "dev/x-9-dry";
  openPrLane(w, "c1000004", "dry", branch);
  w.keeper();
  mergeOnRemote(w, branch);

  const stale = w.keeper(["--dry-run"]);
  assert.equal(stale.status, 0, stale.stdout + stale.stderr);
  assert.deepEqual(linesOf(logLines(stale.stdout).map((line) => line.replace(/^\(dry run\) /, "")), "dry"), [], "no fetch, so the merge is not seen yet");

  gitIn(w.repo, ["fetch", "-q", "origin", "main"]);
  const commitsBefore = w.commits();
  const result = w.keeper(["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertLine(logLines(result.stdout), /^\(dry run\) dry: branch dev\/x-9-dry merged into origin\/main; would delete it; would update branchesLeft$/);
  assert.ok(w.branchExists(branch));
  assert.deepEqual(w.recordOf("dry").branchesLeft, [{ branch, reason: "not merged" }]);
  assert.deepEqual(w.commits(), commitsBefore);
});

const REFUSED_LINE = (slug, branch) =>
  `${slug}: branch ${branch} merged into origin/main, but git branch -d refused (checked out somewhere, or the main checkout is behind); left, retried each run`;

// protects: a merged listed branch that git branch -d refuses (checked out in another worktree) stays listed, is logged once, and is deleted by the first run after the refusal ends
// fails_when: the branch is deleted with -D, dropped from the list for good, or the refusal repeats every run
// no_claim: other reasons git branch -d refuses (the no-upstream test covers one)
test("keeper retries a merged listed branch that git branch -d refuses, logging it once", (t) => {
  const w = world(t);
  const branch = "dev/x-9-busy";
  openPrLane(w, "c1000005", "busy", branch);
  w.keeper();
  mergeOnRemote(w, branch);
  const elsewhere = path.join(w.root, "busy-elsewhere");
  gitIn(w.repo, ["worktree", "add", "-q", elsewhere, branch]);

  const second = w.keeper();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual(linesOf(logLines(second.stdout), "busy"), [REFUSED_LINE("busy", branch)]);
  assert.ok(w.branchExists(branch));
  assert.deepEqual(w.recordOf("busy").branchesLeft, [{ branch, reason: "git branch -d refused" }]);
  assert.deepEqual(linesOf(logLines(w.keeper().stdout), "busy"), [], "the refusal is logged once");

  gitIn(w.repo, ["worktree", "remove", elsewhere]);
  assert.deepEqual(linesOf(logLines(w.keeper().stdout), "busy"), ["busy: branch dev/x-9-busy merged into origin/main; deleted"]);
  assert.ok(!w.branchExists(branch));
  assert.deepEqual(w.recordOf("busy").branchesLeft, []);
});

// protects: a merged branch with no upstream (origin's lane branch pruned after the merge) while the main checkout's HEAD is behind origin/<base> is kept, not given up, and deleted once the checkout catches up
// fails_when: the keeper drops the branch because -d compares it with a stale HEAD, or forces it
// no_claim: when the owner fast-forwards the main checkout
test("keeper keeps a merged branch with no upstream until the main checkout catches up", (t) => {
  const w = world(t);
  const branch = "dev/x-9-pruned";
  openPrLane(w, "c1000007", "pruned", branch);
  w.keeper();
  mergeOnRemote(w, branch);
  gitIn(w.repo, ["branch", "--unset-upstream", branch]);

  const behind = w.keeper();
  assert.equal(behind.status, 0, behind.stdout + behind.stderr);
  assert.deepEqual(linesOf(logLines(behind.stdout), "pruned"), [REFUSED_LINE("pruned", branch)]);
  assert.ok(w.branchExists(branch));

  gitIn(w.repo, ["merge", "-q", "--ff-only", "origin/main"]);
  assert.deepEqual(linesOf(logLines(w.keeper().stdout), "pruned"), ["pruned: branch dev/x-9-pruned merged into origin/main; deleted"]);
  assert.ok(!w.branchExists(branch));
});

// protects: with two listed branches, the merged one is deleted and the unmerged one stays listed, its reason not logged again
// fails_when: one branch's outcome changes the other's, or the whole list is cleared
// no_claim: more than two branches (the loop treats each alike)
test("keeper deletes the merged one of two listed branches and keeps the other", (t) => {
  const w = world(t);
  const lane = w.job({ id: "c1000008", slug: "two" });
  // The lane pushed worktree-two, then went on to its Linear branch.
  fs.writeFileSync(path.join(lane.worktreePath, "first.txt"), "first\n");
  gitIn(lane.worktreePath, ["add", "-A"]);
  gitIn(lane.worktreePath, ["commit", "-q", "-m", "first"]);
  gitIn(lane.worktreePath, ["push", "-q", "-u", "origin", "worktree-two"]);
  gitIn(lane.worktreePath, ["checkout", "-q", "-b", "dev/x-9-two"]);
  fs.writeFileSync(path.join(lane.worktreePath, "second.txt"), "second\n");
  gitIn(lane.worktreePath, ["add", "-A"]);
  gitIn(lane.worktreePath, ["commit", "-q", "-m", "second"]);
  gitIn(lane.worktreePath, ["push", "-q", "-u", "origin", "dev/x-9-two"]);
  w.record("two", { jobId: lane.id, sessionId: lane.sessionId, status: "archived", branch: "dev/x-9-two" });
  w.keeper();
  assert.deepEqual(w.recordOf("two").branchesLeft, [
    { branch: "worktree-two", reason: "not merged" },
    { branch: "dev/x-9-two", reason: "not merged" },
  ]);

  mergeOnRemote(w, "worktree-two");
  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(linesOf(logLines(result.stdout), "two"), ["two: branch worktree-two merged into origin/main; deleted"]);
  assert.ok(!w.branchExists("worktree-two"));
  assert.ok(w.branchExists("dev/x-9-two"));
  assert.deepEqual(w.recordOf("two").branchesLeft, [{ branch: "dev/x-9-two", reason: "not merged" }]);
});

// protects: while the fetch fails, every list stays as it is (nothing checked on refs that may be stale); the failure is logged once (not per record, not every run while it lasts), and its end once
// fails_when: a listed branch is dropped or deleted while the fetch fails, the failure line repeats per record or per run, or the lists are not checked again once the fetch works
// no_claim: which fetch errors happen on the real machine, or a reason text that changes every run
test("keeper keeps the branch lists while the fetch fails and logs the failure once", (t) => {
  const w = world(t);
  openPrLane(w, "c1000006", "offline", "dev/x-9-offline");
  openPrLane(w, "c1000009", "offline2", "dev/x-9-offline2");
  w.keeper();
  gitIn(w.repo, ["remote", "set-url", "origin", path.join(w.root, "no-such-origin.git")]);
  gitIn(w.repo, ["branch", "-q", "-D", "dev/x-9-offline2"]); // would be dropped if the run went on
  const failed = /^git fetch origin main failed in .*: .*no-such-origin\.git.*; listed branches are checked once it works$/;

  const first = logLines(w.keeper().stdout);
  assert.equal(first.filter((line) => failed.test(line)).length, 1, first.join("\n"));
  assert.deepEqual([...linesOf(first, "offline"), ...linesOf(first, "offline2")], []);
  assert.deepEqual(w.recordOf("offline").branchesLeft, [{ branch: "dev/x-9-offline", reason: "not merged" }]);
  assert.deepEqual(w.recordOf("offline2").branchesLeft, [{ branch: "dev/x-9-offline2", reason: "not merged" }]);
  assert.match(w.recordOf("offline").branchesFetchError, /no-such-origin\.git/);

  const second = logLines(w.keeper().stdout);
  assert.ok(!second.some((line) => failed.test(line)), `the same failure is logged again:\n${second.join("\n")}`);
  assert.ok(w.recordOf("offline2").branchesLeft.length === 1, "still waiting while offline");

  gitIn(w.repo, ["remote", "set-url", "origin", w.origin]);
  const back = logLines(w.keeper().stdout);
  assert.equal(back.filter((line) => /^git fetch origin main works again in .*; checking listed branches$/.test(line)).length, 1, back.join("\n"));
  assert.deepEqual(linesOf(back, "offline2"), ["offline2: branch dev/x-9-offline2 is gone; dropped"]);
  assert.equal(w.recordOf("offline").branchesFetchError, null);
  assert.deepEqual(logLines(w.keeper().stdout).filter((line) => /^git fetch/.test(line)), []);
});

// protects: the keeper's fetches (cleanup in a worktree, the branch check in the main checkout) never write FETCH_HEAD, which a `git pull` running there at the same time merges
// fails_when: a keeper run changes FETCH_HEAD in the main checkout or in a lane's worktree
// no_claim: the timing of a real pull racing the keeper
test("keeper fetches without touching FETCH_HEAD", (t) => {
  const w = world(t);
  openPrLane(w, "c100000a", "listed", "dev/x-9-listed");
  w.keeper(); // cleaned, branch listed: later runs fetch in the main checkout
  const dirty = w.job({ id: "c100000b", slug: "dirtyfh" });
  fs.writeFileSync(path.join(dirty.worktreePath, "wip.txt"), "not committed\n");
  w.record("dirtyfh", { jobId: dirty.id, sessionId: dirty.sessionId, status: "archived" }); // cleanup fetches, then stops
  const sentinel = "0000000000000000000000000000000000000000\t\tbranch 'main' of somewhere else\n";
  const fetchHeads = [w.repo, dirty.worktreePath].map((dir) => path.resolve(dir, gitIn(dir, ["rev-parse", "--git-path", "FETCH_HEAD"]).trim()));
  assert.notEqual(fetchHeads[0], fetchHeads[1], "a worktree has its own FETCH_HEAD");
  for (const file of fetchHeads) fs.writeFileSync(file, sentinel);

  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertLine(logLines(result.stdout), /^dirtyfh: uncommitted: wip\.txt$/);
  for (const file of fetchHeads) assert.equal(fs.readFileSync(file, "utf8"), sentinel, `${file} changed`);
});

// protects: a hand-edited record that lists the base branch has it dropped from the list, never deleted
// fails_when: the follow-up runs git branch -d on <baseBranch> (main here; origin/main contains it, so -d would succeed)
// no_claim: how such a record came about (cleanup never lists the base branch)
test("keeper drops a listed base branch and never deletes it", (t) => {
  const w = world(t);
  gitIn(w.repo, ["checkout", "-q", "-b", "elsewhere"]); // main is not checked out, so -d would succeed
  w.record("handbase", { status: "archived", cleanedAt: FIXED_NOW, branchesLeft: [{ branch: "main", reason: "not merged" }] });
  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(linesOf(logLines(result.stdout), "handbase"), ["handbase: branch main is the base branch; dropped"]);
  assert.ok(w.branchExists("main"));
  assert.deepEqual(w.recordOf("handbase").branchesLeft, []);
});

// protects: a worktree claude rm leaves behind (clean) is removed with git worktree remove
// fails_when: cleanedAt is set while the worktree is still on disk
// no_claim: when real claude rm leaves a worktree
test("keeper removes a clean worktree that claude rm left", (t) => {
  const w = world(t);
  const left = w.job({ id: "c0000003", slug: "left" });
  w.record("left", { jobId: left.id, sessionId: left.sessionId, status: "archived" });
  const result = w.keeper([], { FAKE_CLAUDE_RM_KEEPS_WORKTREE: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertLine(logLines(result.stdout), /left: claude rm c0000003; removed worktree .*left; deleted branch worktree-left; cleanedAt set$/);
  assert.ok(!w.worktreeExists("left"));
});

// protects: a failing claude rm leaves the record uncleaned and is retried next run
// fails_when: cleanedAt is set although the job was not removed
// no_claim: which rm errors real claude prints
test("keeper retries cleanup when claude rm fails", (t) => {
  const w = world(t);
  const job = w.job({ id: "c0000004", slug: "rmfail" });
  w.record("rmfail", { jobId: job.id, sessionId: job.sessionId, status: "archived" });
  const result = w.keeper([], { FAKE_CLAUDE_RM_FAILS: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertLine(logLines(result.stdout), /rmfail: claude rm c0000004 failed: .*; cleanup next run$/);
  assert.equal(w.recordOf("rmfail").cleanedAt, null);
  assert.ok(w.worktreeExists("rmfail"));
});

// protects: a job that no longer holds the record's session is never stopped or removed, and the worktree it works in stays
// fails_when: claude stop/rm reaches a job id that now belongs to another session, or cleanup removes that session's worktree or branch
// no_claim: how real claude reuses job ids
test("keeper acts on nothing when the job holds another session", (t) => {
  const w = world(t);
  const other = w.job({ id: "c0000005", slug: "reused", pid: ALIVE });
  w.record("reused", { jobId: other.id, sessionId: "c0000005-other-session", status: "archived" });
  w.pins([other.id]);
  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!w.calls().some((argv) => argv[0] === "stop" || argv[0] === "rm"), w.calls().map((argv) => argv.join(" ")).join("\n"));
  assertLine(logLines(result.stdout), /reused: worktree .*reused is used by job c0000005; left$/);
  assert.ok(w.worktreeExists("reused"));
  assert.ok(w.branchExists("worktree-reused"));
  assert.equal(w.recordOf("reused").cleanedAt, null);
  assert.deepEqual(w.readPins(), [other.id], "the live session keeps its pin");
});

// protects: a worktree a session started by hand works in (its cwd) is never removed by a record's cleanup
// fails_when: cleanup removes a worktree under a live hand-started session
// no_claim: sessions whose cwd claude does not record
test("keeper leaves a worktree that another job's cwd is inside", (t) => {
  const w = world(t);
  const lane = w.job({ id: "c0000006", slug: "shared" });
  w.record("shared", { jobId: lane.id, sessionId: lane.sessionId, status: "archived" });
  const jobs = path.join(w.claudeHome, "jobs");
  fs.mkdirSync(path.join(jobs, "c0000007"));
  fs.writeFileSync(path.join(jobs, "c0000007", "state.json"), JSON.stringify({ name: "by hand", sessionId: "c0000007-hand", cwd: path.join(lane.worktreePath, "sub"), createdAt: FIXED_NOW }));
  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertLine(logLines(result.stdout), /shared: worktree .*shared is used by job c0000007; left$/);
  assert.ok(w.worktreeExists("shared"));
  assert.ok(!w.calls().some((argv) => argv[0] === "rm"));
});

// protects: one session the keeper cannot read (transcript unreadable, no session id) is skipped and the rest of the run goes on
// fails_when: one bad session ends the run before other sessions are pinned or resumed
// no_claim: which read errors real transcripts produce
test("keeper skips an unreadable session and handles the others", (t) => {
  const w = world(t);
  const bad = w.job({ id: "e0000001", slug: "bad" });
  const transcript = path.join(w.claudeHome, "projects", "-fake", `${bad.sessionId}.jsonl`);
  fs.rmSync(transcript);
  fs.mkdirSync(transcript); // reading it now fails (EISDIR)
  const jobs = path.join(w.claudeHome, "jobs");
  fs.mkdirSync(path.join(jobs, "e0000002"));
  fs.writeFileSync(path.join(jobs, "e0000002", "state.json"), JSON.stringify({ name: "starting", createdAt: FIXED_NOW }));
  w.job({ id: "e0000003", slug: "good" });
  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = logLines(result.stdout);
  assertLine(lines, /e0000001 \(bad\): failed: .*; left alone$/);
  assertLine(lines, /e0000002: claude agents lists it without a session id; left alone$/);
  assertLine(lines, /e0000003 \(good\): down, starting it again$/);
  assert.ok(w.calls().some((argv) => argv[1] === "--resume"));
});

// protects: with an unreadable roster the keeper starts and cleans nothing (it cannot tell a shutting-down session from a dead one), but still pins
// fails_when: a session is resumed (a copy) or cleaned while the roster cannot be read, or the run fails
// no_claim: how often the real roster is half-written
test("keeper with an unreadable roster resumes and cleans nothing", (t) => {
  const w = world(t);
  const down = w.job({ id: "e0000004", slug: "down2" });
  const clean = w.job({ id: "e0000005", slug: "clean2" });
  w.record("clean2", { jobId: clean.id, sessionId: clean.sessionId, status: "archived" });
  w.pins([]);
  fs.mkdirSync(path.join(w.claudeHome, "daemon"), { recursive: true });
  fs.writeFileSync(path.join(w.claudeHome, "daemon", "roster.json"), "{half");
  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = logLines(result.stdout);
  assertLine(lines, /roster\.json is not JSON.*; no session is started or cleaned this run$/);
  assertLine(lines, /e0000004 \(down2\): down, but the background service still holds it; not started$/);
  assert.deepEqual(w.readPins(), [down.id]);
  assert.ok(!w.calls().some((argv) => argv[1] === "--resume" || argv[0] === "rm"));
  assert.ok(w.worktreeExists("clean2"));
});

// protects: a recorded session whose worktree is gone is not resumed in the main checkout
// fails_when: the keeper falls back to the job's cwd (the repo's main checkout) for a flow session
// no_claim: record-less sessions, which keep the old keeper's cwd fallback
test("keeper does not resume a recorded session outside its worktree", (t) => {
  const w = world(t);
  const lost = w.job({ id: "e0000006", slug: "lost", worktree: false });
  w.record("lost", { jobId: lost.id, sessionId: lost.sessionId, status: "running" });
  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertLine(logLines(result.stdout), /e0000006 \(lost\): down, but its worktree is gone; cannot start it$/);
  assert.ok(!w.calls().some((argv) => argv[1] === "--resume"));
});

// protects: the copy safety net: when resume starts a copy, the copy is stopped and removed at once
// fails_when: a copy is left running next to the original session
// no_claim: the exact text real claude prints for a copy
test("keeper removes a copy that a resume started", (t) => {
  const w = world(t);
  w.job({ id: "d0000001", slug: "copied" });
  const result = w.keeper([], { FAKE_CLAUDE_RESUME_COPY: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertLine(logLines(result.stdout), /d0000001 \(copied\): the CLI started a copy c0c0c0c0 instead; stopping and removing the copy$/);
  const calls = w.calls().map((argv) => argv.join(" "));
  assert.ok(calls.includes("stop c0c0c0c0") && calls.includes("rm c0c0c0c0"), calls.join("\n"));
});

// protects: the keeper never writes pins.json while the CLI holds pins.json.lock
// fails_when: pins change under the CLI's lock
// no_claim: the race between the check and the rename (see updatePins)
test("keeper leaves pins alone while pins.json.lock exists", (t) => {
  const w = world(t);
  w.job({ id: "d0000002", slug: "pinme", pid: ALIVE });
  w.pins([]);
  fs.mkdirSync(path.join(w.claudeHome, "jobs", "pins.json.lock"));
  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertLine(logLines(result.stdout), /pins not written: .*pins\.json\.lock exists/);
  assert.deepEqual(w.readPins(), []);
});

// protects: a run stops starting actions once its budget is used, so it ends inside launchd's 300 s interval
// fails_when: actions run after the budget, or the budget is not logged
// no_claim: the real duration of a run on this machine
test("keeper stops acting when its run budget is used up", (t) => {
  const w = world(t);
  w.job({ id: "d0000003", slug: "late" });
  const result = w.keeper([], { FLOW_KEEPER_BUDGET_MS: "0" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertLine(logLines(result.stdout), /run budget of 0 s used up; the rest waits for the next run$/);
  assert.ok(!w.calls().some((argv) => argv[1] === "--resume"));
});

// protects: a missing flow state dir leaves the old rules working (pins, resume), with one log line
// fails_when: the keeper fails or skips record-less sessions when flow is not set up
// no_claim: anything about records
test("keeper without a state dir keeps the old rules", (t) => {
  const w = world(t);
  w.job({ id: "d0000004", slug: "nostate", pid: ALIVE });
  const result = w.keeper([], { FLOW_STATE: path.join(w.root, "no-state") });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = logLines(result.stdout);
  assertLine(lines, /no flow state dir at .*no-state; only the old rules apply$/);
  assertLine(lines, /d0000004: pinned$/);
});

// protects: an unknown `claude agents` shape stops the run loudly (exit 1) instead of acting on guesses
// fails_when: the keeper acts when it cannot read the session list
// no_claim: future Claude Code output formats
test("keeper run fails loudly when claude agents fails", (t) => {
  const w = world(t);
  const result = w.keeper([], { FLOW_CLAUDE: path.join(w.root, "no-such-claude") });
  assert.equal(result.status, 1);
  assertLine(logLines(result.stdout), /keeper run failed: claude agents --json --all failed/);
});

// protects: the latest Remote Control system event decides; a marker quoted in a message does not count
// fails_when: a quoted 4090 text archives a live session, or an older event wins over a newer one
// no_claim: other transcript event types
test("remoteControlStatus reads only system events, latest wins", (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "flow-transcript-"));
  t.after(() => removeTempDir(dir));
  const file = path.join(dir, "t.jsonl");
  const write = (events) => fs.writeFileSync(file, `${[{ type: "user" }, ...events].map((event) => JSON.stringify(event)).join("\n")}\n`);
  write([ACTIVE, { type: "assistant", content: ARCHIVED.content }]);
  assert.equal(remoteControlStatus(file), "active");
  write([ACTIVE, ARCHIVED]);
  assert.equal(remoteControlStatus(file), "archived");
  write([ARCHIVED, ACTIVE]);
  assert.equal(remoteControlStatus(file), "active");
  write([{ type: "assistant", content: "nothing" }]);
  assert.equal(remoteControlStatus(file), null);
});

// Runs --install from a main checkout copy with an empty HOME; returns the result, the
// printed lines, the launchctl lines (without `launchctl print`) and the paths they use.
function installRun(t, args) {
  const w = world(t);
  const home = path.join(w.root, "home");
  fs.mkdirSync(home);
  const main = w.checkout("main-checkout");
  const result = w.keeper(["--install", ...args], { HOME: home }, path.join(main, "keeper", "flow-keeper.mjs"));
  const lines = result.stdout.split("\n");
  const launchctl = lines.filter((line) => line.startsWith("launchctl ") && !line.startsWith("launchctl print"));
  const agents = `${home}/Library/LaunchAgents`;
  return { result, lines, launchctl, home, main, agents, uid: process.getuid(), newPlist: `'${agents}/com.product-dev-flow.keeper.plist'` };
}

// The rules every printed block keeps: the render comes before any launchctl line, the
// check names the new label, the owner's paste rule (no rm, no comment lines), and
// nothing written to HOME.
function assertInstallBlock(run) {
  const { result, lines, launchctl, home, main, newPlist } = run;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`'${main}/keeper/flow-keeper.mjs' --plist > `), result.stdout);
  assert.match(result.stdout, /^Nothing was installed; run these yourself\.$/m);
  assert.doesNotMatch(result.stdout, /Multi-currency|gate d4/);
  const render = lines.findIndex((line) => line.endsWith(`flow-keeper.mjs' --plist > ${newPlist}`));
  assert.ok(render >= 0 && render < lines.indexOf(launchctl[0]), result.stdout);
  assert.ok(lines.includes(`launchctl print gui/${run.uid}/com.product-dev-flow.keeper`), result.stdout);
  assert.ok(!lines.some((line) => /^\s*(rm|#)/.test(line)), "no rm and no comment lines in a paste block");
  assert.deepEqual(fs.readdirSync(home), [], "nothing written to HOME");
}

// protects: --install --replace <old> prints the switch (render; <old> booted out and disabled; the new label enabled, then bootstrapped) and the rollback (new label booted out and disabled; <old> enabled, then bootstrapped from its plist), and installs nothing
// fails_when: --install writes a plist or runs launchctl, the given old label is not the one switched off and back on, or a printed sequence leaves either keeper loadable at the next login when it should be off (both keepers running)
// no_claim: that launchctl accepts the commands (the owner runs them at switch time)
test("keeper --install --replace prints the switch and rollback and installs nothing", (t) => {
  const run = installRun(t, ["--replace", "com.example.old"]);
  assertInstallBlock(run);
  const { uid, newPlist, agents } = run;
  assert.match(run.result.stdout, /^Switch from com\.example\.old to the flow keeper /m);
  assert.match(run.result.stdout, /^Back to com\.example\.old:$/m);
  assert.deepEqual(run.launchctl, [
    // switch
    `launchctl bootout gui/${uid}/com.example.old`,
    `launchctl disable gui/${uid}/com.example.old`,
    `launchctl enable gui/${uid}/com.product-dev-flow.keeper`,
    `launchctl bootstrap gui/${uid} ${newPlist}`,
    // rollback
    `launchctl bootout gui/${uid}/com.product-dev-flow.keeper`,
    `launchctl disable gui/${uid}/com.product-dev-flow.keeper`,
    `launchctl enable gui/${uid}/com.example.old`,
    `launchctl bootstrap gui/${uid} '${agents}/com.example.old.plist'`,
  ]);
});

// protects: --install without --replace prints only the new label's install (enable, bootstrap) and its undo (bootout, disable), and installs nothing
// fails_when: any label other than com.product-dev-flow.keeper is booted out, disabled, enabled or bootstrapped, or the undo leaves the new keeper loadable at the next login
// no_claim: that launchctl accepts the commands; a machine where an older keeper still runs (that is what --replace is for)
test("keeper --install without --replace touches only the new label", (t) => {
  const run = installRun(t, []);
  assertInstallBlock(run);
  const { uid, newPlist } = run;
  assert.match(run.result.stdout, /^Install the flow keeper /m);
  assert.deepEqual(run.launchctl, [
    `launchctl enable gui/${uid}/com.product-dev-flow.keeper`,
    `launchctl bootstrap gui/${uid} ${newPlist}`,
    `launchctl bootout gui/${uid}/com.product-dev-flow.keeper`,
    `launchctl disable gui/${uid}/com.product-dev-flow.keeper`,
  ]);
});

// protects: --replace takes a plain launchd label and nothing else, so nothing but a label is pasted into the printed launchctl lines
// fails_when: --replace with no value, with a flag after it, written as --replace=<label>, naming the new label itself, or with a value holding a space, quote, slash or semicolon prints any block or exits 0, or the refusal lacks the usage fix
// no_claim: that a label which passes names a LaunchAgent that exists
test("keeper --install --replace refuses a missing or non-label value", (t) => {
  const w = world(t);
  const main = w.checkout("main-checkout");
  const script = path.join(main, "keeper", "flow-keeper.mjs");
  const home = path.join(w.root, "home");
  const fix = /^fix: node keeper\/flow-keeper\.mjs --install --replace com\.example\.old$/;
  const refusals = [
    [["--replace"], /^flow-keeper: --replace needs a label$/],
    [["--replace", "--dry-run"], /^flow-keeper: --replace needs a label$/],
    [["--replace=com.example.old"], /^flow-keeper: --replace needs a label as the next argument, not after =$/],
    [["--replace", "com.product-dev-flow.keeper"], /^flow-keeper: --replace needs the old label; com\.product-dev-flow\.keeper is the flow keeper's own$/],
    ...["com.example.old; rm -rf ~", "com example", "it's", "../com.example.old", ""].map((value) => [["--replace", value], /^flow-keeper: --replace needs a label; ".*" is not one$/]),
  ];
  for (const [args, first] of refusals) {
    const result = w.keeper(["--install", ...args], { HOME: home }, script);
    assertRefusal(result, { first, fix });
    assert.equal(result.stdout, "", `${JSON.stringify(args)}: printed nothing to paste`);
  }
});

// protects: an untracked file counts as uncommitted even when the repo sets status.showUntrackedFiles=no
// fails_when: a worktree with only a new untracked file is cleaned (claude rm, worktree removed) because git status hid it
// no_claim: ignored files (they go with a cleaned worktree by design)
test("keeper sees untracked files despite status.showUntrackedFiles=no", (t) => {
  const w = world(t);
  gitIn(w.repo, ["config", "status.showUntrackedFiles", "no"]);
  const job = w.job({ id: "f0000001", slug: "hidden" });
  fs.mkdirSync(path.join(job.worktreePath, "new"));
  fs.writeFileSync(path.join(job.worktreePath, "new", "draft.txt"), "not committed\n");
  w.record("hidden", { jobId: job.id, sessionId: job.sessionId, status: "archived" });
  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertLine(logLines(result.stdout), /hidden: uncommitted: new\/draft\.txt$/);
  assert.ok(w.worktreeExists("hidden"));
  assert.ok(!w.calls().some((argv) => argv[0] === "rm"));
  assert.equal(w.recordOf("hidden").cleanedAt, null);
});

// protects: the base branch is never deleted, even when a record names it as the lane branch
// fails_when: cleanup runs git branch -d on <baseBranch> (main here), which origin/main trivially contains
// no_claim: other protected branches a repo may have
test("keeper never deletes the base branch", (t) => {
  const w = world(t);
  gitIn(w.repo, ["checkout", "-q", "-b", "elsewhere"]); // main is not checked out, so -d would succeed
  const job = w.job({ id: "f0000002", slug: "onbase" });
  w.record("onbase", { jobId: job.id, sessionId: job.sessionId, status: "archived", branch: "main" });
  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = logLines(result.stdout);
  assertLine(lines, /onbase: claude rm f0000002; cleanedAt set$/);
  assert.ok(!lines.some((line) => /branch main/.test(line)), lines.join("\n"));
  assert.ok(w.branchExists("main"));
});

// protects: an archived record whose worktree is already gone still has its job removed (guarded), then cleanedAt
// fails_when: the job stays in claude's list after cleanedAt, or a job holding another session is removed
// no_claim: why the worktree went missing
test("keeper removes the job of a record whose worktree is missing", (t) => {
  const w = world(t);
  const gone = w.job({ id: "f0000003", slug: "gone", worktree: false });
  w.record("gone", { jobId: gone.id, sessionId: gone.sessionId, status: "archived" });
  const other = w.job({ id: "f0000004", slug: "gone-other", worktree: false });
  w.record("gone-other", { jobId: other.id, sessionId: "f0000004-not-this-one", status: "archived" });
  const result = w.keeper();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = logLines(result.stdout);
  assertLine(lines, /gone: worktree missing \(.*gone\); claude rm f0000003; cleanedAt set$/);
  assertLine(lines, /gone-other: worktree missing \(.*gone-other\); cleanedAt set$/);
  const rms = w.calls().filter((argv) => argv[0] === "rm");
  assert.deepEqual(rms, [["rm", "f0000003"]]);
  assert.ok(!fs.existsSync(path.join(w.claudeHome, "jobs", "f0000003")));
  assert.ok(fs.existsSync(path.join(w.claudeHome, "jobs", "f0000004")));
  assert.equal(w.recordOf("gone").cleanedAt, FIXED_NOW);
});

// protects: --plist renders the template under the neutral label com.product-dev-flow.keeper, with absolute node, claude and git paths, the repo path and the log path, and no placeholder left
// fails_when: the rendered Label is not com.product-dev-flow.keeper, a bare command name reaches launchd's PATH, or a placeholder is left unrendered
// no_claim: that launchd starts it (switch time)
test("keeper --plist renders the neutral label and absolute paths", (t) => {
  const w = world(t);
  const main = w.checkout("main-checkout");
  const result = w.keeper(["--plist"], { HOME: "/Users/someone" }, path.join(main, "keeper", "flow-keeper.mjs"));
  assert.equal(result.status, 0, result.stderr);
  const plist = result.stdout;
  assert.ok(!plist.includes("{{"), plist);
  assert.match(plist, /<key>Label<\/key><string>com\.product-dev-flow\.keeper<\/string>/);
  const strings = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  const node = strings[strings.indexOf("flow-keeper") + 1];
  assert.ok(path.isAbsolute(node) && fs.existsSync(node), `node: ${node}`);
  assert.equal(strings[strings.indexOf("flow-keeper") + 2], path.join(main, "keeper", "flow-keeper.mjs"));
  assert.match(plist, /<key>FLOW_CLAUDE<\/key><string>[^<]*fake-claude\.mjs<\/string>/);
  const git = plist.match(/<key>FLOW_GIT<\/key><string>([^<]+)<\/string>/)[1];
  assert.ok(path.isAbsolute(git) && fs.existsSync(git), `git: ${git}`);
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/Users\/someone\/Library\/Logs\/flow-keeper\.log<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>300<\/integer>/);
  const lint = spawnSync("plutil", ["-lint", "-"], { input: plist, encoding: "utf8" });
  if (lint.error?.code !== "ENOENT") assert.equal(lint.status, 0, lint.stdout + lint.stderr);
});

// protects: --install and --plist refuse to run from a session worktree (a LaunchAgent rendered there breaks when the worktree is removed) and name the main checkout in the fix line, keeping --replace <old>
// fails_when: a plist or switch commands pointing into .claude/worktrees/ are printed, the refusal exits 0, or the fix line drops --replace <old> (the owner would then get the plain install and leave the old keeper running)
// no_claim: other checkouts that might be removed later
test("keeper --install and --plist refuse a session worktree checkout", (t) => {
  const w = world(t);
  const lane = w.checkout(path.join("main-checkout", ".claude", "worktrees", "pro-5-build"));
  const main = path.join(w.root, "main-checkout");
  for (const flag of ["--install", "--plist", "--install --replace com.example.old"]) {
    const result = w.keeper(flag.split(" "), { HOME: path.join(w.root, "home") }, path.join(lane, "keeper", "flow-keeper.mjs"));
    assert.equal(result.status, 1, `${flag}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, "", `${flag} printed nothing to paste`);
    const lines = result.stderr.trimEnd().split("\n");
    assert.match(lines[0], /^flow-keeper: .*\.claude\/worktrees\/pro-5-build is a session worktree/);
    assert.equal(lines.at(-1), `fix: node '${main}/keeper/flow-keeper.mjs' ${flag}   (from the main checkout ${main})`);
  }
});
