#!/usr/bin/env node
// Fake `claude` for tests (FLOW_CLAUDE points here). It never starts a session.
// `--bg` mimics what real claude does that flow relies on: a worktree and branch
// worktree-<slug> in its cwd, jobs/<jobId>/state.json under FLOW_CLAUDE_HOME, and
// the line `backgrounded · <jobId> · <name>`. `stop` and `rm` act on that fake job.
// Every call is appended to FAKE_CLAUDE_LOG as one JSON line.
//
// FAKE_CLAUDE_MODE for --bg:
//   ok          job, worktree, line (default)
//   fail        prints an error, exits 1, starts nothing
//   noline      exits 0, prints no line, starts nothing
//   noline-job  starts the job and worktree, prints no line
//   nostate     prints the line and makes the worktree, writes no state.json
//   twin        starts two jobs with the same name and worktree
//   fail-after-worktree  makes the worktree, then fails (exit 1) with no job state
//   rename      prints the line, but the job's state.json carries another name
//   killed      dies from SIGKILL before doing anything (no exit code)
//   badid       starts a job but prints its id in an unknown format (JOB-0001)
//   elsewhere   the job's state.json names a worktree in another repo
// FAKE_CLAUDE_RM_FAILS=1  `rm` fails with an error that is not the worktree-lock refusal
// FAKE_CLAUDE_SLEEP_MS  wait this long inside --bg (concurrency tests)
// FAKE_CLAUDE_STARTED_FILE  create this file as soon as --bg starts (signal tests wait for it)
// FAKE_CLAUDE_DIRTY=1   leave an untracked file in the new worktree
// FAKE_CLAUDE_UNREADABLE=1  also create a fresh job folder (badbadba) whose state.json is not JSON
// FAKE_CLAUDE_LATE_WORKTREE=1  state.json without worktreePath/worktreeBranch (real claude
//   writes them seconds later, once the worktree is set up)
// FAKE_CLAUDE_RM_KEEPS_WORKTREE=1  `rm` removes the job but leaves worktree and branch
// FAKE_CLAUDE_STOP_FAILS=1  `stop` prints an error and exits 1
//
// For the keeper:
// `agents --json --all` lists every job folder as a background session; the pid comes
//   from the fixture-only field `fakePid` in its state.json (none: not running).
// `--bg --resume <sessionId>` prints the wake line; FAKE_CLAUDE_RESUME_COPY=1 makes it
//   say it started a copy (c0c0c0c0) instead, as real claude does for a running session.
// `rm` on a worktree that has switched to another branch removes the worktree but keeps
//   both branches, as real claude does (checked live 2026-10-26, 2.1.310).

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const startMs = Date.now();
const home = process.env.FLOW_CLAUDE_HOME;
const jobs = path.join(home, "jobs");

