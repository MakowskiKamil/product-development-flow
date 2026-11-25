import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn as spawnChild } from "node:child_process";
import { FlowError } from "../lib/fail.mjs";
import {
  ClaudeShapeError,
  claudeHome,
  findSpawnedJobs,
  guardJob,
  waitForJobState,
  parseBackgrounded,
  pinsPath,
  readJobState,
  readPins,
  readRoster,
  stopAndRemove,
  updatePins,
} from "../lib/claudeJobs.mjs";
import { FAKE_CLAUDE, removeTempDir } from "./helpers.mjs";

// A fake ~/.claude for this process: lib/claudeJobs reads FLOW_CLAUDE_HOME on every call.
function fakeHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-home-")));
  fs.mkdirSync(path.join(home, "jobs"));
  const log = path.join(home, "fake.log");
  Object.assign(process.env, { FLOW_CLAUDE_HOME: home, FLOW_CLAUDE: FAKE_CLAUDE, FAKE_CLAUDE_LOG: log });
  t.after(() => {
    for (const key of ["FLOW_CLAUDE_HOME", "FLOW_CLAUDE", "FAKE_CLAUDE_LOG"]) delete process.env[key];
    removeTempDir(home);
  });
  return {
    home,
    job(jobId, state) {
      fs.mkdirSync(path.join(home, "jobs", jobId), { recursive: true });
      fs.writeFileSync(path.join(home, "jobs", jobId, "state.json"), typeof state === "string" ? state : JSON.stringify(state));
    },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).argv) : []),
  };
}

const STATE = { name: "N", sessionId: "s-1", createdAt: "2026-10-26T09:00:00.000Z", worktreePath: "/r/.claude/worktrees/x" };

// protects: the job id comes from the line `backgrounded · <jobId> · <name>`, also when coloured or among other lines
// fails_when: the line is missed, or a different line is taken for it
// no_claim: claude versions that print another format (they fail loudly or return null)
test("parseBackgrounded reads the line", () => {
  const name = "(P) I-0·Probe names P-X-1";
  assert.deepEqual(parseBackgrounded(`Starting…\nbackgrounded · 7378c7ab · ${name}\nmore\n`), { jobId: "7378c7ab", name });
  assert.deepEqual(parseBackgrounded(`\x1b[2mbackgrounded · 0fa7963b · ${name}\x1b[0m\n`), { jobId: "0fa7963b", name });
  assert.equal(parseBackgrounded("Error: not logged in\n"), null);
  assert.equal(parseBackgrounded("the job was backgrounded · later\n"), null);
});

// protects: an unknown shape fails loudly instead of yielding a wrong job id
// fails_when: a non-hex or long job id is accepted
// no_claim: which shapes future claude versions will use
test("parseBackgrounded rejects an unknown job id shape", () => {
  assert.throws(() => parseBackgrounded("backgrounded · JOB-1 · name\n"), ClaudeShapeError);
});

// protects: state.json is read with its sessionId; a missing one returns null; a wrong shape throws
// fails_when: a state without sessionId/name/createdAt is accepted, or non-JSON is ignored
// no_claim: fields flow does not read
test("readJobState checks the shape", (t) => {
  const home = fakeHome(t);
  assert.equal(readJobState("aaaaaaaa"), null);
  home.job("aaaaaaaa", STATE);
  assert.equal(readJobState("aaaaaaaa").sessionId, "s-1");
  home.job("bbbbbbbb", { name: "N", createdAt: STATE.createdAt });
  assert.throws(() => readJobState("bbbbbbbb"), (error) => error instanceof ClaudeShapeError && /"sessionId"/.test(error.message));
  home.job("cccccccc", "{not json");
  assert.throws(() => readJobState("cccccccc"), ClaudeShapeError);
  // worktreePath may be missing (written later by claude) but must be a string when present.
  home.job("dddddddd", { name: "N", sessionId: "s-1", createdAt: STATE.createdAt });
  assert.equal(readJobState("dddddddd").worktreePath, undefined);
  home.job("eeeeeeee", { ...STATE, worktreePath: 42 });
  assert.throws(() => readJobState("eeeeeeee"), (error) => error instanceof ClaudeShapeError && /non-string "worktreePath"/.test(error.message));
});

