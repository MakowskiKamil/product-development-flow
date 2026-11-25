// Template rendering and card assembly (spec: Templates).
// A card is the session's whole brief in the spec's six sections: who you are, role
// brief, playbook, notes, the issue's plan entry (issue sessions only) and links.
// Cards are generated, never hand-edited: spawn writes the first one, and `flow plan`,
// `flow note` and `flow refresh` rebuild them from the current files.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./fail.mjs";
import { HYGIENE_ID, ISSUE_ROLES, RELEASE_VALUES, checkProjectOrHygiene, cleanTitle, pushPath } from "./ids.mjs";
import { EFFORTS, loadPlaybook, playbookDir } from "./playbook.mjs";
import { cardPath, isLive, listRecords } from "./records.mjs";
import { transact } from "./state.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "templates");
const EMPTY = "—";

// FLOW_ROLES points elsewhere in tests, as FLOW_PLAYBOOKS does for playbooks (d1).
export function rolesDir() {
  return process.env.FLOW_ROLES || path.join(ROOT, "roles");
}

// Replaces each {{key}} from a flat object in one pass, so a value that itself
// contains "{{…}}" (a title, a note, a role brief) is never scanned again. A key the
// object lacks is a bug in the caller: refuse. A key present with no value renders as "—".
export function render(template, values, source = "template") {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    if (!Object.hasOwn(values, key)) {
      fail(`${source}: placeholder {{${key}}} has no value`, `add "${key}" to the values flow passes to ${source}`);
    }
    const value = values[key];
    return value === null || value === undefined || value === "" ? EMPTY : String(value);
  });
}

function readTemplate(file) {
  return fs.readFileSync(path.join(TEMPLATES, file), "utf8");
}

export function renderTemplate(file, values) {
  return render(readTemplate(file), values, `templates/${file}`);
}

// build, review and qa get the issue prompt; initiative, project and hygiene the coordinator one.
export function systemPrompt(role, values) {
  const file = ISSUE_ROLES.includes(role) ? "system-prompt-issue.md" : "system-prompt-coordinator.md";
  return renderTemplate(file, values).trimEnd();
}

export function linearIssueUrl(config, issue) {
  return issue ? `${config.linearWorkspaceUrl.replace(/\/$/, "")}/issue/${issue}` : null;
}

// A file's text without trailing blank lines, or null when it does not exist (yet):
// roles/ and the playbook's .md files arrive with PRO-4, and a card must still build.
function readOptional(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8").trimEnd();
  return text === "" ? null : text;
}

// Each line indented by two spaces, so text under a bullet can never open a card section.
export function indent(text) {
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `  ${line}`))
    .join("\n");
}

// The spec link a project session writes into its notes: the first URL on the last
// line that mentions "spec" and has one. The last, because notes are appended: a
// later note (the accepted spec) replaces an earlier one (a draft).
export function specLink(notes) {
  let link = null;
  for (const line of String(notes ?? "").split("\n")) {
    if (!/\bspec\b/i.test(line)) continue; // the word, not "inspect" or "special"
    const url = line.match(/https?:\/\/[^\s)>\]]+/);
    if (url) link = url[0];
  }
  return link;
}

