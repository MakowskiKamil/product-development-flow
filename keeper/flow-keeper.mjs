#!/usr/bin/env node
// flow-keeper: keeps every Remote Control background session on this Mac alive until
// it is archived, and cleans up after the archived sessions flow started.
// Ported from an earlier hand-written keeper script (same rules), plus the spec's
// additions for sessions that have a flow record.
//
// WHY this exists: `claude --bg` sessions die on a reboot, and the background service
// retires any session that sits idle for 8 hours. Both show in the app as
// "Remote Control disconnected".
// - A pinned session is never retired. Pins live in ~/.claude/jobs/pins.json, the same
//   file Ctrl+T writes in the `claude agents` view.
// - Archiving in the app does not stop the local process. The session's transcript
//   records "...ended or archived from another device or app (code 4090)" instead.
//   Starting it again would unarchive it, so the latest Remote Control event in the
//   transcript decides: "/remote-control is active" means keep it, the 4090 notice
//   means the owner let it go.
//
// Each run (launchd: at login and every 5 minutes):
//   live session     -> pin it, and start it again (bare --resume) if its process is gone
//   archived session -> unpin it, and stop its process if it still runs
// Sessions with a flow record (sessions/<slug>/record.json in the state dir) also get:
//   - record `archived` counts as archived even without the 4090 notice (flow archive
//     leaves none); a 4090 notice sets the record to `archived`. `running` and `done`
//     are both live.
//   - cleanup once the process is gone: claude rm, the worktree-<slug> branch and the
//     merged lane branch deleted, `cleanedAt` set; or the reason logged and retried.
//     A lane branch not deleted yet is listed in the record's branchesLeft and
//     deleted by a later run once origin/<base> contains it and -d accepts it.
//   - an archived parent with open children is logged once as ORPHAN.
// Sessions without a record (started by hand) get the old rules only: never cleaned.
//
// --dry-run prints the decisions without acting (no claude stop/rm/resume, no pin or
// record writes, no git fetch). --install [--replace <label>] prints the LaunchAgent
// install commands (with --replace: the switch away from that older LaunchAgent);
// --plist prints the rendered LaunchAgent plist. Neither installs anything.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudeBin,
  findTranscript,
  guardJob,
  heldByService,
  listBackgroundSessions,
  listJobStates,
  pidRunning,
  readJobStateLoose,
  readPins,
  readRoster,
  remoteControlStatus,
  removeJob,
  runBackground,
  runClaude,
  updatePins,
} from "../lib/claudeJobs.mjs";
import { render } from "../lib/cards.mjs";
import { FlowError } from "../lib/fail.mjs";
import { loadPlaybook } from "../lib/playbook.mjs";
import { recordPath } from "../lib/records.mjs";
import { git, now, readJson, stateDir, transact } from "../lib/state.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "com.product-dev-flow.keeper";
const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
// launchd starts a run every 300 s (and skips a start while a run is still going). No
// new step starts after this budget; the slowest single step (a cleanup: fetch 30 s,
// claude rm retries about 95 s, a lock wait of 45 s) then still ends inside 300 s.
const RUN_BUDGET_MS = Number(process.env.FLOW_KEEPER_BUDGET_MS ?? 120_000);
const RUN_DEADLINE = Date.now() + RUN_BUDGET_MS;
// git status may refresh a worktree's index as a side effect; a dry run writes nothing.
process.env.GIT_OPTIONAL_LOCKS = "0";

function log(message) {
  console.log(`[${new Date().toISOString()}] ${DRY_RUN ? "(dry run) " : ""}${message}`);
}

function firstLine(text) {
  return String(text).trim().split("\n")[0];
}

// --- flow records ---------------------------------------------------------------

