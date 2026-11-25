// The only place that reads Claude Code's internals: the `claude --bg` output line,
// `claude agents --json --all`, ~/.claude/jobs/<jobId>/state.json, jobs/pins.json,
// daemon/roster.json and session transcripts.
// WHY one place: these are not a public API and can change with any Claude Code
// update. Every reader checks the shape it relies on and fails loudly, so a change
// shows up as a clear error here instead of a wrong action somewhere else.
// FLOW_CLAUDE_HOME overrides ~/.claude and FLOW_CLAUDE the claude binary (tests).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envOverride } from "./fail.mjs";
import { sleepMs } from "./state.mjs";

export const BACKGROUND_TIMEOUT_MS = 30_000;
// Short on purpose: stop and rm run while a failed spawn still holds the state lock,
// and other flow commands wait at most 45 s for it.
const CLAUDE_TIMEOUT_MS = 15_000;
// `claude agents` asks the background service about every session: slower (the old keeper allowed 120 s).
const AGENTS_TIMEOUT_MS = 60_000;
// claude writes state.json shortly after it prints its line.
export const JOB_STATE_TRIES = 10;
export const JOB_STATE_DELAY_MS = 200;
// claude rm right after claude stop, while refused for the worktree lock: up to 6 tries, 1 s apart.
const RM_TRIES = 6;
const RM_DELAY_MS = 1_000;
// Clock slack when matching a job to the spawn that started it.
const CREATED_SLACK_MS = 2_000;
const JOB_ID = /^[0-9a-f]{8}$/;