// protects: before stop/rm, the job must still hold the record's sessionId; a moved session is found by sessionId; else nothing
// fails_when: flow stops a job id that now belongs to another session
// no_claim: how claude reassigns job ids (only that flow checks)
test("guardJob follows the session id", (t) => {
  const home = fakeHome(t);
  home.job("aaaaaaaa", STATE);
  assert.equal(guardJob("aaaaaaaa", "s-1"), "aaaaaaaa");
  home.job("aaaaaaaa", { ...STATE, sessionId: "other" });
  home.job("dddddddd", STATE);
  assert.equal(guardJob("aaaaaaaa", "s-1"), "dddddddd");
  assert.equal(guardJob("aaaaaaaa", "s-404"), null);
});

// protects: on a session mismatch stopAndRemove calls neither claude stop nor rm
// fails_when: a stop or rm runs against an unverified job
// no_claim: claude's own stop behaviour
test("stopAndRemove acts on nothing on mismatch, stop then rm on match", (t) => {
  const home = fakeHome(t);
  home.job("aaaaaaaa", { ...STATE, sessionId: "someone-else" });
  const result = stopAndRemove("aaaaaaaa", "s-1");
  assert.equal(result.ok, false);
  assert.match(result.message, /acted on nothing/);
  assert.deepEqual(home.calls(), []);
  home.job("eeeeeeee", STATE);
  assert.equal(stopAndRemove("eeeeeeee", "s-1").ok, true);
  assert.deepEqual(home.calls(), [["stop", "eeeeeeee"], ["rm", "eeeeeeee"]]);
});

// protects: pins are written by temp file + rename and never while pins.json.lock exists
// fails_when: flow writes under the CLI's lock, or leaves a temp file behind
// no_claim: the CLI's own locking protocol beyond the lock's existence
test("updatePins writes atomically and respects pins.json.lock", (t) => {
  fakeHome(t);
  assert.deepEqual(readPins(), []);
  assert.deepEqual(updatePins((pins) => [...pins, "aaaaaaaa"]), { written: true });
  assert.deepEqual(readPins(), ["aaaaaaaa"]);
  fs.mkdirSync(`${pinsPath()}.lock`);
  const locked = updatePins((pins) => [...pins, "bbbbbbbb"]);
  assert.equal(locked.written, false);
  assert.match(locked.warning, /pins\.json\.lock exists/);
  assert.deepEqual(readPins(), ["aaaaaaaa"]);
  assert.deepEqual(fs.readdirSync(path.dirname(pinsPath())).sort(), ["pins.json", "pins.json.lock"]);
});

// protects: a concurrent change to pins.json between read and rename is never overwritten: retry once, then warn
// fails_when: flow's write erases a pin another writer added
// no_claim: a writer that changes the file without changing mtime or content
test("updatePins retries once on a concurrent change, then warns", (t) => {
  fakeHome(t);
  updatePins(() => ["aaaaaaaa"]);
  const once = updatePins((pins) => [...pins, "bbbbbbbb"], {
    beforeRename: (attempt) => attempt === 1 && fs.writeFileSync(pinsPath(), JSON.stringify(["aaaaaaaa", "cccccccc"])),
  });
  assert.deepEqual(once, { written: true });
  assert.deepEqual(readPins(), ["aaaaaaaa", "cccccccc", "bbbbbbbb"]);

  let n = 0;
  const always = updatePins((pins) => [...pins, "dddddddd"], { beforeRename: () => fs.writeFileSync(pinsPath(), JSON.stringify([`x${(n += 1)}`])) });
  assert.equal(always.written, false);
  assert.match(always.warning, /kept changing/);
  assert.deepEqual(readPins(), ["x2"]);
});

