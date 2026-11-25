import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FlowError } from "../lib/fail.mjs";
import { LOCK_STALE_MS, LOCK_WAIT_MS, acquireLock, initState, transact } from "../lib/state.mjs";
import { removeTempDir, setup } from "./helpers.mjs";

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-lock-")));
  t.after(() => removeTempDir(dir));
  return dir;
}

// A pid that existed and has exited, so it is certainly dead.
function deadPid() {
  return spawnSync(process.execPath, ["-e", "0"]).pid;
}

function writeLock(dir, { pid, ageMs, command = "test holder" }) {
  fs.writeFileSync(path.join(dir, ".lock"), JSON.stringify({ pid, command, startedAt: new Date(Date.now() - ageMs).toISOString() }));
}

// protects: the lock budget is gate decision d6: 45 s wait, 120 s staleness
// fails_when: the constants drift back to the spec's 10 s / 60 s
// no_claim: that the wait really lasts 45 s (lock-wait.test measures it)
test("lock budget follows d6", () => {
  assert.equal(LOCK_WAIT_MS, 45_000);
  assert.equal(LOCK_STALE_MS, 120_000);
});

// protects: a lock older than 120 s whose holder is dead is taken over; the new lock holds pid, command and start time
// fails_when: a dead 121 s old lock blocks forever, or the new lock lacks its fields
// no_claim: takeover races between two waiters (handled by rename; not timed here)
test("121 s old lock of a dead pid is taken over", (t) => {
  const dir = tempDir(t);
  writeLock(dir, { pid: deadPid(), ageMs: 121_000 });
  const release = acquireLock(dir, { command: "flow test", waitMs: 500 });
  const lock = JSON.parse(fs.readFileSync(path.join(dir, ".lock"), "utf8"));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.command, "flow test");
  assert.ok(Date.now() - Date.parse(lock.startedAt) < 5_000);
  release();
  assert.equal(fs.existsSync(path.join(dir, ".lock")), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// protects: a 61 s old lock is not stale (d6), even with a dead holder; nor is a 121 s old lock whose holder lives
// fails_when: a slow but live command, or a lock under 120 s, loses its lock
// no_claim: the full 45 s wait (lock-wait.test)
test("61 s old lock, or old lock of a live pid, is not taken over", (t) => {
  const dir = tempDir(t);
  // pid 1 (launchd) exists but belongs to root: kill(1, 0) gives EPERM, which means alive.
  for (const holder of [{ pid: deadPid(), ageMs: 61_000 }, { pid: process.pid, ageMs: 121_000 }, { pid: 1, ageMs: 121_000 }]) {
    writeLock(dir, holder);
    const before = fs.readFileSync(path.join(dir, ".lock"), "utf8");
    assert.throws(
      () => acquireLock(dir, { command: "flow test", waitMs: 300 }),
      (error) => error instanceof FlowError && error.what.startsWith(`state is locked by pid ${holder.pid} (test holder, since `) && error.detail[0] === "side effects: none" && error.fix === "retry the same command",
    );
    assert.equal(fs.readFileSync(path.join(dir, ".lock"), "utf8"), before);
  }
});

// protects: an empty lock file (holder died before writing it) counts as stale once its mtime is over 120 s
// fails_when: a half-written lock blocks every later command forever
// no_claim: anything about lock files flow did not write
test("empty lock older than 120 s is taken over", (t) => {
  const dir = tempDir(t);
  const lock = path.join(dir, ".lock");
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 121_000);
  fs.utimesSync(lock, old, old);
  acquireLock(dir, { command: "flow test", waitMs: 500 })();
});

// protects: a failing command puts the state dir back to its last commit before releasing the lock
// fails_when: files written by the failed command stay, or files from earlier commits are lost
// no_claim: restoring ignored files (.lock, *.tmp are not state)
test("transact restores the state dir when the command fails", (t) => {
  const dir = path.join(tempDir(t), "state");
  process.env.FLOW_STATE = dir;
  t.after(() => delete process.env.FLOW_STATE);
  initState();
  transact("seed", (ctx) => {
    ctx.writeText("kept.md", "kept\n");
    ctx.commit("seed");
  });
  assert.throws(() =>
    transact("broken", (ctx) => {
      ctx.writeText("kept.md", "changed\n");
      ctx.writeJson("new/file.json", { a: 1 });
      throw new Error("boom");
    }),
  /boom/);
  assert.equal(fs.readFileSync(path.join(dir, "kept.md"), "utf8"), "kept\n");
  assert.equal(fs.existsSync(path.join(dir, "new")), false);
  assert.equal(fs.existsSync(path.join(dir, ".lock")), false);
});

// protects: a command that commits and then fails is undone back to the commit it started from, not just to HEAD
// fails_when: a commit made before the failure survives the restore
// no_claim: git being killed halfway through a commit (only the outcome is simulated)
test("transact undoes a commit made before the failure", (t) => {
  const dir = path.join(tempDir(t), "state");
  process.env.FLOW_STATE = dir;
  t.after(() => delete process.env.FLOW_STATE);
  initState();
  assert.throws(() =>
    transact("commits then fails", (ctx) => {
      ctx.writeText("half.md", "half\n");
      ctx.commit("half done");
      throw new Error("boom after commit");
    }),
  /boom after commit/);
  assert.equal(fs.existsSync(path.join(dir, "half.md")), false);
  const log = spawnSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  assert.equal(log, "flow init");
});

// protects: git run by flow ignores GIT_DIR / GIT_WORK_TREE from its environment (a git hook or IDE task may set them)
// fails_when: a state commit, reset or clean lands in the repo GIT_DIR points at
// no_claim: other git environment variables (GIT_CONFIG_*, etc.)
test("inherited GIT_DIR does not redirect state writes", (t) => {
  const ctx = setup(t);
  ctx.init();
  const repoHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ctx.repo, encoding: "utf8" }).stdout;
  const result = ctx.run(["spawn", "initiative", "I-1", "--name", "A"], { GIT_DIR: path.join(ctx.repo, ".git"), GIT_WORK_TREE: ctx.repo });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ctx.commits()[0], "spawn i-1: (I)·A I-1");
  assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: ctx.repo, encoding: "utf8" }).stdout, repoHead);
});