export function claudeHome() {
  return envOverride("FLOW_CLAUDE_HOME") || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function claudeBin() {
  return envOverride("FLOW_CLAUDE") || "claude";
}

function jobsDir() {
  return path.join(claudeHome(), "jobs");
}

export class ClaudeShapeError extends Error {}

function shapeError(what) {
  return new ClaudeShapeError(`unexpected Claude Code data: ${what} (has Claude Code changed? check lib/claudeJobs.mjs)`);
}

// Runs a short claude command (stop, rm). Never throws for a non-zero exit;
// the caller decides what a failure means.
export function runClaude(args, { cwd, timeoutMs = CLAUDE_TIMEOUT_MS } = {}) {
  try {
    const output = execFileSync(claudeBin(), args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return { ok: true, status: 0, output };
  } catch (error) {
    const output = `${error.stdout || ""}${error.stderr || ""}` || error.message;
    return { ok: false, status: error.status ?? null, output };
  }
}

// Runs `claude --bg …`. Its output goes to a file flow opened, not to a pipe:
// the background job may inherit the child's stdout and keep it open, and a pipe
// would make flow wait for that job instead of for the claude command.
// Never throws once claude has run, so the caller always gets to roll back.
// status: exit code, or null when claude was killed (timeout, signal) or never ran;
// notStarted: the binary could not be started at all (so no job can exist).
export function runBackground(args, { cwd }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bg-"));
  const file = path.join(dir, "output");
  const fd = fs.openSync(file, "w");
  const result = { status: 0, timedOut: false, notStarted: false, output: "" };
  try {
    execFileSync(claudeBin(), args, { cwd, stdio: ["ignore", fd, fd], timeout: BACKGROUND_TIMEOUT_MS, killSignal: "SIGKILL" });
  } catch (error) {
    result.status = typeof error.status === "number" ? error.status : null;
    result.timedOut = error.code === "ETIMEDOUT";
    result.notStarted = error.code === "ENOENT" || error.code === "EACCES";
    if (result.status === null && !result.timedOut) result.error = error.message;
  }
  try {
    fs.closeSync(fd);
    result.output = fs.readFileSync(file, "utf8");
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    result.output ||= `(flow could not read claude's output: ${error.message})`;
  }
  return result;
}

// CSI sequences (colours) and OSC sequences (hyperlinks, titles).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// The line `backgrounded · <jobId> · <name>`. Returns null when it is missing.
export function parseBackgrounded(output) {
  const text = String(output).replace(ANSI, "");
  const match = text.match(/^\s*backgrounded · (\S+) · (.+?)\s*$/m);
  if (!match) return null;
  if (!JOB_ID.test(match[1])) {
    const error = shapeError(`job id ${JSON.stringify(match[1])} in "${match[0].trim()}"`);
    error.printedId = match[1]; // still a job claude says it started: rollback names it
    throw error;
  }
  return { jobId: match[1], name: match[2] };
}

// jobs/<jobId>/state.json parsed, or null when it does not exist. Throws on non-JSON.
function readRawJobState(jobId) {
  const file = path.join(jobsDir(), jobId, "state.json");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const state = JSON.parse(text);
    if (typeof state !== "object" || state === null) throw new Error("not an object");
    return state;
  } catch {
    throw shapeError(`${file} is not a JSON object`);
  }
}

// The state of a job flow started: must have the fields flow records. worktreePath is
// checked only when present: claude writes it seconds later, once the worktree is
// set up (seen live 2026-10-26: still missing 2.6 s after `claude --bg` returned).
export function readJobState(jobId) {
  const state = readRawJobState(jobId);
  if (state === null) return null;
  for (const key of ["sessionId", "name", "createdAt"]) {
    if (typeof state[key] !== "string") throw shapeError(`jobs/${jobId}/state.json has no string "${key}"`);
  }
  if (state.worktreePath !== undefined && typeof state.worktreePath !== "string") {
    throw shapeError(`jobs/${jobId}/state.json has a non-string "worktreePath"`);
  }
  return state;
}

// Waits for state.json, also while it is half written: JOB_STATE_TRIES × JOB_STATE_DELAY_MS.
export function waitForJobState(jobId) {
  let lastError = null;
  for (let attempt = 1; attempt <= JOB_STATE_TRIES; attempt += 1) {
    try {
      const state = readJobState(jobId);
      if (state) return state;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (attempt < JOB_STATE_TRIES) sleepMs(JOB_STATE_DELAY_MS);
  }
  if (lastError) throw lastError;
  return null;
}

const UNREADABLE_TRIES = 3;
const UNREADABLE_DELAY_MS = 100;

// Every job's parsed state, keyed by its directory name. `unreadable` lists jobs whose
// state.json is still not JSON after a few tries (a file being written usually parses
// a moment later), each with its folder's birth time (0 if the system has none), so a
// caller that must be sure can tell whether the job could be one it just started.
// Jobs without a field are not unreadable; they just match nothing.
export function listJobStates() {
  const states = [];
  const unreadable = [];
  const dir = jobsDir();
  if (!fs.existsSync(dir)) return { states, unreadable };
  for (const jobId of fs.readdirSync(dir)) {
    // Every job folder counts, even with an id format flow does not know: such a job
    // must still block a rollback (guardJob refuses to act on an unknown id format).
    if (!fs.existsSync(path.join(dir, jobId, "state.json"))) continue;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const state = readRawJobState(jobId);
        if (state) states.push({ ...state, jobId }); // the directory name wins over any field
        break;
      } catch {
        if (attempt < UNREADABLE_TRIES) {
          sleepMs(UNREADABLE_DELAY_MS);
          continue;
        }
        let birthtimeMs = 0;
        try {
          birthtimeMs = fs.statSync(path.join(dir, jobId)).birthtimeMs;
        } catch {
          // folder gone meanwhile: keep 0, which counts as "could be anyone's"
        }
        unreadable.push({ jobId, birthtimeMs });
        break;
      }
    }
  }
  return { states, unreadable };
}