// Read without the lock: every record is written by temp file + rename, so a read
// never sees half a file. Writes go through setRecord (lock, write, commit).
function loadRecords() {
  const dir = stateDir();
  if (!fs.existsSync(path.join(dir, ".git"))) {
    log(`no flow state dir at ${dir}; only the old rules apply`);
    return [];
  }
  const sessions = path.join(dir, "sessions");
  if (!fs.existsSync(sessions)) return [];
  const records = [];
  for (const slug of fs.readdirSync(sessions).sort()) {
    const file = path.join(dir, recordPath(slug));
    if (!fs.existsSync(file)) continue;
    try {
      records.push(readJson(file));
    } catch (error) {
      log(`${slug}: record unreadable (${error.what ?? error.message}); skipped`);
    }
  }
  return records;
}

// The record as it is on disk now: flow archive may have changed it since the run began.
function freshRecord(slug) {
  try {
    return readJson(path.join(stateDir(), recordPath(slug)));
  } catch {
    return null;
  }
}

// Changes one record under the state lock. stillWanted(current) re-checks the record
// as it is now (another flow command may have changed it since it was read).
function setRecord(slug, changes, message, stillWanted) {
  if (DRY_RUN) return false;
  try {
    return transact(message, (ctx) => {
      const current = ctx.readJson(recordPath(slug));
      if (!stillWanted(current)) return false;
      ctx.writeJson(recordPath(slug), { ...current, ...changes });
      ctx.commit(message);
      return true;
    });
  } catch (error) {
    log(`${slug}: record not updated (${error instanceof FlowError ? error.what : error.message}); retried next run`);
    return false;
  }
}

const isArchived = (record) => record.status === "archived";

// --- keep-alive: the old keeper's rules, plus record status -----------------------

function decide(session, record, roster) {
  const state = readJobStateLoose(session.id);
  // Never had Remote Control: not ours to keep. flow starts every session with it.
  if (!record && !state?.bridgeSessionId) return null;
  const label = `${session.id} (${session.name})`;
  const transcript = findTranscript(state, session.sessionId);
  const transcriptStatus = transcript ? remoteControlStatus(transcript) : null;
  let status = transcriptStatus;
  let via = transcriptStatus === "archived" ? "4090" : null;
  if (record && isArchived(record)) {
    status = "archived";
    via = "record";
  }
  if (status === null) {
    log(`${label}: no Remote Control event in its transcript; left alone`);
    return null;
  }
  // A flow session always lives in its worktree; never resume it in the main checkout.
  const workdir = (record ? [state?.worktreePath] : [state?.worktreePath, state?.cwd]).find((dir) => dir && fs.existsSync(dir));
  const processRunning = pidRunning(session.pid);
  // An unreadable roster (null) counts as holding every session: no resume, no cleanup.
  const held = !processRunning && (roster === null || heldByService(roster, session.id));
  return { session, record, label, status, via, running: processRunning || held, held, workdir };
}

function updateAllPins(decisions, records) {
  const keep = new Set(decisions.filter((d) => d.status === "active").map((d) => d.session.id));
  const letGo = new Set(decisions.filter((d) => d.status === "archived").map((d) => d.session.id));
  // An archived record unpins its job even when claude agents no longer lists it,
  // unless that job id now belongs to a live session.
  for (const record of records) if (isArchived(record) && record.jobId && !keep.has(record.jobId)) letGo.add(record.jobId);
  const why = (id) => (decisions.find((d) => d.session.id === id)?.via === "4090" ? "archived in the app" : "record archived");
  const change = (pins) => [...pins.filter((id) => !letGo.has(id)), ...[...keep].filter((id) => !pins.includes(id))];

  try {
    const pins = readPins();
    for (const id of keep) if (!pins.includes(id)) log(`${id}: pinned`);
    for (const id of letGo) if (pins.includes(id)) log(`${id}: ${why(id)}, unpinned`);
    if (DRY_RUN) return;
    const result = updatePins(change);
    if (result.warning) log(`pins not written: ${result.warning}; pin changes wait for the next run`);
  } catch (error) {
    log(`pins not written: ${firstLine(error.message)}; pin changes wait for the next run`);
  }
}

