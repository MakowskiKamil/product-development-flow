// flow tree: the state as text, initiative → project (phase) → sessions.
// Read only, under the state lock (see readLocked). Sessions sit under the Linear thing they work
// on: an initiative session under its initiative, a project or hygiene session and its
// issue sessions under their project. Archived sessions show only with --all.

import { HYGIENE_ID, ISSUE_ROLES } from "./ids.mjs";
import { isLive, listRecords } from "./records.mjs";
import { readLocked } from "./state.mjs";

const INDENT = "  ";

// Natural order, so I-10 comes after I-9.
function byId(a, b) {
  return a.localeCompare(b, "en", { numeric: true });
}

// A non-archived record whose parent record is archived or missing (spec: ORPHAN).
// Returns why, or null. Initiative and hygiene records have no parent.
export function orphanReason(record, bySlug) {
  if (!isLive(record) || !record.parentSlug) return null;
  const parent = bySlug.get(record.parentSlug);
  if (!parent) return `parent ${record.parentSlug} missing`;
  if (!isLive(parent)) return `parent "${parent.name}" archived`;
  return null;
}

// Coordinator first, then issue sessions by issue, role (build, review, qa), start time.
function sessionOrder(a, b) {
  const rank = (record) => (record.issue ? 1 : 0);
  return (
    rank(a) - rank(b) ||
    byId(a.issue ?? "", b.issue ?? "") ||
    ISSUE_ROLES.indexOf(a.role) - ISSUE_ROLES.indexOf(b.role) ||
    String(a.createdAt).localeCompare(String(b.createdAt)) ||
    a.slug.localeCompare(b.slug)
  );
}

function sessionLine(record, { bySlug, waits }) {
  const parts = [record.role, record.model, record.effort, record.status];
  if (record.pr !== null && record.pr !== undefined) parts.push(`PR #${record.pr}`);
  if (Array.isArray(waits) && waits.length) parts.push(`waits: ${waits.join(", ")}`); // plan validation is flow plan's
  const orphan = orphanReason(record, bySlug);
  if (orphan) parts.push(`ORPHAN (${orphan})`);
  return `${record.name} — ${parts.join(" · ")}`;
}

// Returns the tree as lines, read under the state lock (see readLocked).
export function treeLines({ all = false } = {}) {
  return readLocked("flow tree", (ctx) => buildLines(ctx, all));
}

function buildLines(ctx, all) {
  const records = listRecords(ctx);
  const bySlug = new Map(records.map((record) => [record.slug, record]));
  const shown = records.filter((record) => all || isLive(record));

  const initiatives = ctx
    .list("initiatives")
    .filter((id) => ctx.exists(`initiatives/${id}/initiative.json`))
    .map((id) => ctx.readJson(`initiatives/${id}/initiative.json`))
    .sort((a, b) => byId(a.id, b.id));
  const projects = ctx
    .list("projects")
    .filter((id) => ctx.exists(`projects/${id}/project.json`))
    .map((id) => ctx.readJson(`projects/${id}/project.json`))
    .sort((a, b) => byId(a.id, b.id));
  const plans = new Map(projects.map((project) => [project.id, ctx.exists(`projects/${project.id}/plan.json`) ? ctx.readJson(`projects/${project.id}/plan.json`) : { issues: [] }]));

  const placed = new Set();
  const lines = [];

  function sessions(filter, depth) {
    for (const record of shown.filter(filter).sort(sessionOrder)) {
      placed.add(record);
      const entry = record.issue ? (plans.get(record.project)?.issues ?? []).find((item) => item.id === record.issue) : null;
      lines.push(`${INDENT.repeat(depth)}${sessionLine(record, { bySlug, waits: entry?.waits })}`);
    }
  }

  function project(meta, depth) {
    const title = meta.id === HYGIENE_ID ? "H Hygiene" : `${meta.id} ${meta.name}`;
    lines.push(`${INDENT.repeat(depth)}${title} (${meta.phase ?? "no phase"})`);
    sessions((record) => record.role !== "initiative" && record.project === meta.id, depth + 1);
  }

  const initiativeIds = new Set(initiatives.map((meta) => meta.id));
  for (const meta of initiatives) {
    lines.push(`${meta.id} ${meta.name}`);
    sessions((record) => record.role === "initiative" && record.initiative === meta.id, 1);
    for (const child of projects.filter((item) => item.initiative === meta.id)) project(child, 1);
  }
  // Projects without an initiative (or whose initiative folder is gone), hygiene last.
  const loose = projects.filter((item) => !initiativeIds.has(item.initiative));
  for (const meta of loose.filter((item) => item.id !== HYGIENE_ID)) project(meta, 0);
  for (const meta of loose.filter((item) => item.id === HYGIENE_ID)) project(meta, 0);

  // Records whose initiative or project folder does not exist: never hidden.
  const rest = shown.filter((record) => !placed.has(record));
  if (rest.length) {
    lines.push("Sessions without an initiative or project folder");
    sessions((record) => rest.includes(record), 1);
  }

  if (!lines.length) lines.push("no initiatives, projects or sessions yet");
  const hidden = records.length - shown.length;
  if (hidden) lines.push("", `${hidden} archived session${hidden === 1 ? "" : "s"} not shown (flow tree --all)`);
  return lines;
}
