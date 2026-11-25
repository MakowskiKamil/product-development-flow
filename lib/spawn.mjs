// flow spawn: validate → write card (and a new initiative/project/hygiene folder) →
// run `claude --bg` → parse its job id → read the session id → write the record →
// commit. Everything runs under the state lock, so two spawns never race for a slug.
// Any failure after claude started rolls back the job it may have started (see
// rollbackJob); the state dir itself is put back by transact().

import fs from "node:fs";
import path from "node:path";
import { assembleCard, identityValues, systemPrompt } from "./cards.mjs";
import {
  BACKGROUND_TIMEOUT_MS,
  JOB_STATE_DELAY_MS,
  JOB_STATE_TRIES,
  findSpawnedJobs,
  jobsNamed,
  parseBackgrounded,
  runBackground,
  stopAndRemove,
  waitForJobState,
} from "./claudeJobs.mjs";
import { FlowError, fail, testFault } from "./fail.mjs";
import {
  HYGIENE_ID,
  checkId,
  checkProjectOrHygiene,
  cleanTitle,
  coordinatorSlug,
  hygieneName,
  initiativeName,
  issueName,
  issueSlug,
  projectName,
  withSuffix,
} from "./ids.mjs";
import { PHASES } from "./plan.mjs";
import { checkEffort, checkPlaybookExists, loadPlaybook, resolveModel } from "./playbook.mjs";
import { cardPath, isLive, listRecords, liveCoordinator, newRecord, nextSuffix, recordPath, slugHeld } from "./records.mjs";
import { git, now, stateConfig, transact } from "./state.mjs";

// options: { kind: initiative|project|hygiene|issue, id, role, name, initiative,
//            project, playbook, model, effort, again }
export function spawn(options) {
  const target = options.kind === "issue" ? `${options.id} ${options.role}` : options.kind === "hygiene" ? "hygiene" : `${options.kind} ${options.id}`;
  return transact(`flow spawn ${target}`, (ctx) => {
    const records = listRecords(ctx);
    const session = options.kind === "issue" ? prepareIssue(ctx, records, options) : prepareCoordinator(ctx, records, options);
    finishPreparing(ctx, session, records, options);
    for (const [relative, content] of session.newFiles) {
      if (typeof content === "string") ctx.writeText(relative, content);
      else ctx.writeJson(relative, content);
    }
    ctx.writeText(cardPath(session.slug), assembleCard(ctx, session.cardSource, session.config));
    return start(ctx, session);
  });
}

function stored(ctx, relative) {
  return ctx.exists(relative) ? ctx.readJson(relative) : null;
}

// The stored initiative.json / project.json wins on a re-spawn; a flag that says
// something else is refused rather than silently ignored.
function checkSameAsStored(what, storedValue, flagValue, flag) {
  if (flagValue !== undefined && flagValue !== storedValue) {
    const fix = storedValue === null || storedValue === undefined ? `drop ${flag} (the stored ${what} is none)` : `drop ${flag}, or pass ${flag} ${JSON.stringify(storedValue)}`;
    fail(`${flag} ${JSON.stringify(flagValue)} differs from the stored ${what} ${JSON.stringify(storedValue)}`, fix);
  }
}

function defaultPlaybook() {
  const playbook = stateConfig().defaultPlaybook;
  if (!playbook) fail("no playbook given and the state dir has no defaultPlaybook", "pass --playbook <name>, or run flow init --playbook <name> on a fresh state dir");
  return playbook;
}