// Safety net: if the CLI still made a copy, take the copy down at once. The copy has
// no worktree of its own (verified 2026-10-14), so removing it leaves the lane's files alone.
function removeCopy(decision, output) {
  const copy = output.match(/started a copy as ([0-9a-f]{8})/)?.[1];
  if (!copy) return;
  log(`${decision.label}: the CLI started a copy ${copy} instead; stopping and removing the copy`);
  runClaude(["stop", copy]);
  const removed = removeJob(copy);
  if (!removed.ok) log(`${decision.label}: ${firstLine(removed.message)}`);
}

function act(d) {
  if (d.status === "archived" && d.running) {
    log(`${d.label}: ${d.via === "4090" ? "archived in the app" : "record archived"}, stopping its process`);
    if (DRY_RUN) return;
    // Only the job that still holds this session (it may have moved, or been reused).
    const target = guardJob(d.session.id, d.session.sessionId);
    if (!target) return log(`${d.label}: job no longer holds session ${d.session.sessionId}; acted on nothing`);
    const stop = runClaude(["stop", target]);
    if (!stop.ok) log(`${d.label}: claude stop failed: ${firstLine(stop.output)}`);
  } else if (d.status === "active" && d.held) {
    // Still shutting down: resuming now would make a copy. Next run decides again.
    log(`${d.label}: down, but the background service still holds it; not started`);
  } else if (d.status === "active" && !d.running) {
    if (!d.workdir) return log(`${d.label}: down, but its worktree is gone; cannot start it`);
    if (d.record && isArchived(freshRecord(d.record.slug) ?? {})) return log(`${d.label}: record archived meanwhile; not started`);
    log(`${d.label}: down, starting it again`);
    if (DRY_RUN) return;
    // WHY no other flags: the session then wakes with its own saved options
    // (name, Remote Control, permission mode). Any flag starts a copy under a new id.
    const result = runBackground(["--bg", "--resume", d.session.sessionId], { cwd: d.workdir });
    if (result.status !== 0) log(`${d.label}: start failed: ${firstLine(result.output || result.error || `exit ${result.status}`)}`);
    removeCopy(d, result.output);
  }
}

// --- cleanup of archived records -------------------------------------------------

function branchExists(repo, branch) {
  return git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }) !== null;
}

