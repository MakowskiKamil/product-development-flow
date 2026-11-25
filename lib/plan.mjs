// Plans and phases (spec: Project phases, Running state, Commands).
// plan.json says which issues a project runs, with which model and effort per step,
// and who merges. project.json's phase says whether issue sessions may start yet.
// Both change only through `flow plan`, `flow note` and `flow phase`, so every change
// is a commit.

import fs from "node:fs";
import path from "node:path";
import { rebuildCards } from "./cards.mjs";
import { fail } from "./fail.mjs";
import { HYGIENE_ID, ID_PATTERNS, ISSUE_ROLES, RELEASE_VALUES, checkProjectOrHygiene, cleanTitle, isId } from "./ids.mjs";
import { EFFORTS, loadPlaybook } from "./playbook.mjs";
import { isLive, listRecords } from "./records.mjs";
import { now, transact } from "./state.mjs";

export const PHASES = ["intake", "spec", "issues", "running", "closed"];
export const MERGE_VALUES = ["self", "owner"];
// Phases in which `flow plan` may store a plan (hygiene: always; its phase is fixed at running).
const PLAN_PHASES = ["issues", "running"];

// A note `flow note` appends (to a notes file, or to a plan entry's notes):
// "- <YYYY-MM-DD> <text>", with any further lines of the same note indented under it.
// formatNote writes this shape and appendedNotes (the d3 guard) reads it; change both
// together.
const NOTE_LINE = /^- \d{4}-\d{2}-\d{2} /;

// The note as appended. Blank lines are dropped: an empty line would end the note for
// appendedNotes, leaving the lines after it unguarded. Returns null for an empty text.
export function formatNote(date, text) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trimEnd())
    .filter((line) => line.trim() !== "");
  if (!lines.length) return null;
  const [first, ...rest] = lines;
  return [`- ${date} ${first.trim()}`, ...rest.map((line) => `  ${line}`)].join("\n");
}

// Today's date on this machine (FLOW_NOW pins it in tests).
function today() {
  const date = new Date(now());
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Text with the note appended on a line of its own.
function appendNote(text, note) {
  if (!text) return note;
  return text.endsWith("\n") ? `${text}${note}` : `${text}\n${note}`;
}

const show = (value) => (value === undefined ? "missing" : JSON.stringify(value));

// Every rule of the spec's plan validation. Returns a list of messages, each naming the
// issue and the field, the actual value and what is allowed. Empty list: valid.
// models: the keys of the project's playbook `models`.
export function validatePlan(plan, { project, models }) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return [`plan: ${show(plan)} is not a JSON object`];
  const errors = [];
  if (plan.project !== project) errors.push(`plan project: ${show(plan.project)} is not ${project}`);
  // Like merge, no default: the project session has to ask the owner before builds start.
  // Hygiene batches its fixes into releases the owner asks for, so it has no setting.
  if (project === HYGIENE_ID) {
    if (plan.release !== undefined) errors.push(`plan release: hygiene (H) has no release setting; remove "release"`);
  } else if (!RELEASE_VALUES.includes(plan.release)) {
    errors.push(`plan release: ${show(plan.release)} not in ${RELEASE_VALUES.join(", ")}`);
  }
  if (!Array.isArray(plan.issues)) return [...errors, `plan issues: ${show(plan.issues)} is not an array`];

  const seen = new Map(); // issue id → index of its first entry
  plan.issues.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`issues[${index}]: ${show(entry)} is not an object`);
      return;
    }
    // An entry is named by its id when the id is usable, else by its position.
    const validId = typeof entry.id === "string" && ID_PATTERNS.issue.test(entry.id);
    const who = validId ? entry.id : `issues[${index}]`;
    if (!validId) errors.push(`${who} id: ${show(entry.id)} does not match ${ID_PATTERNS.issue}`);
    else if (seen.has(entry.id)) errors.push(`${who} id: appears twice (issues[${seen.get(entry.id)}] and issues[${index}])`);
    else seen.set(entry.id, index);

    if (typeof entry.title !== "string" || cleanTitle(entry.title) === "") errors.push(`${who} title: ${show(entry.title)} is not a non-empty string`);

    for (const role of ISSUE_ROLES) {
      const step = entry[role];
      const isObject = step !== null && typeof step === "object" && !Array.isArray(step);
      if (!isObject) {
        if (role !== "build" && step === "skip") continue;
        errors.push(`${who} ${role}: ${show(step)} is not ${role === "build" ? "an object" : `an object or "skip"`}`);
        continue;
      }
      // model and effort may be left out: spawn then takes the playbook's default.
      if (step.model !== undefined && !(typeof step.model === "string" && Object.hasOwn(models, step.model))) {
        errors.push(`${who} ${role}.model: ${show(step.model)} not in ${Object.keys(models).join(", ")}`);
      }
      if (step.effort !== undefined && !EFFORTS.includes(step.effort)) {
        errors.push(`${who} ${role}.effort: ${show(step.effort)} not in ${EFFORTS.join(", ")}`);
      }
    }

    if (entry.notes !== undefined && typeof entry.notes !== "string") errors.push(`${who} notes: ${show(entry.notes)} is not a string`);
    if (entry.waits !== undefined && !(Array.isArray(entry.waits) && entry.waits.every((wait) => typeof wait === "string"))) {
      errors.push(`${who} waits: ${show(entry.waits)} is not an array of strings`);
    }
    // No default on purpose: the project session has to ask the owner for each issue.
    if (!MERGE_VALUES.includes(entry.merge)) errors.push(`${who} merge: ${show(entry.merge)} not in ${MERGE_VALUES.join(", ")}`);
  });
  return errors;
}