// Jobs this spawn may have started. Candidates: every job in its worktree created
// after it began (with a little clock slack); the worktree did not exist before the
// spawn, so a job in another worktree never counts. Matches: candidates with a session
// id and the job id claude printed or, when none was printed, the session's name.
// `others`: every other job pointing at this worktree. `unreadable`: ids of jobs whose
// state cannot be read and whose folder was created after the spawn began (or has no
// birth time), so they could be this spawn's job; older unreadable jobs cannot be and
// are ignored. A caller that must be sure acts only when both are empty.
export function findSpawnedJobs({ name, worktreePath, sinceMs, jobId = null }) {
  const listed = listJobStates();
  const { states } = listed;
  const unreadable = listed.unreadable
    .filter((job) => !job.birthtimeMs || job.birthtimeMs >= sinceMs - CREATED_SLACK_MS)
    .map((job) => job.jobId);
  // A job that has not written its worktreePath yet (claude does that seconds later)
  // counts as being here if it was created since the spawn began, in this repo: it may
  // be this spawn's job, or a second one in this worktree.
  const repo = path.dirname(path.dirname(path.dirname(worktreePath))); // <repo>/.claude/worktrees/<slug>
  const fresh = (state) => Date.parse(state.createdAt) >= sinceMs - CREATED_SLACK_MS;
  const here = states.filter(
    (state) => state.worktreePath === worktreePath || (state.worktreePath === undefined && fresh(state) && (state.cwd === undefined || state.cwd === repo)),
  );
  const matches = here.filter(
    (state) =>
      fresh(state) &&
      typeof state.sessionId === "string" &&
      state.sessionId !== "" &&
      (jobId ? state.jobId === jobId : state.name === name),
  );
  // Any other job pointing at this worktree, whatever its age, cannot be ruled out.
  const others = here.filter((state) => !matches.includes(state));
  return { matches, others, unreadable };
}

// Jobs that already use this name (any state: claude rm removes a job's folder).
export function jobsNamed(name) {
  return listJobStates().states.filter((state) => state.name === name);
}

// The job id that holds sessionId right now: jobId itself if its state still holds
// that session, else whichever job does (the job moved), else null (act on nothing).
export function guardJob(jobId, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null; // nothing to check against
  try {
    if (JOB_ID.test(jobId) && readRawJobState(jobId)?.sessionId === sessionId) return jobId;
  } catch {
    // unreadable: fall through to the search
  }
  const found = listJobStates().states.filter((state) => state.sessionId === sessionId);
  // Only a folder name in the job-id format may reach claude stop/rm (never "--all").
  return found.length === 1 && JOB_ID.test(found[0].jobId) ? found[0].jobId : null;
}

// claude stop only (flow archive: removing the job is the keeper's cleanup), on the job
// that holds sessionId. gone: no job holds the session and the job's folder is gone
// (claude rm ran), so there is nothing to stop. A folder that is still there but does
// not hold the session (or cannot be read) is not "gone": flow cannot tell whether the
// session runs, so it acts on nothing and says so (ok: false, mismatch: true).
// unpinIds: the pins that belong to this session and may go: the job that holds it,
// and the recorded id once its folder is gone. Never a job that holds another session.
export function stopJob(jobId, sessionId) {
  const target = guardJob(jobId, sessionId);
  const recordedGone = !(JOB_ID.test(jobId) && fs.existsSync(path.join(jobsDir(), jobId)));
  if (!target) {
    if (!recordedGone) {
      return { ok: false, mismatch: true, unpinIds: [], message: `job ${jobId} does not hold session ${sessionId} (or its state.json cannot be read); acted on nothing` };
    }
    return { ok: true, gone: true, unpinIds: [jobId], message: `no job holds session ${sessionId} (job ${jobId} is gone); nothing to stop` };
  }
  const unpinIds = [...new Set([target, ...(recordedGone || target === jobId ? [jobId] : [])])];
  const stop = runClaude(["stop", target]);
  if (!stop.ok) return { ok: false, jobId: target, unpinIds, message: `claude stop ${target} failed: ${stop.output.trim() || "(no output)"}` };
  return { ok: true, jobId: target, unpinIds };
}