function mergedInto(repo, branch, base) {
  return git(repo, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/remotes/origin/${base}`], { allowFail: true }) !== null;
}

// Why a branch is still on a record's branchesLeft list. The list stores the reason
// last logged, so a later run logs only when the reason changes.
const NOT_MERGED = "not merged";
const REFUSED = "git branch -d refused";

// Deletes each branch with `git branch -d`, and only when origin/<base> already has
// it. A branch not merged yet (the lane was archived before its PR merged) or one
// -d refuses stays, and is returned in `left` for followBranches on later runs.
function deleteBranches(slug, repo, branches, base) {
  const notes = [];
  const left = [];
  for (const branch of branches) {
    if (!branchExists(repo, branch)) continue;
    if (!mergedInto(repo, branch, base)) {
      notes.push(`branch ${branch} not merged into origin/${base}; left`);
      left.push({ branch, reason: NOT_MERGED });
      continue;
    }
    const deleted = git(repo, ["branch", "-d", branch], { allowFail: true }) !== null;
    notes.push(deleted ? `deleted branch ${branch}` : `git branch -d ${branch} refused; left`);
    if (!deleted) left.push({ branch, reason: REFUSED });
  }
  return { notes, left };
}

// branchesLeft goes into the record only when cleanup left a branch, so a record
// without one looks as it always did.
function markCleaned(record, summary, branchesLeft = []) {
  const wanted = (current) => isArchived(current) && !current.cleanedAt;
  const changes = branchesLeft.length > 0 ? { cleanedAt: now(), branchesLeft } : { cleanedAt: now() };
  if (DRY_RUN) return log(`${record.slug}: ${summary}; would set cleanedAt`);
  if (setRecord(record.slug, changes, `keeper: ${record.slug} cleaned`, wanted)) log(`${record.slug}: ${summary}; cleanedAt set`);
}

// Decided outside the state lock (fetch, status, rev-list can take seconds); the lock
// is taken only in markCleaned, to re-read and write the record.
function cleanup(record, sessions) {
  const slug = record.slug;
  let config;
  try {
    config = loadPlaybook(record.playbook);
  } catch (error) {
    return log(`${slug}: cleanup skipped: ${error instanceof FlowError ? error.what : error.message}`);
  }
  const base = config.baseBranch;
  if (!base) return log(`${slug}: cleanup skipped: playbook ${record.playbook} has no baseBranch`);
  const target = guardJob(record.jobId, record.sessionId);
  const jobState = target ? readJobStateLoose(target) : null;
  const worktreePath = jobState?.worktreePath ?? path.join(config.repo, ".claude", "worktrees", record.worktree);
  const worktreeBranch = jobState?.worktreeBranch ?? `worktree-${record.worktree}`;

  if (!fs.existsSync(worktreePath)) {
    // Nothing on disk to lose: the job (if one still holds the session) goes too.
    const missing = `worktree missing (${worktreePath})`;
    if (!target) return markCleaned(record, missing);
    if (DRY_RUN) return markCleaned(record, `${missing}; would claude rm ${target}`);
    const removed = removeJob(target);
    if (!removed.ok) return log(`${slug}: ${missing}; ${firstLine(removed.message)}; cleanup next run`);
    return markCleaned(record, `${missing}; claude rm ${target}`);
  }
  // A worktree another job works in (another session, a copy of this one, a session
  // started by hand inside it) is never ours to remove, even under our slug.
  const inside = (dir) => dir === worktreePath || dir?.startsWith(`${worktreePath}${path.sep}`);
  const user = listJobStates().states.find((state) => state.jobId !== target && (inside(state.worktreePath) || inside(state.cwd)));
  if (user) return log(`${slug}: worktree ${worktreePath} is used by job ${user.jobId}; left`);
  const runner = sessions.find((session) => session.id !== target && inside(session.cwd) && pidRunning(session.pid));
  if (runner) return log(`${slug}: worktree ${worktreePath} is used by running session ${runner.id}; left`);

  if (DRY_RUN) {
    log(`${slug}: would git fetch origin ${base} (skipped in a dry run; using the last fetched refs)`);
  } else if (git(worktreePath, ["fetch", "-q", "--no-write-fetch-head", "origin", base], { allowFail: true }) === null) {
    return log(`${slug}: git fetch origin ${base} failed; cleanup next run`);
  }
  // --untracked-files=all: a repo's status.showUntrackedFiles=no must not hide new files.
  const status = git(worktreePath, ["status", "--porcelain", "--untracked-files=all"], { allowFail: true });
  if (status === null) return log(`${slug}: git status failed in ${worktreePath}; cleanup next run`);
  if (status.trim() !== "") {
    const paths = status.trimEnd().split("\n").map((line) => line.slice(3));
    const shown = paths.length > 10 ? [...paths.slice(0, 10), `… ${paths.length - 10} more`] : paths;
    return log(`${slug}: uncommitted: ${shown.join(", ")}`);
  }
  const unpushed = git(worktreePath, ["rev-list", "HEAD", "--not", "--remotes"], { allowFail: true });
  if (unpushed === null) return log(`${slug}: git rev-list failed in ${worktreePath}; cleanup next run`);
  const count = unpushed.split("\n").filter(Boolean).length;
  if (count > 0) return log(`${slug}: unpushed: ${count} commits`);

  // The lane's branch: the record's, else whatever the worktree is on now (a lane
  // switches from worktree-<slug> to its Linear branch; `claude rm` keeps both branches
  // then: checked live 2026-10-26, Claude Code 2.1.310).
  const current = git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true })?.trim();
  const laneBranch = record.branch ?? (current && current !== worktreeBranch ? current : null);
  // The base branch is never deleted, whatever a record or a worktree says.
  const branches = [worktreeBranch, laneBranch].filter((branch, index, all) => branch && branch !== base && all.indexOf(branch) === index);

  if (DRY_RUN) {
    log(`${slug}: clean and pushed; would claude rm ${target ?? "(no job holds the session)"}, delete ${branches.join(" and ")} if merged into origin/${base}, set cleanedAt`);
    return;
  }
  const notes = [];
  if (target) {
    const removed = removeJob(target);
    if (!removed.ok) return log(`${slug}: ${firstLine(removed.message)}; cleanup next run`);
    notes.push(`claude rm ${target}`);
  } else {
    notes.push(`no job holds session ${record.sessionId}; claude rm skipped`);
  }
  if (fs.existsSync(worktreePath)) {
    // claude rm leaves a worktree it does not judge safe, or one it never knew.
    // It was clean a moment ago; git worktree remove refuses if that changed.
    if (git(config.repo, ["worktree", "remove", worktreePath], { allowFail: true }) === null) {
      return log(`${slug}: ${notes.join("; ")}; git worktree remove ${worktreePath} refused; cleanup next run`);
    }
    notes.push(`removed worktree ${worktreePath}`);
  }
  const { notes: branchNotes, left } = deleteBranches(slug, config.repo, branches, base);
  notes.push(...branchNotes);
  markCleaned(record, notes.join("; "), left);
}

// --- branches cleanup left -----------------------------------------------------------

// A lane archived before its PR merged (merge setting `owner`) is cleaned while its
// branch is not in origin/<base> yet; cleanup logs that once and lists the branch in
// the record's branchesLeft as {branch, reason}. Each later run checks the list: a
// branch origin/<base> now contains is deleted with `git branch -d`, a branch that is
// gone (deleted by hand) is dropped. A branch stays listed while it waits (not merged,
// or -d refuses it); its reason is logged only when it changes, so an abandoned PR
// does not repeat itself every 5 minutes.
function followBranches(records) {
  const fetched = new Map(); // one fetch per repo and base branch per run
  for (const record of records) {
    if (!isArchived(record) || !record.cleanedAt || !record.branchesLeft?.length) continue;
    if (!withinBudget()) break;
    try {
      followRecord(record, fetched);
    } catch (error) {
      log(`${record.slug}: branch check failed: ${firstLine(error.message)}`);
    }
  }
}

// One fetch of origin/<base> per repo per run: { error } is null when it worked, else
// git's first stderr line. The worktree is gone by now, so the fetch runs in the
// repo's main checkout. WHY --no-write-fetch-head: it then only updates
// refs/remotes/origin/<base>; FETCH_HEAD is what a `git pull` running in that
// checkout at the same moment merges, and must not change under it. A dry run uses
// the last fetched refs.
function fetchBase(repo, base, fetched) {
  const key = `${repo}\n${base}`;
  if (!fetched.has(key)) {
    let error = null;
    if (!DRY_RUN) {
      try {
        git(repo, ["fetch", "-q", "--no-write-fetch-head", "origin", base]);
      } catch (failure) {
        error = firstLine(String(failure.message).replace(/^git fetch .*? failed in .*?: /, ""));
      }
    }
    fetched.set(key, { key, error, logged: false });
  }
  return fetched.get(key);
}

// A failed fetch is logged when its reason differs from the one the record holds in
// branchesFetchError (so once, not every run while offline), and once per repo per
// run; a fetch that works again is logged the same way.
function noteFetch(record, fetch, repo, base) {
  const held = record.branchesFetchError ?? null;
  if (DRY_RUN || held === fetch.error) return null; // a dry run did not fetch
  if (!fetch.logged) {
    log(fetch.error
      ? `git fetch origin ${base} failed in ${repo}: ${fetch.error}; listed branches are checked once it works`
      : `git fetch origin ${base} works again in ${repo}; checking listed branches`);
    fetch.logged = true;
  }
  return { branchesFetchError: fetch.error };
}

function followRecord(record, fetched) {
  const slug = record.slug;
  let config;
  try {
    config = loadPlaybook(record.playbook);
  } catch (error) {
    return log(`${slug}: branch check skipped: ${error instanceof FlowError ? error.what : error.message}`);
  }
  const { repo, baseBranch: base } = config;
  if (!base) return log(`${slug}: branch check skipped: playbook ${record.playbook} has no baseBranch`);
  const fetch = fetchBase(repo, base, fetched);
  const fetchChange = noteFetch(record, fetch, repo, base);
  const unchanged = (current) => isArchived(current) && JSON.stringify(current.branchesLeft) === JSON.stringify(record.branchesLeft);
  if (fetch.error) {
    // Lists wait: nothing is checked on refs that may be stale.
    if (fetchChange) setRecord(slug, fetchChange, `keeper: ${slug} fetch failed`, unchanged);
    return;
  }

  const keep = [];
  const notes = [];
  // A reason is noted only when it differs from the one listed (logged earlier).
  const wait = (entry, reason, note) => {
    keep.push({ branch: entry.branch, reason });
    if (entry.reason !== reason) notes.push(note);
  };
  for (const entry of record.branchesLeft) {
    const branch = entry.branch;
    if (branch === base) {
      notes.push(`branch ${branch} is the base branch; dropped`); // never ours to delete
    } else if (!branchExists(repo, branch)) {
      notes.push(`branch ${branch} is gone; dropped`);
    } else if (!mergedInto(repo, branch, base)) {
      wait(entry, NOT_MERGED, `branch ${branch} not merged into origin/${base}; left`);
    } else if (DRY_RUN) {
      notes.push(`branch ${branch} merged into origin/${base}; would delete it`);
    } else if (git(repo, ["branch", "-d", branch], { allowFail: true }) !== null) {
      notes.push(`branch ${branch} merged into origin/${base}; deleted`);
    } else {
      // Merged, yet -d refuses: a worktree has it checked out, or it has no upstream
      // and the main checkout's HEAD is behind origin/<base>. Never forced with -D;
      // retried each run, logged once.
      wait(entry, REFUSED, `branch ${branch} merged into origin/${base}, but git branch -d refused (checked out somewhere, or the main checkout is behind); left, retried each run`);
    }
  }
  if (DRY_RUN) {
    if (notes.length > 0) log(`${slug}: ${notes.join("; ")}; would update branchesLeft`);
    return;
  }
  // Logged as done, before the record write: a branch deleted above is gone even if
  // the write fails (that run then logs "record not updated", the next one "is gone").
  if (notes.length > 0) log(`${slug}: ${notes.join("; ")}`);
  const listChanged = JSON.stringify(keep) !== JSON.stringify(record.branchesLeft);
  if (!listChanged && !fetchChange) return;
  const changes = { ...fetchChange, ...(listChanged ? { branchesLeft: keep } : {}) };
  setRecord(slug, changes, `keeper: ${slug} branches`, unchanged);
}

// --- orphans -----------------------------------------------------------------------

// No script can push to the owner's phone (checked 2026-10-26: PushNotification
// reaches the phone only from a session with Remote Control), so the alert is this
// log line, and flow tree shows ORPHAN (owner decision 2).
function alertOrphans(records) {
  for (const parent of records) {
    if (!isArchived(parent) || parent.orphanAlertedAt) continue;
    const children = records.filter((record) => record.parentSlug === parent.slug && !isArchived(record));
    if (children.length === 0 || !withinBudget()) continue;
    log(`ORPHAN ${parent.name}: ${children.map((child) => child.name).join(", ")}`);
    const wanted = (current) => isArchived(current) && !current.orphanAlertedAt;
    setRecord(parent.slug, { orphanAlertedAt: now() }, `keeper: orphan alert for ${parent.slug}`, wanted);
  }
}

// --- the run -----------------------------------------------------------------------

let budgetLogged = false;

// Checked before every step that can take seconds (record writes, stops, resumes, cleanups).
function withinBudget() {
  if (Date.now() < RUN_DEADLINE) return true;
  if (!budgetLogged) log(`run budget of ${Math.round(RUN_BUDGET_MS / 1000)} s used up; the rest waits for the next run`);
  budgetLogged = true;
  return false;
}

function readRosterOrNull() {
  try {
    return readRoster();
  } catch (error) {
    log(`${firstLine(error.message)}; no session is started or cleaned this run`);
    return null;
  }
}

function run() {
  const { sessions, malformed } = listBackgroundSessions();
  for (const id of malformed) log(`${id}: claude agents lists it without a session id; left alone`);
  const roster = readRosterOrNull();
  const recordOf = new Map(loadRecords().filter((record) => record.sessionId).map((record) => [record.sessionId, record]));
  const decisions = [];
  for (const session of sessions) {
    try {
      const decision = decide(session, recordOf.get(session.sessionId), roster);
      if (decision) decisions.push(decision);
    } catch (error) {
      log(`${session.id} (${session.name}): failed: ${firstLine(error.message)}; left alone`);
    }
  }

  // A 4090 notice archives the record first, so pins, cleanup and orphans see it.
  for (const d of decisions) {
    if (d.via !== "4090" || !d.record || !withinBudget()) continue;
    log(`${d.label}: archived in the app; record ${d.record.slug} set to archived`);
    setRecord(d.record.slug, { status: "archived" }, `keeper: ${d.record.slug} archived in the app (4090)`, (current) => !isArchived(current));
  }
  // Read the records again: a 4090 write, or flow archive meanwhile, archives a session.
  let records = DRY_RUN ? [...recordOf.values()] : loadRecords();
  for (const d of decisions) {
    if (!d.record) continue;
    const current = records.find((record) => record.slug === d.record.slug) ?? d.record;
    d.record = d.via === "4090" ? { ...current, status: "archived" } : current;
    if (isArchived(d.record) && d.status === "active") Object.assign(d, { status: "archived", via: "record" });
  }
  records = records.map((record) => decisions.find((d) => d.record?.slug === record.slug)?.record ?? record);

  updateAllPins(decisions, records);

  for (const d of decisions) {
    if (!withinBudget()) break;
    try {
      act(d);
    } catch (error) {
      log(`${d.label}: failed: ${firstLine(error.message)}`);
    }
  }

  // Without the roster no process can be called gone (logged in readRosterOrNull).
  for (const record of roster === null ? [] : records) {
    if (!isArchived(record) || record.cleanedAt) continue;
    if (!withinBudget()) break;
    const mine = sessions.filter((candidate) => candidate.sessionId === record.sessionId);
    if (mine.some((session) => pidRunning(session.pid) || heldByService(roster, session.id))) {
      // Stopped this run, or still shutting down: clean up once it is gone.
      log(`${record.slug}: archived, its process still runs; cleanup next run`);
      continue;
    }
    try {
      cleanup(record, sessions);
    } catch (error) {
      log(`${record.slug}: cleanup failed: ${firstLine(error.message)}`);
    }
  }
  // `records` was read before this run's cleanups, so a record cleaned just now is
  // followed from the next run on (its branches were checked a moment ago).
  followBranches(records);

  alertOrphans(DRY_RUN ? records : loadRecords());
}

// --- LaunchAgent -------------------------------------------------------------------

function onPath(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function absoluteBin(value, name) {
  const found = path.isAbsolute(value) ? value : onPath(value);
  if (!found) throw new FlowError(`${name} not found on PATH`, `run this from a terminal where \`${name}\` works`);
  return found;
}