// protects: a dirty state tree found on taking the lock is committed first as "recover: uncommitted changes"
// fails_when: leftovers are mixed into the next command's commit, or lost by its restore
// no_claim: why the tree was dirty
test("dirty state tree is committed as recover first", (t) => {
  const ctx = setup(t);
  ctx.init();
  fs.writeFileSync(path.join(ctx.state, "leftover.md"), "from a crash\n");
  assert.equal(ctx.run(["spawn", "initiative", "I-1", "--name", "A"]).status, 0);
  assert.deepEqual(ctx.commits(), ["spawn i-1: (I)·A I-1", "recover: uncommitted changes", "flow init --playbook test"]);
});

// protects: a stale lock is taken over by a real flow command, and the takeover is logged on stderr
// fails_when: a crashed command's lock blocks flow, or the takeover is silent
// no_claim: the log format beyond its leading words
test("flow spawn takes over a stale lock and logs it", (t) => {
  const ctx = setup(t);
  ctx.init();
  const pid = deadPid();
  writeLock(ctx.state, { pid, ageMs: 121_000 });
  const result = ctx.run(["spawn", "initiative", "I-1", "--name", "A"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`^flow: removed stale lock of pid ${pid} \\(test holder, since `, "m"));
});

// protects: two concurrent flow writes both succeed, one after the other, as two commits
// fails_when: one fails, they interleave (claude runs overlap), or they share or lose a commit
// no_claim: fairness or order between the two
test("two concurrent spawns are serialized into two commits", async (t) => {
  const ctx = setup(t);
  ctx.init();
  const slow = { FAKE_CLAUDE_SLEEP_MS: "1500" };
  const [one, two] = await Promise.all([
    ctx.runAsync(["spawn", "initiative", "I-1", "--name", "A"], slow),
    ctx.runAsync(["spawn", "initiative", "I-2", "--name", "B"], slow),
  ]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(two.status, 0, two.stderr);
  const commits = ctx.commits();
  assert.equal(commits.length, 3);
  assert.deepEqual(commits.slice(0, 2).sort(), ["spawn i-1: (I)·A I-1", "spawn i-2: (I)·B I-2"]);
  const [first, second] = ctx.fakeCalls().sort((a, b) => a.startMs - b.startMs);
  // gstack-timing-ok: an ordering check, not a bound: under the lock the second claude run cannot start before the first ends
  assert.ok(second.startMs >= first.endMs, `claude runs overlapped: ${first.endMs} > ${second.startMs}`);
  assert.equal(ctx.untracked(), "");
});