function prepareCoordinator(ctx, records, options) {
  const { kind } = options;
  const id = kind === "hygiene" ? HYGIENE_ID : checkId(kind, options.id);
  const folder = kind === "initiative" ? `initiatives/${id}` : `projects/${id}`;
  const metaFile = `${folder}/${kind === "initiative" ? "initiative" : "project"}.json`;
  const meta = stored(ctx, metaFile);
  const flagName = options.name === undefined ? undefined : cleanTitle(options.name);

  if (meta) {
    if (meta.phase === "closed") fail(`${kind} ${id} is closed`, "nothing starts in a closed project");
    if (kind !== "hygiene") checkSameAsStored(`${kind} name`, meta.name, flagName, "--name");
    checkSameAsStored("playbook", meta.playbook, options.playbook, "--playbook");
    if (kind === "project") checkSameAsStored("initiative", meta.initiative, options.initiative, "--initiative");
  } else if (kind !== "hygiene" && !flagName) {
    fail(`${kind} ${id} is new and has no --name`, `flow spawn ${kind} ${id} --name "<name>"`);
  }

  const live = liveCoordinator(records, kind, id);
  if (live) fail(`${kind} ${id} already has a session: "${live.name}" (${live.slug}, ${live.status})`, `use that session, or archive it first (flow archive ${live.slug})`);

  let initiative = null;
  if (kind === "initiative") initiative = id;
  if (kind === "project") {
    initiative = meta ? meta.initiative : (options.initiative ?? null);
    if (!meta && initiative !== null) {
      checkId("initiative", initiative);
      if (!ctx.exists(`initiatives/${initiative}/initiative.json`)) {
        fail(`initiative ${initiative} does not exist`, `flow spawn initiative ${initiative} --name "<name>"`);
      }
    }
  }
  const initiativeMeta = initiative && kind === "project" ? stored(ctx, `initiatives/${initiative}/initiative.json`) : null;
  const playbook = meta?.playbook ?? options.playbook ?? initiativeMeta?.playbook ?? defaultPlaybook();
  checkPlaybookExists(playbook);

  const name = meta?.name ?? flagName ?? "Hygiene";
  const baseSlug = coordinatorSlug(kind, id);
  const baseName = kind === "initiative" ? initiativeName(id, name) : kind === "project" ? projectName(id, name, initiative) : hygieneName();
  // A re-spawn takes the next suffix without --again: the folder is the coordinator's
  // identity, the record is one session of it.
  const named = withSuffix(baseSlug, baseName, nextSuffix(ctx, records, baseSlug));

  const parent = kind === "project" && initiative ? liveCoordinator(records, "initiative", initiative) : null;
  const project = kind === "initiative" ? null : id;

  const newFiles = [];
  if (!meta) {
    if (kind === "initiative") {
      newFiles.push([metaFile, { id, name, slug: baseSlug, playbook }]);
      newFiles.push([`${folder}/notes.md`, `# Notes: ${baseName}\n`]);
    } else {
      const phase = kind === "hygiene" ? "running" : "intake"; // hygiene has no phases
      newFiles.push([metaFile, { id, name, initiative, phase, playbook, slug: baseSlug }]);
      newFiles.push([`${folder}/notes.md`, `# Notes: ${baseName}\n`]);
      newFiles.push([`${folder}/plan.json`, { project: id, issues: [] }]);
    }
  }

  return {
    role: kind,
    ...named,
    playbook,
    parent,
    initiative,
    project,
    issue: null,
    issueTitle: null,
    planStep: null,
    newFiles,
  };
}