const xmlEscape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The plist points launchd at this checkout's keeper. A session worktree is removed
// once its session is archived, so only the main checkout may be rendered in.
function refuseWorktreeCheckout() {
  const repo = fs.realpathSync(REPO);
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const at = repo.indexOf(marker);
  if (at === -1) return;
  const main = repo.slice(0, at);
  // The fix keeps --replace: without it the owner would get the plain install and leave
  // the old keeper running next to the new one.
  const old = ARGS.includes("--install") ? replacedLabel() : null;
  const flags = ARGS.includes("--install") ? `--install${old ? ` --replace ${old}` : ""}` : "--plist";
  throw new FlowError(
    `${repo} is a session worktree; a LaunchAgent rendered from it breaks when the worktree is removed`,
    `node ${quote(path.join(main, "keeper", "flow-keeper.mjs"))} ${flags}   (from the main checkout ${main})`,
  );
}

function plist() {
  refuseWorktreeCheckout();
  const values = {
    home: os.homedir(),
    repo: fs.realpathSync(REPO),
    // PATH's node first: process.execPath is Homebrew's versioned Cellar path, which
    // an upgrade deletes.
    node: onPath("node") ?? process.execPath,
    claude: absoluteBin(claudeBin(), "claude"),
    git: absoluteBin(process.env.FLOW_GIT || "git", "git"),
  };
  const escaped = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, xmlEscape(value)]));
  const template = fs.readFileSync(path.join(REPO, "keeper", `${LABEL}.plist.template`), "utf8");
  return render(template, escaped, `keeper/${LABEL}.plist.template`);
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// The label after --replace, or null without --replace. WHY so strict: the value is
// pasted unquoted into launchctl lines the owner runs, so only a plain launchd label
// gets through; a missing value, a flag or anything with a space, quote or slash is
// refused.
function replacedLabel() {
  const fix = "node keeper/flow-keeper.mjs --install --replace com.example.old";
  // WHY refuse `--replace=<label>` instead of ignoring it: ignored, it would print the
  // plain install, and the owner would end up with two keepers running.
  if (ARGS.some((arg) => arg.startsWith("--replace="))) throw new FlowError("--replace needs a label as the next argument, not after =", fix);
  const at = ARGS.indexOf("--replace");
  if (at === -1) return null;
  const value = ARGS[at + 1];
  if (value === undefined || value.startsWith("-")) throw new FlowError("--replace needs a label", fix);
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new FlowError(`--replace needs a label; ${JSON.stringify(value)} is not one`, fix);
  if (value === LABEL) throw new FlowError(`--replace needs the old label; ${LABEL} is the flow keeper's own`, fix);
  return value;
}

