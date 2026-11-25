// The running state: a local git repo of JSON and Markdown files
// (default ~/.product-dev-flow/state, FLOW_STATE overrides it).
// Every write goes through transact(): take the lock, write, commit, release.
// WHY git: `git log` there is the history of every plan, note and phase change.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlowError, envOverride, fail, testFault } from "./fail.mjs";

// Gate decision d6: wait up to 45 s; a lock is stale only when older than 120 s
// AND its holder is dead (a slow command is not a crashed one).
export const LOCK_WAIT_MS = 45_000;
export const LOCK_STALE_MS = 120_000;
const LOCK_RETRY_MS = 50;
const GIT_TIMEOUT_MS = 30_000;

const GITIGNORE = [".lock", ".lock.*", "*.tmp", ""].join("\n");

// Always absolute: card paths built from it are read by sessions from their own worktree.
export function stateDir() {
  return path.resolve(envOverride("FLOW_STATE") || path.join(os.homedir(), ".product-dev-flow", "state"));
}

// Variables that point git at another repo or index. flow can run inside a git hook
// or a tool that sets them; inherited, they would make `git -C <dir>` act elsewhere.
const GIT_REPO_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX"];

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" };
  for (const key of GIT_REPO_VARS) delete env[key];
  return env;
}

// Timestamps written into files. FLOW_NOW pins them in tests; the lock uses the real clock.
export function now() {
  const date = process.env.FLOW_NOW ? new Date(process.env.FLOW_NOW) : new Date();
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function sleepMs(ms) {
  // A synchronous sleep: flow is a short-lived CLI and every step is synchronous.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// git with no prompts, no editor, no signing, no hooks and no fsmonitor: a command must
// never wait for a person or run someone's program. SIGKILL on timeout, so a hung git
// cannot keep the state lock forever. FLOW_GIT names the git binary: the keeper's
// LaunchAgent sets an absolute path, so a launchd PATH cannot pick another git.
export function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync(process.env.FLOW_GIT || "git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: gitEnv(),
    });
  } catch (error) {
    if (allowFail) return null;
    const stderr = String(error.stderr || "").trim();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || error.message}`);
  }
}

// Refuses an existing state dir. fix: the fix line, when the caller has a better one
// (flow init --repo: a second repo's playbook needs a copy, not a new state dir).
export function checkStateDirFree({ fix = "use it as it is, or move it away and run flow init again" } = {}) {
  const dir = stateDir();
  // lstat, not existsSync: a dangling symlink there is taken too, and mkdir would fail on it.
  if (fs.lstatSync(dir, { throwIfNoEntry: false })) fail(`state dir ${dir} already exists`, fix);
  return dir;
}

export function initState({ playbook } = {}) {
  const dir = checkStateDirFree();
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir); // not recursive: if the dir appeared meanwhile this throws, and we remove nothing
  try {
    git(dir, ["init", "-q", "-b", "main"]);
    // Local identity so commits work on a machine without a global git identity.
    git(dir, ["config", "user.name", "flow"]);
    git(dir, ["config", "user.email", "flow@localhost"]);
    fs.writeFileSync(path.join(dir, ".gitignore"), GITIGNORE);
    if (playbook) writeJsonAtomic(path.join(dir, "config.json"), { defaultPlaybook: playbook });
    git(dir, ["add", "-A"]);
    testFault("init");
    git(dir, ["commit", "-q", "-m", playbook ? `flow init --playbook ${playbook}` : "flow init"]);
  } catch (error) {
    // The dir did not exist before this command, so everything in it is ours to remove.
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

function writeJsonAtomic(file, value) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Temp file + rename: a reader never sees half a file.
function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists, owned by someone else
  }
}

function readLock(lockPath) {
  let text;
  let mtimeMs;
  try {
    text = fs.readFileSync(lockPath, "utf8");
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    return null; // released between our attempt and this read
  }
  try {
    const lock = JSON.parse(text);
    return { ...lock, text, startedMs: Date.parse(lock.startedAt) || mtimeMs };
  } catch {
    // A holder that died between creating and filling the file: no pid, age from mtime.
    return { pid: null, command: "unknown", startedAt: new Date(mtimeMs).toISOString(), text, startedMs: mtimeMs };
  }
}

// Takes <dir>/.lock or throws a refusal after waitMs. Returns a release function.
export function acquireLock(dir, { command, waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const lockPath = path.join(dir, ".lock");
  const content = JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() });
  const deadline = Date.now() + waitMs;
  let holder = null;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx"); // fails if the file exists: only one wins
      fs.writeSync(fd, content);
      fs.closeSync(fd);
      return () => releaseLock(lockPath, content);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    holder = readLock(lockPath) || holder;
    if (holder && Date.now() - holder.startedMs > staleMs && !pidAlive(holder.pid)) {
      takeOverStale(lockPath, holder);
      continue;
    }
    if (Date.now() >= deadline) {
      const who = holder ? `pid ${holder.pid} (${holder.command}, since ${holder.startedAt})` : "another flow command";
      fail(`state is locked by ${who}`, "retry the same command", {
        detail: ["side effects: none", `lock: ${lockPath}`],
      });
    }
    sleepMs(LOCK_RETRY_MS);
  }
}

// WHY rename and not unlink: two waiters may both judge the same lock stale. Rename
// moves it aside atomically, so only one of them gets it; the other gets ENOENT and
// goes back to the normal `wx` race. If what we moved is not the lock we judged
// (someone took over and locked again in between), we put it back.
function takeOverStale(lockPath, stale) {
  const aside = `${lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const moved = fs.readFileSync(aside, "utf8");
  if (moved === stale.text) {
    fs.unlinkSync(aside);
    process.stderr.write(`flow: removed stale lock of pid ${stale.pid} (${stale.command}, since ${stale.startedAt})\n`);
    return;
  }
  try {
    fs.linkSync(aside, lockPath); // put the live lock back; fails if a new one exists
  } catch {
    process.stderr.write(`flow: warning: moved a live lock aside and could not put it back (${aside})\n`);
  }
  fs.rmSync(aside, { force: true });
}