function log(extra = {}) {
  if (!process.env.FAKE_CLAUDE_LOG) return;
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), startMs, endMs: Date.now(), ...extra })}\n`);
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function flag(name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function newJob(name, worktreePath, slug) {
  const jobId = crypto.randomBytes(4).toString("hex");
  fs.mkdirSync(path.join(jobs, jobId), { recursive: true });
  const state = {
    state: "working",
    name,
    sessionId: crypto.randomUUID(),
    cwd: process.cwd(),
    worktreePath,
    worktreeBranch: `worktree-${slug}`,
    respawnFlags: argv,
    createdAt: new Date().toISOString(),
  };
  return { jobId, state };
}

function writeState({ jobId, state }) {
  const written = { ...state };
  if (process.env.FAKE_CLAUDE_LATE_WORKTREE) {
    delete written.worktreePath;
    delete written.worktreeBranch;
  }
  fs.writeFileSync(path.join(jobs, jobId, "state.json"), JSON.stringify(written, null, 2));
}

function background() {
  const mode = process.env.FAKE_CLAUDE_MODE || "ok";
  const slug = flag("-w");
  const name = flag("-n");
  const worktreePath = path.join(process.cwd(), ".claude", "worktrees", slug);
  // Tells a test that flow is now inside its spawn (so its signal handlers are installed).
  if (process.env.FAKE_CLAUDE_STARTED_FILE) fs.writeFileSync(process.env.FAKE_CLAUDE_STARTED_FILE, "");
  if (process.env.FAKE_CLAUDE_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_CLAUDE_SLEEP_MS));
  if (mode === "killed") {
    log({ mode });
    process.kill(process.pid, "SIGKILL"); // like a timeout or a Ctrl-C: no exit code
  }
  if (mode === "fail") {
    console.error("Error: fake claude was told to fail");
    log({ mode });
    process.exit(1);
  }
  if (mode === "noline") {
    console.log("fake claude: nothing started");
    log({ mode });
    return;
  }
  if (process.env.FAKE_CLAUDE_UNREADABLE) {
    fs.mkdirSync(path.join(jobs, "badbadba"), { recursive: true });
    fs.writeFileSync(path.join(jobs, "badbadba", "state.json"), "{not json");
  }
  git(process.cwd(), ["worktree", "add", "-q", "-b", `worktree-${slug}`, worktreePath]);
  if (process.env.FAKE_CLAUDE_DIRTY) fs.writeFileSync(path.join(worktreePath, "scratch.txt"), "uncommitted\n");
  if (mode === "fail-after-worktree") {
    console.error("Error: fake claude failed after creating the worktree");
    log({ mode });
    process.exit(1);
  }
  const job = newJob(mode === "rename" ? `${name} (renamed)` : name, mode === "elsewhere" ? "/elsewhere/.claude/worktrees/x" : worktreePath, slug);
  if (mode !== "nostate") writeState(job);
  if (mode === "twin") writeState(newJob(name, worktreePath, slug));
  console.log("Starting a background session…");
  if (mode === "badid") console.log(`backgrounded · JOB-0001 · ${name}`);
  else if (mode !== "noline-job") console.log(`backgrounded · ${job.jobId} · ${name}`);
  log({ mode, jobId: job.jobId, sessionId: job.state.sessionId });
}

function remove(jobId) {
  const file = path.join(jobs, jobId, "state.json");
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  fs.rmSync(path.join(jobs, jobId), { recursive: true, force: true });
  // Like real claude rm: removes the job's worktree and branch (known from -w even when
  // state.json does not list them yet).
  const slug = state?.respawnFlags?.[state.respawnFlags.indexOf("-w") + 1];
  const worktreePath = state?.worktreePath ?? (slug && path.join(state.cwd, ".claude", "worktrees", slug));
  if (worktreePath && !process.env.FAKE_CLAUDE_RM_KEEPS_WORKTREE && fs.existsSync(worktreePath)) {
    const branch = state.worktreeBranch ?? `worktree-${slug}`;
    const current = execFileSync("git", ["branch", "--show-current"], { cwd: worktreePath, encoding: "utf8" }).trim();
    git(state.cwd, ["worktree", "remove", worktreePath]);
    if (current === branch) git(state.cwd, ["branch", "-D", branch]);
  }
}

function agents() {
  const list = [];
  for (const jobId of fs.existsSync(jobs) ? fs.readdirSync(jobs) : []) {
    const file = path.join(jobs, jobId, "state.json");
    if (!fs.existsSync(file)) continue;
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const entry = { id: jobId, cwd: state.worktreePath ?? state.cwd, kind: "background", sessionId: state.sessionId, name: state.name, state: state.state };
    if (state.fakePid) entry.pid = state.fakePid;
    list.push(entry);
  }
  console.log(JSON.stringify(list));
}

function resume(sessionId) {
  if (process.env.FAKE_CLAUDE_RESUME_COPY) console.log(`session ${sessionId} is running; started a copy as c0c0c0c0`);
  else console.log(`woke session ${sessionId} with its saved options`);
  log();
}

if (argv[0] === "--bg" && argv[1] === "--resume") resume(argv[2]);
else if (argv[0] === "--bg") background();
else if (argv[0] === "agents") {
  log();
  agents();
}
else if (argv[0] === "stop") {
  log();
  if (process.env.FAKE_CLAUDE_STOP_FAILS) {
    console.error("Error: fake claude stop failed");
    process.exit(1);
  }
}
else if (argv[0] === "rm") {
  // FAKE_CLAUDE_RM_REFUSES=<n>: refuse the first n rm calls, as real claude does while
  // the stopped process still holds its worktree lock.
  const counter = path.join(home, "rm-refusals");
  const refused = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  if (process.env.FAKE_CLAUDE_RM_FAILS) {
    log({ failed: true });
    console.error("Error: fake claude rm failed for another reason");
    process.exit(1);
  }
  if (refused < Number(process.env.FAKE_CLAUDE_RM_REFUSES || 0)) {
    fs.writeFileSync(counter, String(refused + 1));
    log({ refused: true });
    console.error(`kept ${argv[1]} — A Claude Code lock on the worktree names a process that is still running`);
    process.exit(1);
  }
  remove(argv[1]);
  log();
} else {
  log();
  console.error(`fake claude: unsupported call ${argv.join(" ")}`);
  process.exit(1);
}