// protects: pins.json and roster.json of an unknown shape fail loudly
// fails_when: an object where an array is expected is treated as "no pins" and overwritten
// no_claim: roster fields other than workers
test("pins and roster shapes are checked", (t) => {
  const home = fakeHome(t);
  fs.writeFileSync(pinsPath(), JSON.stringify({ pins: [] }));
  assert.throws(() => readPins(), ClaudeShapeError);
  assert.throws(() => updatePins((pins) => pins), ClaudeShapeError);
  assert.deepEqual(readRoster().workers, {});
  fs.mkdirSync(path.join(home.home, "daemon"));
  fs.writeFileSync(path.join(home.home, "daemon", "roster.json"), JSON.stringify({ supervisorPid: 1, workers: { aaaaaaaa: { pid: 2 } } }));
  assert.deepEqual(Object.keys(readRoster().workers), ["aaaaaaaa"]);
  fs.writeFileSync(path.join(home.home, "daemon", "roster.json"), JSON.stringify({ workers: [] }));
  assert.throws(() => readRoster(), ClaudeShapeError);
});

// protects: rollback candidates are jobs in the spawn's worktree created after it began; with a printed id only that id matches, else the name
// fails_when: an older same-name job in the same worktree, or a same-name job in another worktree, counts as this spawn's job
// no_claim: clock skew larger than the 2 s slack
test("findSpawnedJobs filters by worktree, start time, then id or name", (t) => {
  const home = fakeHome(t);
  const wt = "/r/.claude/worktrees/x";
  const since = Date.now();
  const at = (offsetMs) => new Date(since + offsetMs).toISOString();
  home.job("0add0bb0", { ...STATE, worktreePath: wt, createdAt: at(-3_600_000) });
  home.job("e15e0000", { ...STATE, worktreePath: "/other/.claude/worktrees/x", createdAt: at(1_000) });
  home.job("aaaaaaaa", { ...STATE, worktreePath: wt, createdAt: at(500) });
  assert.deepEqual(findSpawnedJobs({ name: "N", worktreePath: wt, sinceMs: since }).matches.map((job) => job.jobId), ["aaaaaaaa"]);
  home.job("bbbbbbbb", { ...STATE, name: "Other", worktreePath: wt, createdAt: at(800) });
  const byName = findSpawnedJobs({ name: "N", worktreePath: wt, sinceMs: since });
  // The hour-old job in this worktree is never a match, but it cannot be ruled out either: it is among the others.
  assert.deepEqual([byName.matches.map((job) => job.jobId), byName.others.map((job) => job.jobId).sort()], [["aaaaaaaa"], ["0add0bb0", "bbbbbbbb"]]);
  const byId = findSpawnedJobs({ name: "N", worktreePath: wt, sinceMs: since, jobId: "bbbbbbbb" });
  assert.deepEqual(byId.matches.map((job) => job.jobId), ["bbbbbbbb"]);
  // A state.json that claims another job id never replaces the directory name.
  home.job("cccccccc", { ...STATE, jobId: "--all", worktreePath: wt, createdAt: at(900) });
  const ids = findSpawnedJobs({ name: "N", worktreePath: wt, sinceMs: since }).matches.map((job) => job.jobId);
  assert.deepEqual(ids.sort(), ["aaaaaaaa", "cccccccc"]);
  // A job in this worktree whose createdAt cannot be read cannot be ruled out: it counts as another job.
  home.job("dddddddd", { ...STATE, name: "N", worktreePath: wt, createdAt: "soon" });
  assert.ok(findSpawnedJobs({ name: "N", worktreePath: wt, sinceMs: since }).others.some((job) => job.jobId === "dddddddd"));
  // A fresh job that has not written worktreePath yet counts as here when its cwd is this repo, not when it is another repo.
  home.job("f0000001", { ...STATE, name: "Late", worktreePath: undefined, cwd: "/r", createdAt: at(700) });
  home.job("f0000002", { ...STATE, name: "Late", worktreePath: undefined, cwd: "/other", createdAt: at(700) });
  const late = findSpawnedJobs({ name: "Late", worktreePath: wt, sinceMs: since });
  assert.deepEqual(late.matches.map((job) => job.jobId), ["f0000001"]);
  assert.ok(!late.others.some((job) => job.jobId === "f0000002"));
  // A job without a session id is never a match (nothing to guard the stop with).
  home.job("eeeeeeee", { name: "Z", worktreePath: wt, createdAt: at(950) });
  const noSession = findSpawnedJobs({ name: "Z", worktreePath: wt, sinceMs: since });
  assert.deepEqual([noSession.matches.length, noSession.others.some((job) => job.jobId === "eeeeeeee")], [0, true]);
});