function releaseLock(lockPath, content) {
  try {
    if (fs.readFileSync(lockPath, "utf8") === content) fs.unlinkSync(lockPath);
  } catch {
    // already gone: nothing to release
  }
}

function hasChanges(dir) {
  return git(dir, ["status", "--porcelain"]).trim() !== "";
}

function commitAll(dir, message) {
  if (!hasChanges(dir)) return false; // a command that changes no file makes no commit
  git(dir, ["add", "-A"]);
  testFault("commit");
  git(dir, ["commit", "-q", "-m", message]);
  return true;
}

// Puts the state tree back to the commit the command started from: undoes every file
// it wrote or created, and a commit it made before failing. Ignored files (.lock,
// temp files) are left alone.
// Tried twice: a Ctrl-C also reaches the git child, and a second attempt usually lands.
function restore(dir, startCommit) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      git(dir, ["reset", "-q", "--hard", startCommit]);
      git(dir, ["clean", "-q", "-fd"]);
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

// Runs fn(ctx) under the lock. fn writes through ctx and calls ctx.commit(message).
// If fn throws, the state dir goes back to where it started before the lock is released.
export function transact(command, fn) {
  const dir = stateDir();
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fail(`state dir ${dir} is not set up`, "flow init");
  }
  const release = acquireLock(dir, { command });
  try {
    // A command that crashed without restoring leaves files behind; keep them in
    // history instead of losing them or mixing them into this command's commit.
    commitAll(dir, "recover: uncommitted changes");
    const startCommit = git(dir, ["rev-parse", "HEAD"]).trim();
    const ctx = makeContext(dir);
    try {
      return fn(ctx);
    } catch (error) {
      try {
        restore(dir, startCommit);
        if (error instanceof FlowError) error.detail.push(`state dir: back at its last commit (${startCommit.slice(0, 7)}); nothing from this command was kept`);
      } catch (restoreError) {
        const warning = `warning: could not restore the state dir ${dir}: ${restoreError.message}`;
        if (error instanceof FlowError) error.detail.push(warning);
        else process.stderr.write(`flow: ${warning}\n`);
      }
      throw error;
    }
  } finally {
    release();
  }
}

// Runs fn(ctx) under the lock for commands that only read (flow tree). WHY the lock:
// temp file + rename keeps each file whole, but a writer that fails puts the state dir
// back with git reset and clean, removing whole folders. A reader listing the dir at
// that moment saw sessions that were never kept, or a file gone between listing and
// reading it (ENOENT, PRO-8). The lock is held only for the reads, so writers wait
// milliseconds; nothing is committed or restored here.
export function readLocked(command, fn) {
  const dir = stateDir();
  if (!fs.existsSync(path.join(dir, ".git"))) fail(`state dir ${dir} is not set up`, "flow init");
  const release = acquireLock(dir, { command });
  try {
    const ctx = makeContext(dir);
    return fn({ ...ctx, writeJson: undefined, writeText: undefined, commit: undefined });
  } finally {
    release();
  }
}

function makeContext(dir) {
  const full = (relative) => path.join(dir, relative);
  return {
    path: full,
    exists: (relative) => fs.existsSync(full(relative)),
    readJson: (relative) => readJson(full(relative)),
    writeJson: (relative, value) => writeJsonAtomic(full(relative), value),
    writeText: (relative, text) => writeTextAtomic(full(relative), text),
    list: (relative) => (fs.existsSync(full(relative)) ? fs.readdirSync(full(relative)).sort() : []),
    commit: (message) => commitAll(dir, message),
  };
}

export function readJson(file) {
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${file} is not valid JSON (${error.message})`, `fix the file by hand, or restore it from the state dir's git history`);
  }
}

// The state dir's own config.json ({defaultPlaybook}), written by flow init --playbook.
export function stateConfig() {
  const file = path.join(stateDir(), "config.json");
  return fs.existsSync(file) ? readJson(file) : {};
}