// The notes `flow note` appended to an entry: each "- <date> " line with the indented
// lines under it, as one block of text.
export function appendedNotes(notes) {
  const blocks = [];
  let current = null; // the block an indented line belongs to; null after any other line
  for (const line of String(notes ?? "").split("\n")) {
    if (NOTE_LINE.test(line)) blocks.push((current = [line]));
    else if (current && /^\s+\S/.test(line)) current.push(line);
    else current = null;
  }
  return blocks.map((lines) => lines.join("\n"));
}

// True when every line of block appears, whole and in order, as consecutive lines of
// notes. Whole lines, so an edited note ("… reader!") does not count as kept.
function containsLines(notes, block) {
  const lines = String(notes ?? "").split("\n");
  const wanted = block.split("\n");
  return lines.some((_, start) => wanted.every((line, offset) => lines[start + offset] === line));
}

function readMeta(ctx, project) {
  const file = `projects/${project}/project.json`;
  if (!ctx.exists(file)) fail(`project ${project} does not exist`, project === HYGIENE_ID ? "flow spawn hygiene" : `flow spawn project ${project} --name "<name>"`);
  const meta = ctx.readJson(file);
  // A hand edit can leave anything here; refuse it instead of acting on a guessed phase.
  if (meta === null || typeof meta !== "object" || !PHASES.includes(meta.phase)) {
    fail(`${project} has an unknown phase ${JSON.stringify(meta?.phase)} in project.json`, `set "phase" to one of ${PHASES.join(", ")} by hand, or restore project.json from the state dir's git history`);
  }
  return meta;
}

function readPlan(ctx, project) {
  const file = `projects/${project}/plan.json`;
  return ctx.exists(file) ? ctx.readJson(file) : { project, issues: [] };
}

// Non-archived build/review/qa sessions of a project.
function liveIssueSessions(ctx, project) {
  return listRecords(ctx).filter((record) => record.project === project && ISSUE_ROLES.includes(record.role) && isLive(record));
}

const describe = (record) => `"${record.name}" (${record.slug}, ${record.status})`;

function refuseInvalid(errors, fix) {
  fail(errors[0], fix, { detail: errors.slice(1).map((error) => `also: ${error}`) });
}