// Prints, never runs: launchd changes are the owner's to run, in their own terminal.
function install() {
  const old = replacedLabel();
  plist(); // fails here, not in the owner's terminal, when node, claude or git is missing
  const agents = path.join(os.homedir(), "Library", "LaunchAgents");
  const target = path.join(agents, `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  const self = path.join(fs.realpathSync(REPO), "keeper", "flow-keeper.mjs");
  const lines = [
    "Nothing was installed; run these yourself.",
    "",
    old
      ? `Switch from ${old} to the flow keeper (writes the plist, turns ${old} off for good, starts the flow keeper):`
      : "Install the flow keeper (writes the plist, starts it):",
    "",
    `${quote(onPath("node") ?? process.execPath)} ${quote(self)} --plist > ${quote(target)}`,
    // WHY disable as well as bootout: the old plist stays in LaunchAgents, and launchd
    // would load it again at the next login, next to the flow keeper.
    ...(old ? [`launchctl bootout ${domain}/${old}`, `launchctl disable ${domain}/${old}`] : []),
    `launchctl enable ${domain}/${LABEL}`,
    `launchctl bootstrap ${domain} ${quote(target)}`,
    "",
    "Check it ran (state, last exit code, log):",
    "",
    `launchctl print ${domain}/${LABEL}`,
    `tail -n 40 ${quote(path.join(os.homedir(), "Library", "Logs", "flow-keeper.log"))}`,
    "",
    old ? `Back to ${old}:` : "Turn the flow keeper off again:",
    "",
    `launchctl bootout ${domain}/${LABEL}`,
    // WHY disable: its plist stays in LaunchAgents, and launchd would load it again at
    // the next login.
    `launchctl disable ${domain}/${LABEL}`,
    ...(old ? [`launchctl enable ${domain}/${old}`, `launchctl bootstrap ${domain} ${quote(path.join(agents, `${old}.plist`))}`] : []),
  ];
  console.log(lines.join("\n"));
}

// --- entry ---------------------------------------------------------------------------

try {
  if (ARGS.includes("--plist")) process.stdout.write(plist());
  else if (ARGS.includes("--install")) install();
  else run();
} catch (error) {
  if (ARGS.includes("--plist") || ARGS.includes("--install")) {
    process.stderr.write(`flow-keeper: ${error instanceof FlowError ? `${error.what}\nfix: ${error.fix}` : error.message}\n`);
  } else {
    log(`keeper run failed: ${firstLine(error.message)}`);
  }
  process.exitCode = 1;
}