// The template without section 5: coordinators have no plan entry. Cut from the
// template (our own text), never from the rendered card, whose briefs and notes may
// hold any heading.
function withoutSection5(template) {
  const start = template.search(/^## 5\. /m);
  const end = template.search(/^## 6\. /m);
  if (start === -1 || end < start) fail("templates/card.md has no section 5 before section 6", "restore templates/card.md from git");
  return template.slice(0, start) + template.slice(end);
}

export function cardFromTemplate(template, values) {
  const text = ISSUE_ROLES.includes(values.role) ? template : withoutSection5(template);
  return render(text, values, "templates/card.md");
}

// A plan step as section 5 shows it: "opus, effort high", "skip", or null (—) when the
// entry is missing or a hand edit broke the step. A step may leave out model or effort
// (spawn then takes the playbook default), so the default fills the gap here too.
// The build and review briefs decide who merges from this line, so it shows only a
// model key of the playbook and a known effort: anything else (a typo, a newline from a
// hand edit) is —, which the briefs answer by asking the parent.
export function stepText(step, config, role) {
  if (step === "skip") return "skip";
  if (!step || typeof step !== "object" || Array.isArray(step)) return null;
  const [defaultModel, defaultEffort] = config.defaults?.[role] ?? [];
  const model = step.model ?? defaultModel;
  const effort = step.effort ?? defaultEffort;
  if (typeof model !== "string" || !Object.hasOwn(config.models ?? {}, model) || !EFFORTS.includes(effort)) return null;
  return `${model}, effort ${effort}`;
}

function planEntry(ctx, project, issue) {
  const file = `projects/${project}/plan.json`;
  if (!project || !issue || !ctx.exists(file)) return null;
  const plan = ctx.readJson(file);
  // plan.json is validated on flow plan, but a later hand edit may break its shape.
  return (Array.isArray(plan?.issues) ? plan.issues : []).find((entry) => entry?.id === issue) ?? null;
}

// The plan's release setting, shown on the project session's card only: it is the one
// that releases. A missing or unreadable plan, or a hand-edited value, shows —, which
// the project brief answers by asking the owner. Unreadable is caught here because a
// project card never read the plan before: a broken plan.json must not stop flow note
// or flow refresh from rebuilding it.
function releaseSetting(ctx, session) {
  const file = `projects/${session.project}/plan.json`;
  if (session.role !== "project" || !ctx.exists(file)) return null;
  let release;
  try {
    release = ctx.readJson(file)?.release;
  } catch {
    return null;
  }
  return RELEASE_VALUES.includes(release) ? release : null;
}

// The values of section 1 and the system prompts, from a record (or, at spawn, the
// record-to-be). config: the session's playbook config.
export function identityValues(ctx, session, config) {
  return {
    name: session.name,
    role: session.role,
    slug: session.slug,
    parentName: session.parentName ?? null,
    initiative: session.initiative ?? null,
    project: session.project ?? null,
    issue: session.issue ?? null,
    issueTitle: session.issueTitle ?? null,
    pushPath: pushPath({ initiative: session.initiative, project: session.project }),
    playbook: session.playbook,
    cardPath: ctx.path(cardPath(session.slug)),
    linearIssueUrl: linearIssueUrl(config, session.issue),
    model: session.model,
    effort: session.effort,
    worktree: session.worktree ?? session.slug,
  };
}

// The whole card for a session. session: a record, or at spawn the values the record
// will hold (identityValues keys plus pr).
export function assembleCard(ctx, session, config) {
  const values = identityValues(ctx, session, config);
  const isIssue = ISSUE_ROLES.includes(session.role);
  const notesFile = session.role === "initiative" ? `initiatives/${session.initiative}/notes.md` : `projects/${session.project}/notes.md`;
  const notes = readOptional(ctx.path(notesFile));
  // The spec link lives in the project's notes; an initiative has none.
  const projectNotes = session.project ? readOptional(ctx.path(`projects/${session.project}/notes.md`)) : null;
  const entry = isIssue ? planEntry(ctx, session.project, session.issue) : null;
  // A playbook in no searched directory renders section 3 as "—", as a missing file does.
  const playbookParent = playbookDir(session.playbook);
  const playbookFolder = playbookParent && path.join(playbookParent, session.playbook);
  const playbookParts = playbookFolder ? [readOptional(path.join(playbookFolder, "common.md")), readOptional(path.join(playbookFolder, `${session.role}.md`))].filter(Boolean) : [];

  Object.assign(values, {
    // The plan's current title, so a renamed issue shows here; the name keeps the title copied at spawn.
    issueTitle: entry && cleanTitle(entry.title) ? cleanTitle(entry.title) : values.issueTitle,
    roleBrief: readOptional(path.join(rolesDir(), `${session.role}.md`)),
    playbookText: playbookParts.length ? playbookParts.join("\n\n") : null,
    notesSource: session.role === "initiative" ? `initiative ${session.initiative}` : session.project === HYGIENE_ID ? "hygiene H" : `project ${session.project}`,
    notes,
    review: stepText(entry?.review, config, "review"),
    qa: stepText(entry?.qa, config, "qa"),
    merge: entry?.merge ?? null,
    waits: Array.isArray(entry?.waits) && entry.waits.length ? entry.waits.map((wait) => String(wait).replace(/\s+/g, " ").trim()).join("; ") : null,
    issueNotes: typeof entry?.notes === "string" && entry.notes.trim() ? indent(entry.notes.trimEnd()) : null,
    specLink: specLink(projectNotes),
    pr: session.pr ?? null,
    release: releaseSetting(ctx, session),
  });
  return cardFromTemplate(readTemplate("card.md"), values);
}

// Rebuilds the cards of the given records (archived ones are skipped) and returns the
// names of the sessions whose card changed: those are the ones to tell "Card updated".
export function rebuildCards(ctx, records) {
  const configs = new Map(); // playbook name → config, loaded once per command
  const changed = [];
  for (const record of records.filter(isLive)) {
    if (!configs.has(record.playbook)) configs.set(record.playbook, loadPlaybook(record.playbook));
    const card = assembleCard(ctx, record, configs.get(record.playbook));
    const file = cardPath(record.slug);
    const old = ctx.exists(file) ? fs.readFileSync(ctx.path(file), "utf8") : null;
    if (card === old) continue;
    ctx.writeText(file, card);
    changed.push(record.name);
  }
  return changed;
}

// The records a refresh target names: a slug, a project id or H, or all.
function refreshTargets(ctx, target) {
  const records = listRecords(ctx);
  if (target === "all") return records.filter(isLive);
  const bySlug = records.find((record) => record.slug === target);
  if (bySlug) {
    if (!isLive(bySlug)) fail(`session ${target} is archived; its card is not rebuilt`, "refresh a live session, a project or all");
    return [bySlug];
  }
  if (/^P-|^H$/.test(target)) {
    const project = checkProjectOrHygiene(target);
    if (!ctx.exists(`projects/${project}/project.json`)) fail(`project ${project} does not exist`, "flow refresh <slug|P-id|H|all>");
    return records.filter((record) => record.project === project && isLive(record));
  }
  fail(`refresh target ${JSON.stringify(target)} is not a session slug, a project id, H or all`, "flow refresh <slug|P-id|H|all>");
}

// flow refresh <slug|P-id|H|all>: rebuild cards from the current role briefs, playbook,
// notes and plan. Returns what to print.
export function refreshCards(target) {
  return transact(`flow refresh ${target}`, (ctx) => {
    const records = refreshTargets(ctx, target);
    const tell = rebuildCards(ctx, records);
    ctx.commit(`refresh ${target}: ${tell.length} card(s) changed`);
    return { target, rebuilt: records.length, tell };
  });
}