// flow plan <P-id|H> --file <path>: validate, guard, store. Returns what to print.
export function storePlan(projectArg, file) {
  const project = checkProjectOrHygiene(projectArg);
  const source = path.resolve(file);
  let text;
  try {
    text = fs.readFileSync(source, "utf8");
  } catch (error) {
    fail(`cannot read plan file ${source} (${error.code ?? error.message})`, `write the plan to a file and pass its path: flow plan ${project} --file <path>`);
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (error) {
    fail(`plan file ${source} is not valid JSON (${error.message})`, `fix the file, then run flow plan ${project} --file ${file} again`);
  }
  const again = `fix the plan file, then run flow plan ${project} --file ${file} again`;

  return transact(`flow plan ${project}`, (ctx) => {
    const meta = readMeta(ctx, project);
    if (project !== HYGIENE_ID && !PLAN_PHASES.includes(meta.phase)) {
      fail(`${project} is in phase ${meta.phase}; a plan is stored only in phases ${PLAN_PHASES.join(" and ")}`, meta.phase === "closed" ? "the project is closed; nothing to plan" : `move the project on first (flow phase ${project} ${PHASES[PHASES.indexOf(meta.phase) + 1]})`);
    }
    const { models } = loadPlaybook(meta.playbook);
    const errors = validatePlan(plan, { project, models });
    if (errors.length) refuseInvalid(errors, again);

    // Gate decision d3: a new plan must keep every note `flow note` appended to an issue
    // it keeps; otherwise a project session rewriting its plan silently loses a parent's note.
    const stored = readPlan(ctx, project);
    for (const old of Array.isArray(stored.issues) ? stored.issues : []) {
      const kept = plan.issues.find((entry) => entry?.id === old?.id);
      if (!kept) continue;
      const lost = appendedNotes(old.notes).filter((block) => !containsLines(kept.notes, block));
      if (lost.length) {
        fail(`${old.id} notes: the file drops ${lost.length} line(s) added by flow note: ${JSON.stringify(lost[0].split("\n")[0])}`, `copy the notes of ${old.id} from ${ctx.path(`projects/${project}/plan.json`)} into the file, then run flow plan ${project} --file ${file} again`, {
          detail: lost.map((block) => `dropped: ${block.split("\n")[0]}`),
        });
      }
    }

    // A live session must not lose its issue or its step from under it.
    const sessions = liveIssueSessions(ctx, project);
    const blocked = sessions.flatMap((record) => {
      const entry = plan.issues.find((item) => item.id === record.issue);
      if (!entry) return [`${describe(record)}: ${record.issue} removed from the plan`];
      if (entry[record.role] === "skip") return [`${describe(record)}: ${record.issue} ${record.role} set to "skip"`];
      return [];
    });
    if (blocked.length) {
      fail(`the plan drops work of ${blocked.length} non-archived session(s): ${blocked[0]}`, "archive those sessions first (flow archive <slug>), or keep their issue and step in the plan", {
        detail: blocked.map((line) => `session ${line}`),
      });
    }

    ctx.writeJson(`projects/${project}/plan.json`, plan);
    // Issue cards carry their plan entry and the project card its release setting; the
    // project session tells each other session whose card changed "Card updated: …".
    const tell = rebuildCards(ctx, projectRecords(ctx, project));
    // A release change decides whether production waits for the owner, so it is named in
    // the state dir's history and in the output, where a bare issue count would hide it.
    const releaseChange = stored.release !== plan.release ? `release ${stored.release ?? "none"} → ${plan.release ?? "none"}` : null;
    const committed = ctx.commit(`plan ${project}: ${plan.issues.length} issue(s)${releaseChange ? `, ${releaseChange}` : ""}`);
    return { project, issues: plan.issues.length, committed, tell, releaseChange };
  });
}

// Every record of a project or hygiene (archived ones are skipped by rebuildCards).
function projectRecords(ctx, project) {
  return listRecords(ctx).filter((record) => record.project === project);
}

// Those of the given projects (or H) whose plan has an entry for this issue.
function plansWithIssue(ctx, issue, projects) {
  return projects.filter((project) => {
    if (!ctx.exists(`projects/${project}/plan.json`)) return false;
    const plan = ctx.readJson(`projects/${project}/plan.json`);
    return (Array.isArray(plan?.issues) ? plan.issues : []).some((entry) => entry?.id === issue);
  });
}

// The one project (or H) whose plan has this issue; none or several is refused.
function onlyPlanWith(ctx, issue) {
  const matches = plansWithIssue(ctx, issue, ctx.list("projects"));
  if (matches.length === 0) fail(`${issue} is in no project's plan`, `add it to a plan first (flow plan <P-id|H> --file <path>)`);
  if (matches.length > 1) fail(`${issue} is in the plans of ${matches.join(" and ")}`, `pick one: flow note ${issue} --project ${matches[0]} --text "<note>"`);
  return matches[0];
}

// flow note <P-id|I-id|H|issue-id> --text <t> [--project <P-id|H>]: appends the note to
// the notes file, or for an issue to its plan entry's notes, then rebuilds the cards it
// affects. Returns what to print.
export function addNote(target, text, { project: projectOption } = {}) {
  const usage = "flow note <P-id|I-id|H|issue-id> --text <t> [--project <P-id|H>]";
  const note = formatNote(today(), text);
  if (note === null) fail(`note for ${target} has no text`, `flow note ${target} --text "<note>"`);
  // I-9 also matches the issue pattern; an initiative id wins, as in the spec's ids.
  const kind = target === HYGIENE_ID || isId("project", target) ? "project" : isId("initiative", target) ? "initiative" : isId("issue", target) ? "issue" : null;
  if (!kind) fail(`note target ${JSON.stringify(target ?? "")} is not a project id, an initiative id, H or an issue id`, `usage: ${usage}`);
  if (projectOption !== undefined && kind !== "issue") fail(`--project is only for an issue target, not ${target}`, `flow note ${target} --text "<note>"`);

  return transact(`flow note ${target}`, (ctx) => {
    let where;
    let records;
    if (kind === "issue") {
      // With --project only that plan is read: a broken plan elsewhere must not block this note.
      const project = projectOption === undefined ? onlyPlanWith(ctx, target) : checkProjectOrHygiene(projectOption);
      if (projectOption !== undefined && !plansWithIssue(ctx, target, [project]).length) {
        fail(`${target} is not in the plan of ${project}`, `check the id, or add ${target} to the plan first (flow plan ${project} --file <path>)`);
      }
      const file = `projects/${project}/plan.json`;
      const plan = ctx.readJson(file);
      const entry = plan.issues.find((item) => item?.id === target);
      entry.notes = appendNote(typeof entry.notes === "string" ? entry.notes : "", note);
      ctx.writeJson(file, plan);
      where = `the plan entry of ${target} in ${project}`;
      records = projectRecords(ctx, project).filter((record) => record.issue === target);
    } else {
      const folder = kind === "initiative" ? `initiatives/${target}` : `projects/${target}`;
      const meta = `${folder}/${kind}.json`;
      if (!ctx.exists(meta)) {
        fail(`${kind === "initiative" ? "initiative" : "project"} ${target} does not exist`, target === HYGIENE_ID ? "flow spawn hygiene" : `flow spawn ${kind} ${target} --name "<name>"`);
      }
      const file = `${folder}/notes.md`;
      const old = ctx.exists(file) ? fs.readFileSync(ctx.path(file), "utf8") : "";
      ctx.writeText(file, `${appendNote(old, note)}\n`);
      where = file;
      records = listRecords(ctx).filter((record) => (kind === "initiative" ? record.initiative === target : record.project === target));
    }
    const tell = rebuildCards(ctx, records);
    ctx.commit(`note ${target}: ${note.split("\n")[0].slice(0, 72)}`);
    return { target, where, tell };
  });
}

// flow phase <P-id> <phase>: one step forward only.
export function movePhase(projectArg, target) {
  if (projectArg === HYGIENE_ID) fail("hygiene (H) has no phases; its phase is always running", "nothing to do: hygiene issues go straight into its plan (flow plan H --file <path>)");
  const project = checkProjectOrHygiene(projectArg);
  return transact(`flow phase ${project}`, (ctx) => {
    const meta = readMeta(ctx, project);
    const current = meta.phase;
    const next = PHASES[PHASES.indexOf(current) + 1];
    if (target !== next) {
      fail(`${project} is in phase ${current}; ${JSON.stringify(target ?? "")} is not its next phase`, next ? `flow phase ${project} ${next}` : `${project} is closed, the last phase; nothing comes after it`);
    }
    if (next === "running") {
      // Gate decision d2: lanes start in running, so the plan must hold something to start.
      // The empty plan spawn stored is named as such first: it lacks everything, release too.
      const plan = readPlan(ctx, project);
      if (Array.isArray(plan?.issues) && plan.issues.length === 0) fail(`${project} has no issues in its plan; running needs at least one`, `flow plan ${project} --file <path>, then flow phase ${project} running`);
      const errors = validatePlan(plan, { project, models: loadPlaybook(meta.playbook).models });
      if (errors.length) refuseInvalid(errors, `fix the plan (flow plan ${project} --file <path>), then run flow phase ${project} running again`);
    }
    if (next === "closed") {
      const open = liveIssueSessions(ctx, project);
      if (open.length) {
        fail(`${project} still has ${open.length} non-archived issue session(s): ${describe(open[0])}`, "archive them first (flow archive <slug>), then run flow phase again", {
          detail: open.map((record) => `open: ${describe(record)}`),
        });
      }
    }
    ctx.writeJson(`projects/${project}/project.json`, { ...meta, phase: next });
    ctx.commit(`phase ${project}: ${current} → ${next}`);
    return { project, from: current, to: next };
  });
}