// claude stop, then claude rm, on the job that holds sessionId. Returns what it did.
// followMoved: false acts only on jobId itself (rollback: the job it matched, nothing else).
export function stopAndRemove(jobId, sessionId, { followMoved = true } = {}) {
  const target = guardJob(jobId, sessionId);
  if (!target || (!followMoved && target !== jobId)) {
    return { ok: false, message: `job ${jobId} no longer holds session ${sessionId}; acted on nothing` };
  }
  const stop = runClaude(["stop", target]);
  if (!stop.ok) return { ok: false, jobId: target, message: `claude stop ${target} failed: ${stop.output.trim()}` };
  return removeJob(target);
}

// claude rm on a job id the caller has already checked (guardJob). A stopped session's
// process takes a few seconds to exit and holds a lock on its worktree until then;
// `claude rm` refuses meanwhile (seen live 2026-10-26). Only that refusal is retried:
// any other failure (or a timeout) ends the attempt at once, so the state lock is not
// held longer than needed.
export function removeJob(jobId) {
  let rm;
  for (let attempt = 1; attempt <= RM_TRIES; attempt += 1) {
    rm = runClaude(["rm", jobId]);
    if (rm.ok) return { ok: true, jobId };
    const lockRefusal = rm.status !== null && /lock on the worktree|still running/i.test(rm.output);
    if (!lockRefusal) break;
    if (attempt < RM_TRIES) sleepMs(RM_DELAY_MS);
  }
  return { ok: false, jobId, message: `claude rm ${jobId} failed: ${rm.output.trim()}` };
}

// A job's state.json as it is, or null when it is missing or not JSON. For the keeper,
// which looks at every job on the machine, also ones flow did not start.
export function readJobStateLoose(jobId) {
  try {
    return readRawJobState(jobId);
  } catch {
    return null;
  }
}

// Pins: jobs/pins.json, a JSON array of job ids that the background service never
// retires (the same file Ctrl+T in `claude agents` writes).
export function pinsPath() {
  return path.join(jobsDir(), "pins.json");
}

export function readPins() {
  const file = pinsPath();
  if (!fs.existsSync(file)) return [];
  let pins;
  try {
    pins = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw shapeError(`${file} is not JSON`);
  }
  if (!Array.isArray(pins) || !pins.every((id) => typeof id === "string")) throw shapeError(`${file} is not an array of job ids`);
  return pins;
}

// Applies mutate(pins) → new pins. Never writes while the CLI holds pins.json.lock;
// writes a temp file and renames it; just before the rename it checks that nobody
// changed pins.json since it was read (retry once, then give up with a warning).
// The check and the rename are not atomic: a CLI write in that instant can still be
// lost. beforeRename is for tests: it simulates a concurrent writer.
export function updatePins(mutate, { beforeRename } = {}) {
  const file = pinsPath();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (fs.existsSync(`${file}.lock`)) return { written: false, warning: `${file}.lock exists (the CLI is writing pins); pins left unchanged` };
    const seen = snapshot(file);
    const before = readPins();
    const after = mutate([...before]);
    if (JSON.stringify(after) === JSON.stringify(before)) return { written: false };
    const temporary = `${file}.flow-${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(after, null, 2)}\n`);
    beforeRename?.(attempt);
    if (snapshot(file) !== seen || fs.existsSync(`${file}.lock`)) {
      fs.rmSync(temporary, { force: true });
      continue; // someone wrote in between: read again and redo the change
    }
    fs.renameSync(temporary, file);
    return { written: true };
  }
  return { written: false, warning: `${file} kept changing while flow wrote it; pins left unchanged` };
}

// mtime plus content: a write within the same clock tick still shows as a change.
function snapshot(file) {
  if (!fs.existsSync(file)) return "missing";
  return `${fs.statSync(file).mtimeMs}:${fs.readFileSync(file, "utf8")}`;
}

