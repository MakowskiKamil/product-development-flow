// Ids, slugs, display names and push paths (spec: Identifiers and slugs, Naming).
// The display name is also the -n name, the --remote-control name and the
// SendMessage address, so it must be stable and contain no newlines.

import { fail } from "./fail.mjs";

export const ID_PATTERNS = {
  initiative: /^I-\d+$/,
  project: /^P-[A-Z]+-\d+$/,
  issue: /^[A-Z]+-\d+$/,
};
export const HYGIENE_ID = "H";
// Who says go for a project's release (owner, 2026-11-08): "self" means the project
// session releases once its issues are in; "owner" means it waits for "release approved".
// Either way a session runs the release, never the owner by hand. Read by plan
// validation and by the project card.
export const RELEASE_VALUES = ["self", "owner"];
export const ISSUE_ROLES = ["build", "review", "qa"];
export const COORDINATOR_ROLES = ["initiative", "project", "hygiene"];
const TITLE_MAX = 80;

const EXAMPLES = { initiative: "I-9", project: "P-ABC-25", issue: "ABC-309" };

export function isId(kind, value) {
  return typeof value === "string" && ID_PATTERNS[kind].test(value);
}

export function checkId(kind, value) {
  if (!isId(kind, value)) {
    fail(`${kind} id ${JSON.stringify(value ?? "")} does not match ${ID_PATTERNS[kind]}`, `use an id like ${EXAMPLES[kind]}`);
  }
  return value;
}

// A project id or H (hygiene), as taken by --project.
export function checkProjectOrHygiene(value) {
  if (value === HYGIENE_ID) return value;
  if (!isId("project", value)) {
    fail(`project ${JSON.stringify(value ?? "")} is neither a project id (${ID_PATTERNS.project}) nor H`, `use an id like ${EXAMPLES.project}, or H for hygiene`);
  }
  return value;
}

// Coordinator slugs: i-9, p-abc-25, hygiene. Issue slugs: abc-309-build.
export function coordinatorSlug(role, id) {
  return role === "hygiene" ? "hygiene" : id.toLowerCase();
}

export function issueSlug(issue, role) {
  return `${issue.toLowerCase()}-${role}`;
}

// Suffix n (2, 3, …) goes on both: slug "-2", name " 2". n null means no suffix.
export function withSuffix(slug, name, n) {
  return n ? { slug: `${slug}-${n}`, name: `${name} ${n}` } : { slug, name };
}

// Titles and names drop newlines and control characters and are capped, so a
// Linear title can never break a name, an address or a card line.
export function cleanTitle(text) {
  const cleaned = String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Count characters (code points), not UTF-16 units, so the cut never splits an emoji.
  const chars = Array.from(cleaned);
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join("").trimEnd() : cleaned;
}

export function initiativeName(id, name) {
  return `(I)·${name} ${id}`;
}

export function projectName(id, name, initiative) {
  return initiative ? `(P) ${initiative}·${name} ${id}` : `(P) ${name} ${id}`;
}

export function hygieneName() {
  return "(H)·Hygiene";
}

export function issueName({ initiative, project, issue, title, role }) {
  const prefix = project === HYGIENE_ID ? "H" : initiative ? `${initiative}·${project}` : project;
  const base = `${prefix}·${issue} ${title}`;
  return role === "build" ? base : `${base}·${role}`;
}

// The first part of every push text: I-9, I-9 › P-ABC-25 (or P-ABC-25), H.
export function pushPath({ initiative, project }) {
  if (project === HYGIENE_ID) return "H";
  if (project) return initiative ? `${initiative} › ${project}` : project;
  return initiative;
}