// protects: a half-written state.json is retried until it parses, within 10 × 200 ms
// fails_when: the first parse error ends the wait and rollback acts on nothing for a job that was fine
// no_claim: how real claude writes the file (atomically or not); a writer stalled for the whole 1.8 s window; that the retry is needed when this process stalls over 300 ms between "ready" and its first read
test("waitForJobState retries a half-written state.json", async (t) => {
  const home = fakeHome(t);
  home.job("aaaaaaaa", '{"name": "N", "sessi');
  const file = path.join(home.home, "jobs", "aaaaaaaa", "state.json");
  // A separate process finishes the file while this one waits synchronously.
  // WHY "ready" first: node start-up can take a second on a busy machine, so the writer's
  // delay only starts once it runs. The 300 ms after "ready" keeps the first read on the
  // half-written file (so the test fails without the retry) and leaves 1.5 s of the window.
  const writer = spawnChild(process.execPath, ["-e", `process.stdout.write("ready"); setTimeout(() => require("fs").writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(JSON.stringify(STATE))}), 300)`]);
  const exited = new Promise((resolve) => writer.on("exit", resolve));
  await new Promise((resolve, reject) => {
    writer.stdout.once("data", resolve);
    writer.once("exit", (code) => reject(new Error(`writer exited (${code}) before it was ready`)));
  });
  assert.equal(waitForJobState("aaaaaaaa").sessionId, "s-1");
  await exited;
  home.job("bbbbbbbb", "{never json");
  assert.throws(() => waitForJobState("bbbbbbbb"), ClaudeShapeError);
});

// protects: under node --test, lib refuses to fall back to the real ~/.claude when the override is missing
// fails_when: a test that forgets FLOW_CLAUDE_HOME reads or changes the real jobs, pins or sessions
// no_claim: protection outside node --test
test("claudeHome refuses the real ~/.claude under node --test", () => {
  const saved = process.env.FLOW_CLAUDE_HOME;
  delete process.env.FLOW_CLAUDE_HOME;
  try {
    assert.throws(() => claudeHome(), (error) => error instanceof FlowError && /without FLOW_CLAUDE_HOME/.test(error.what));
  } finally {
    if (saved !== undefined) process.env.FLOW_CLAUDE_HOME = saved;
  }
});

// protects: guardJob never hands a malformed job id to claude stop/rm
// fails_when: an id like "--all" or "../x" is used as a path or a claude argument
// no_claim: ids claude itself might print in future formats
test("guardJob rejects malformed job ids", (t) => {
  const home = fakeHome(t);
  home.job("aaaaaaaa", STATE);
  assert.equal(guardJob("--all", "s-404"), null);
  assert.equal(guardJob("../aaaaaaaa", "s-1"), "aaaaaaaa"); // found by its session id under its real name
  assert.equal(stopAndRemove("--all", "s-404").ok, false);
  // No session id to check against: act on nothing, even if exactly one job lacks one too.
  home.job("ffffffff", { name: "N", createdAt: STATE.createdAt, worktreePath: "/w" });
  assert.equal(guardJob("ffffffff", undefined), null);
  assert.equal(guardJob("0bad0bad", undefined), null);
  // followMoved: false (rollback) refuses when the session now lives in another job.
  home.job("12345678", { ...STATE, sessionId: "moved" });
  home.job("87654321", { ...STATE, sessionId: "someone-else" });
  assert.equal(stopAndRemove("87654321", "moved", { followMoved: false }).ok, false);
  // The fallback search never returns a folder name outside the job-id format.
  home.job("--all", { ...STATE, sessionId: "only-in-dashdash" });
  assert.equal(guardJob("aaaaaaaa", "only-in-dashdash"), null);
  assert.equal(stopAndRemove("aaaaaaaa", "only-in-dashdash").ok, false);
  assert.deepEqual(home.calls(), []);
});