// daemon/roster.json: the workers the background service still holds, keyed by job id.
export function readRoster() {
  const file = path.join(claudeHome(), "daemon", "roster.json");
  if (!fs.existsSync(file)) return { supervisorPid: null, workers: {} };
  let roster;
  try {
    roster = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw shapeError(`${file} is not JSON`);
  }
  if (typeof roster?.workers !== "object" || roster.workers === null || Array.isArray(roster.workers)) {
    throw shapeError(`${file} has no "workers" object`);
  }
  return roster;
}

// The background service keeps a worker for every session it runs, also while a
// stopped session is still shutting down. Starting a session it still holds makes a
// copy under a new id. roster: what readRoster() returned.
export function heldByService(roster, jobId) {
  return pidRunning(roster.supervisorPid) && Object.hasOwn(roster.workers, jobId);
}

// Signal 0 only checks that the process exists. Any error counts as gone, as in the
// old keeper: every session runs as this user.
export function pidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Every background session `claude agents --json --all` knows, retired ones included
// (a retired or dead session has no running pid). Each has id, sessionId, name and,
// while it runs, pid. `malformed`: ids of entries without a session id (one still
// starting, or a changed format); the caller reports them and acts on the rest.
export function listBackgroundSessions() {
  const result = runClaude(["agents", "--json", "--all"], { timeoutMs: AGENTS_TIMEOUT_MS });
  if (!result.ok) throw new Error(`claude agents --json --all failed: ${result.output.trim().split("\n")[0]}`);
  let list;
  try {
    list = JSON.parse(result.output);
  } catch {
    throw shapeError("claude agents --json --all did not print JSON");
  }
  if (!Array.isArray(list)) throw shapeError("claude agents --json --all did not print an array");
  const background = list.filter((session) => session?.kind === "background" && typeof session.id === "string" && session.id !== "");
  const valid = (session) => typeof session.sessionId === "string" && session.sessionId !== "";
  return { sessions: background.filter(valid), malformed: background.filter((session) => !valid(session)).map((session) => session.id) };
}

// Transcripts: projects/<dir>/<sessionId>.jsonl, one JSON event per line.
export function findTranscript(state, sessionId) {
  if (state?.linkScanPath?.endsWith(`${sessionId}.jsonl`) && fs.existsSync(state.linkScanPath)) return state.linkScanPath;
  const projects = path.join(claudeHome(), "projects");
  if (!fs.existsSync(projects)) return null;
  for (const dir of fs.readdirSync(projects)) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const ACTIVE_MARKER = "/remote-control is active";
const ARCHIVED_MARKER = "ended or archived from another device or app (code 4090)";

// A marker counts only inside a system event, not when a message or tool output quotes it.
function isSystemEventAt(text, position) {
  const start = text.lastIndexOf("\n", position) + 1;
  const newline = text.indexOf("\n", position);
  const end = newline === -1 ? text.length : newline;
  try {
    return JSON.parse(text.slice(start, end)).type === "system";
  } catch {
    return false;
  }
}

function lastSystemMarker(text, marker) {
  let position = text.lastIndexOf(marker);
  while (position > 0 && !isSystemEventAt(text, position)) {
    position = text.lastIndexOf(marker, position - 1);
  }
  return position > 0 ? position : -1;
}

// The latest Remote Control event in a transcript: "active", "archived" (the 4090
// notice: the owner archived the session in the app), or null when it has neither.
export function remoteControlStatus(transcriptPath) {
  const text = fs.readFileSync(transcriptPath, "utf8");
  const active = lastSystemMarker(text, ACTIVE_MARKER);
  const archived = lastSystemMarker(text, ARCHIVED_MARKER);
  if (active === -1 && archived === -1) return null;
  return archived > active ? "archived" : "active";
}