function prepareIssue(ctx, records, options) {
  const issue = checkId("issue", options.id);
  const project = checkProjectOrHygiene(options.project);
  const meta = stored(ctx, `projects/${project}/project.json`);
  if (!meta) {
    fail(`project ${project} does not exist`, project === HYGIENE_ID ? "flow spawn hygiene" : `flow spawn project ${project} --name "<name>"`);
  }
  // Issue sessions start only once the plan is written and the project is running
  // (hygiene is always running).
  if (meta.phase !== "running") {
    const next = PHASES.includes(meta.phase) ? PHASES[PHASES.indexOf(meta.phase) + 1] : "<phase>";
    fail(`${project} is in phase ${meta.phase}; issue sessions start only in phase running`, meta.phase === "closed" ? `${project} is closed; nothing starts in it` : `move the project on (flow phase ${project} ${next}) once its work in ${meta.phase} is done`);
  }
  const plan = stored(ctx, `projects/${project}/plan.json`) ?? { issues: [] };
  // plan.json is validated on flow plan, but a later hand edit may break its shape.
  const entry = (Array.isArray(plan.issues) ? plan.issues : []).find((item) => item?.id === issue);
  if (!entry) fail(`${issue} is not in the plan of ${project}`, `add ${issue} to the plan (flow plan ${project} --file <path>)`);
  const issueTitle = cleanTitle(entry.title);
  if (!issueTitle) fail(`${issue} has no title in the plan of ${project}`, `set its "title" in the plan (flow plan ${project} --file <path>)`);
  if (entry[options.role] === "skip") {
    fail(`${issue} ${options.role} is "skip" in the plan of ${project}`, `set ${issue}'s "${options.role}" to an object in the plan first (flow plan ${project} --file <path>)`);
  }

  const parentRole = project === HYGIENE_ID ? "hygiene" : "project";
  const parent = liveCoordinator(records, parentRole, project);
  if (!parent) {
    fail(`${project} has no running ${parentRole} session to be the parent of ${issue}`, project === HYGIENE_ID ? "flow spawn hygiene" : `flow spawn project ${project}`);
  }

  const role = options.role;
  const baseSlug = issueSlug(issue, role);
  const baseName = issueName({ initiative: meta.initiative, project, issue, title: issueTitle, role });
  let suffix = null;
  if (slugHeld(ctx, records, baseSlug)) {
    if (!options.again) {
      const holder = records.find((record) => record.slug === baseSlug);
      fail(`slug ${baseSlug} is held by ${holder ? `"${holder.name}" (${holder.status})` : `sessions/${baseSlug}`}`, `add --again to start another ${role} session for ${issue}`);
    }
    suffix = nextSuffix(ctx, records, baseSlug);
  }

  return {
    role,
    ...withSuffix(baseSlug, baseName, suffix),
    playbook: meta.playbook,
    parent,
    initiative: meta.initiative,
    project,
    issue,
    issueTitle,
    planStep: typeof entry[role] === "object" && entry[role] !== null ? entry[role] : null,
    newFiles: [],
  };
}

// Checks shared by every form, then the values the templates render from.
function finishPreparing(ctx, session, records, options) {
  const clash = records.find((record) => isLive(record) && record.name === session.name);
  if (clash) fail(`name "${session.name}" is held by session ${clash.slug} (${clash.status})`, `archive ${clash.slug} first (flow archive ${clash.slug}), or use --again on an issue session`);
  // A Claude Code job with the same name (started by hand, or not yet removed) would
  // share the SendMessage address; a name must lead to one session only.
  const [namedJob] = jobsNamed(session.name);
  if (namedJob) fail(`name "${session.name}" is already used by Claude Code job ${namedJob.jobId}`, `if that session is finished, claude stop ${namedJob.jobId} then claude rm ${namedJob.jobId}; otherwise use that session`);

  const config = loadPlaybook(session.playbook);
  const [defaultModel, defaultEffort] = config.defaults[session.role];
  // --model and --effort override independently: flag, then plan entry, then playbook default.
  session.modelId = resolveModel(config, options.model ?? session.planStep?.model ?? defaultModel);
  session.effort = checkEffort(options.effort ?? session.planStep?.effort ?? defaultEffort);
  session.config = config;
  session.worktreePath = path.join(config.repo, ".claude", "worktrees", session.slug);
  session.branch = `worktree-${session.slug}`;

  // claude -w puts worktrees under the repo's top level, so "repo" must be that top
  // level; a subdirectory would make every worktree check below look in the wrong place.
  const topLevel = git(config.repo, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (topLevel === null) {
    fail(`repo ${config.repo} of playbook ${config.name} is not a git repo`, `fix "repo" in playbook ${config.name}'s config.json`);
  }
  if (fs.realpathSync(topLevel.trim()) !== config.repo) {
    fail(`repo ${config.repo} of playbook ${config.name} is not the top of its git repo (${topLevel.trim()})`, `set "repo" to ${topLevel.trim()} in playbook ${config.name}'s config.json`);
  }
  const repo = shellQuote(config.repo);
  if (fs.existsSync(session.worktreePath)) {
    fail(`worktree ${session.worktreePath} already exists`, `remove it (git -C ${repo} worktree remove ${shellQuote(session.worktreePath)}) or pick another slug`);
  }
  if (git(config.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${session.branch}`], { allowFail: true }) !== null) {
    fail(`branch ${session.branch} already exists in ${config.repo}`, `delete it (git -C ${repo} branch -d ${session.branch}) or pick another slug`);
  }

  session.cardFile = ctx.path(cardPath(session.slug));
  // The fields the record will hold; the card is built from these, as on every rebuild.
  session.cardSource = {
    name: session.name,
    role: session.role,
    slug: session.slug,
    parentName: session.parent?.name ?? null,
    initiative: session.initiative,
    project: session.project,
    issue: session.issue,
    issueTitle: session.issueTitle,
    playbook: session.playbook,
    model: session.modelId,
    effort: session.effort,
    worktree: session.slug,
    pr: null,
  };
  session.values = identityValues(ctx, session.cardSource, config);
}

function start(ctx, session) {
  const { cardFile } = session;
  const args = [
    "--bg",
    "-w", session.slug,
    "-n", session.name,
    "--remote-control", session.name,
    "--permission-mode", session.config.permissionMode,
    "--model", session.modelId,
    "--effort", session.effort,
    "--append-system-prompt", systemPrompt(session.role, session.values),
    `Read your card at ${cardFile} and begin.`,
  ];

  const sinceMs = Date.now();
  const run = runBackground(args, { cwd: session.config.repo });
  let jobId = null;
  let printedId = null; // a printed id flow cannot use (unknown format): named, never acted on
  try {
    // Parse first, even when claude failed: a printed job id is what rollback needs most.
    let parsed;
    try {
      parsed = parseBackgrounded(run.output);
    } catch (error) {
      printedId = error.printedId ?? null;
      throw error;
    }
    jobId = parsed?.jobId ?? null;
    if (run.timedOut) throw new Error(`claude --bg did not return within ${BACKGROUND_TIMEOUT_MS / 1000} s`);
    if (run.status !== 0) throw new Error(`claude --bg exited ${run.status ?? `without a status (${run.error})`}`);
    if (!parsed) throw new Error(`claude --bg printed no "backgrounded · <jobId> · <name>" line`);
    const state = waitForJobState(jobId);
    if (!state) throw new Error(`job ${jobId} has no state.json after ${(JOB_STATE_TRIES * JOB_STATE_DELAY_MS) / 1000} s`);
    // The job's own state is checked, not the printed line: claude may shorten a long name
    // there. worktreePath may not be written yet (see readJobState); if it is, it must match.
    if (state.name !== session.name || (state.worktreePath !== undefined && state.worktreePath !== session.worktreePath)) {
      throw new Error(`job ${jobId} runs as "${state.name}" in ${state.worktreePath}, not as expected in ${session.worktreePath}`);
    }
    testFault("record");
    const record = newRecord({
      ...session,
      jobId,
      sessionId: state.sessionId,
      parentSlug: session.parent?.slug ?? null,
      parentName: session.parent?.name ?? null,
      model: session.modelId,
      createdAt: now(),
    });
    ctx.writeJson(recordPath(session.slug), record);
    ctx.commit(`spawn ${session.slug}: ${session.name}`);
    return { record, cardFile };
  } catch (error) {
    // "No job was started" can be known only when claude exited with an error code (or
    // never ran at all). After exit 0, a timeout or a signal, claude may have handed the
    // request on to the background service, which can still start the job.
    const claudeFailed = run.notStarted || (typeof run.status === "number" && run.status !== 0 && !run.timedOut);
    const rollback = rollbackJob(session, { sinceMs, jobId, printedId, claudeFailed });
    const fix = rollback.jobSettled
      ? rollback.leftovers
        ? "remove what is listed as left behind, then run the same command again"
        : "read the output above, then run the same command again"
      : "run the check and clean-up commands above before running the same command again";
    throw new FlowError(`${error.message} for "${session.name}"`, fix, {
      code: 2,
      detail: [
        "claude output:",
        ...(run.output.trim() ? run.output.trimEnd().split("\n").map((line) => `  ${line}`) : ["  (none)"]),
        ...rollback.lines,
      ],
    });
  }
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function branchExists(repo, branch) {
  return git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }) !== null;
}

// Undoes what claude may have started for this spawn. Two separate questions:
// 1. The job. Act only when exactly one job in the new worktree matches (the printed
//    job id or, with no id printed, this name) and nothing else is there: no other
//    job, no unreadable job state. Otherwise act on none.
// 2. The worktree and branch. Removed only after the matched job was stopped and
//    removed. "No job was started" is claimed only when nothing at all points to a
//    job: no printed id, no job, no worktree or branch, and claude exited with an error.
// Returns jobSettled (no job of ours can still be running), leftovers, and the lines to print.
function rollbackJob(session, { sinceMs, jobId, printedId, claudeFailed }) {
  const lines = [];
  const { repo } = session.config;
  let jobSettled = false;
  let removedJob = false;
  let suspects = [jobId, printedId].filter(Boolean); // job ids the clean-up lines name
  let unread = []; // jobs that could be ours but cannot be read: named, never given stop/rm lines
  try {
    const { matches, others, unreadable } = findSpawnedJobs({ name: session.name, worktreePath: session.worktreePath, sinceMs, jobId });
    unread = unreadable;
    const traces = fs.existsSync(session.worktreePath) || branchExists(repo, session.branch);
    const found = [...matches, ...others].map((job) => job.jobId);
    suspects = [...new Set([...suspects, ...found])];
    if (matches.length === 1 && others.length === 0 && unreadable.length === 0 && !printedId) {
      // followMoved: false: act on the matched job only, never on another job holding its session.
      const result = stopAndRemove(matches[0].jobId, matches[0].sessionId, { followMoved: false });
      if (result.ok) {
        jobSettled = removedJob = true;
        lines.push(`rollback: stopped and removed job ${result.jobId}`);
      } else {
        lines.push(`rollback: ${result.message}`);
      }
    } else if (found.length > 0 || unreadable.length > 0) {
      lines.push(`rollback: ${found.length} jobs in this worktree (${found.join(", ") || "none"})${unreadable.length ? `, and jobs started since this spawn began whose state cannot be read: ${unreadable.join(", ")}` : ""}; acted on none`);
    } else if (jobId || printedId || traces || !claudeFailed) {
      const why = jobId || printedId
        ? `claude printed job id ${jobId || printedId}`
        : traces
          ? "claude left a worktree or branch"
          : "claude did not exit with an error (exit 0, timeout or signal), so a job may still be starting";
      lines.push(`rollback: found no job in ${session.worktreePath}, but ${why}; acted on none`);
    } else {
      jobSettled = true;
      lines.push("rollback: no job was started");
    }
  } catch (error) {
    lines.push(`rollback: failed (${error.message}); acted on nothing further`);
  }

  const leftovers = [];
  if (removedJob) {
    if (fs.existsSync(session.worktreePath)) {
      const status = git(session.worktreePath, ["status", "--porcelain"], { allowFail: true });
      if (status === "" && git(repo, ["worktree", "remove", session.worktreePath], { allowFail: true }) !== null) {
        lines.push(`rollback: removed worktree ${session.worktreePath}`);
      } else {
        leftovers.push(`left behind: worktree ${session.worktreePath} (${status ? "has changes" : "could not be removed"}); check it, then git -C ${shellQuote(repo)} worktree remove ${shellQuote(session.worktreePath)}`);
      }
    }
    if (branchExists(repo, session.branch)) {
      if (git(repo, ["branch", "-d", session.branch], { allowFail: true }) !== null) lines.push(`rollback: deleted branch ${session.branch}`);
      else leftovers.push(`left behind: branch ${session.branch} (git branch -d refused); check it, then git -C ${shellQuote(repo)} branch -d ${session.branch}`);
    }
  }
  lines.push(...leftovers);

  if (!jobSettled) {
    const stopLines = suspects.length
      ? suspects.flatMap((id) => [`clean up, once the check shows it: claude stop ${id}`, `then: claude rm ${id}`])
      : ["clean up: run claude stop with the job id the check shows, then claude rm with the same id"];
    lines.push(
      `outcome unknown: job ${suspects.join(", ") || "(id unknown)"} ${JSON.stringify(session.name)} may be live`,
      `check: claude agents --json --all | grep -F ${shellQuote(session.name)}`,
      ...(unread.length ? [`could not read: ${unread.join(", ")} (one may be this spawn's job; stop one only if the check shows it under this name)`] : []),
      ...stopLines,
      `then, once every job above is removed, if the worktree is still there: git -C ${shellQuote(repo)} worktree remove ${shellQuote(session.worktreePath)}`,
    );
  }
  return { jobSettled, leftovers: leftovers.length > 0, lines };
}

