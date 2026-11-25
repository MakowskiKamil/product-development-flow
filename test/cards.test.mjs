import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cardFromTemplate, indent, render, specLink, stepText, systemPrompt } from "../lib/cards.mjs";
import { FlowError } from "../lib/fail.mjs";
import { ROOT, setup } from "./helpers.mjs";

const VALUES = {
  name: "I-9·P-APP-25·APP-309 Importer block",
  role: "build",
  slug: "app-309-build",
  parentName: "(P) I-9·Catalog import P-APP-25",
  initiative: "I-9",
  project: "P-APP-25",
  issue: "APP-309",
  issueTitle: "Importer block",
  pushPath: "I-9 › P-APP-25",
  playbook: "test",
  cardPath: "/state/sessions/app-309-build/card.md",
  linearIssueUrl: "https://linear.app/w/issue/APP-309",
  model: "claude-opus-5-5",
  effort: "high",
  worktree: "app-309-build",
};

// protects: a placeholder with no key in the values is refused, naming the key
// fails_when: a missing key renders as empty text or as "—"
// no_claim: the full card (cardFromTemplate tests below)
test("render refuses a placeholder whose key is missing", () => {
  assert.throws(
    () => render("a {{name}} b {{nope}}", { name: "x" }, "templates/t.md"),
    (error) => error instanceof FlowError && error.code === 1 && error.what.includes("{{nope}}") && error.what.includes("templates/t.md"),
  );
});

// protects: a key present with no value (no initiative, no issue) renders as "—"
// fails_when: null, undefined or "" renders as "null", "undefined" or nothing
// no_claim: how a card reads with many "—" lines
test("render shows — for empty values", () => {
  assert.equal(render("{{a}}|{{b}}|{{c}}|{{d}}", { a: null, b: undefined, c: "", d: 0 }), "—|—|—|0");
});

// protects: rendering is one pass: a value containing {{…}} is never expanded
// fails_when: a title like "{{name}}" gets replaced, or a missing key inside a value fails the render
// no_claim: escaping of Markdown in values
test("render is a single pass", () => {
  assert.equal(render("{{title}} / {{name}}", { title: "{{name}} {{missing}}", name: "N" }), "{{name}} {{missing}} / N");
});

// protects: the issue system prompt is the spec's three items, rendered with the session's values
// fails_when: a line differs from the spec template, or a placeholder is left unrendered
// no_claim: that a session obeys it (live smoke)
test("issue system prompt renders the spec text", () => {
  const prompt = systemPrompt("review", { ...VALUES, role: "review" });
  assert.equal(
    prompt,
    [
      "1. You are `I-9·P-APP-25·APP-309 Importer block`, role `review`, working on `APP-309 Importer block` in `I-9 › P-APP-25`. Your parent is `(P) I-9·Catalog import P-APP-25`.",
      "2. Read your card at `/state/sessions/app-309-build/card.md` before anything else; re-read it after a compaction and whenever a message starts `Card updated:`.",
      "3. Every question, block or result goes to your parent by `SendMessage` to `(P) I-9·Catalog import P-APP-25`, first line `[ASK|BLOCKED|DONE|FYI] I-9·P-APP-25·APP-309 Importer block: <one line>`. Never ask the owner directly.",
    ].join("\n"),
  );
});

// protects: initiative, project and hygiene get the coordinator prompt with their push path
// fails_when: a coordinator gets the issue prompt, or "—" is missing for an absent project
// no_claim: that push notifications reach the owner
test("coordinator system prompt renders the spec text", () => {
  const prompt = systemPrompt("initiative", { ...VALUES, role: "initiative", name: "(I)·Fees I-9", project: null, pushPath: "I-9" });
  assert.match(prompt, /^1\. You are `\(I\)·Fees I-9`, role `initiative`, for `I-9 › —`\.$/m);
  assert.match(prompt, /^3\. Ask the owner in your own conversation, and send a push notification `I-9: <one line>` with every question\./m);
  assert.match(prompt, /^4\. Answer a child by `SendMessage` to its name\./m);
  assert.doesNotMatch(prompt, /\{\{/);
});

// The card's section headings ("## 1." …), in the order they appear.
function sections(card) {
  return card.match(/^## \d\./gm).map((heading) => Number(heading.slice(3, 4)));
}

function readCard(ctx, slug) {
  return fs.readFileSync(path.join(ctx.state, "sessions", slug, "card.md"), "utf8");
}

// The text of one section, from its heading to the next "## n." heading.
function section(card, n) {
  const start = card.search(new RegExp(`^## ${n}\\. `, "m"));
  const rest = card.slice(start + 1);
  const end = rest.search(/^## \d\. /m);
  return end === -1 ? card.slice(start) : card.slice(start, start + 1 + end);
}

const CARD_TEMPLATE = fs.readFileSync(path.join(ROOT, "templates", "card.md"), "utf8");
const CARD_VALUES = {
  ...VALUES,
  roleBrief: "brief",
  playbookText: "playbook",
  notesSource: "project P-APP-25",
  notes: "notes",
  review: "opus, effort high",
  qa: "skip",
  merge: "self",
  waits: "APP-306 merged",
  issueNotes: "  Port 3105.",
  specLink: null,
  pr: null,
  release: null,
};

// protects: a card template placeholder with no value exits 1 naming the placeholder and templates/card.md; every placeholder of the real template has a value
// fails_when: a card is written with an unresolved {{…}}, or the error does not say which one
// no_claim: placeholders in role briefs or notes (values are inserted, never expanded)
test("card with an unresolved placeholder is refused, naming it", () => {
  assert.doesNotMatch(cardFromTemplate(CARD_TEMPLATE, CARD_VALUES), /\{\{/);
  assert.throws(
    () => cardFromTemplate(`${CARD_TEMPLATE}\n- Extra: {{nope}}\n`, CARD_VALUES),
    (error) => error instanceof FlowError && error.code === 1 && error.what === "templates/card.md: placeholder {{nope}} has no value",
  );
});

// protects: an issue card has all six sections in the spec's order; a coordinator card has 1, 2, 3, 4, 6 (no section 5), even when values hold headings
// fails_when: a section is missing, out of order, or a coordinator card shows a plan entry section
// no_claim: the content of each section (spawn card test below)
test("card sections follow the spec's order; coordinators have no section 5", () => {
  const values = { ...CARD_VALUES, roleBrief: "## 5. Not a section\n### Rules" };
  // The brief's own "## 5." is the brief's text, inside section 2.
  assert.deepEqual(sections(cardFromTemplate(CARD_TEMPLATE, values)), [1, 2, 5, 3, 4, 5, 6]);
  const issue = cardFromTemplate(CARD_TEMPLATE, CARD_VALUES);
  assert.deepEqual(sections(issue), [1, 2, 3, 4, 5, 6]);
  for (const role of ["initiative", "project", "hygiene"]) {
    assert.deepEqual(sections(cardFromTemplate(CARD_TEMPLATE, { ...CARD_VALUES, role })), [1, 2, 3, 4, 6], role);
  }
  // Section 5 is cut from the template, not the rendered card: a brief's "## 5." stays.
  const coordinator = cardFromTemplate(CARD_TEMPLATE, { ...values, role: "project" });
  assert.match(coordinator, /^## 5\. Not a section$/m);
  assert.doesNotMatch(coordinator, /Issue notes, waits and merge setting/);
});

// protects: indent puts every non-empty line two spaces in, so text under a bullet can never open a card section; specLink takes the URL of the last line that mentions the word spec (a later note replaces a draft)
// fails_when: a note line starting "## " lands at column 0, the spec link comes from a line without the word "spec", or an earlier draft link wins
// no_claim: Markdown rendering of the indented block
test("indent and specLink", () => {
  assert.equal(indent("a\n## b\n\n  c"), "  a\n  ## b\n\n    c");
  assert.equal(
    specLink("# Notes\n- 2026-10-25 spec draft https://x.test/draft\n- 2026-10-26 Spec: [Spec](<https://linear.app/w/document/spec-1>) accepted\n- 2026-10-26 see https://x.test/other\n- 2026-10-26 inspect https://x.test/special\n- 2026-10-26 spec review today"),
    "https://linear.app/w/document/spec-1",
  );
  assert.equal(specLink("no link here\nspec without url"), null);
});

const PLAN = {
  project: "P-APP-25",
  release: "owner",
  issues: [
    {
      id: "APP-309",
      title: "Importer block",
      notes: "Port 3105.\n## Owns src/importer.js",
      waits: ["APP-306 merged", "owner go"],
      build: { model: "opus", effort: "medium" },
      review: "skip",
      qa: "skip",
      merge: "owner",
    },
  ],
};

// A running project P-APP-25 with the plan above, a role brief and playbook files.
function runningProject(ctx) {
  ctx.init();
  fs.writeFileSync(path.join(ctx.roles, "build.md"), "BUILD BRIEF {{name}}\n");
  fs.writeFileSync(path.join(ctx.roles, "project.md"), "PROJECT BRIEF\n");
  fs.writeFileSync(path.join(ctx.playbooks, "test", "common.md"), "COMMON PLAYBOOK\n");
  fs.writeFileSync(path.join(ctx.playbooks, "test", "build.md"), "BUILD PLAYBOOK\n");
  // The fixture playbook ships a project.md; this scenario has none (section 3 = common.md only).
  fs.rmSync(path.join(ctx.playbooks, "test", "project.md"));
  assert.equal(ctx.run(["spawn", "project", "P-APP-25", "--name", "Catalog import"]).status, 0);
  for (const phase of ["spec", "issues"]) assert.equal(ctx.run(["phase", "P-APP-25", phase]).status, 0);
  const file = path.join(ctx.root, "plan.json");
  fs.writeFileSync(file, JSON.stringify(PLAN));
  assert.equal(ctx.run(["plan", "P-APP-25", "--file", file]).status, 0);
  assert.equal(ctx.run(["phase", "P-APP-25", "running"]).status, 0);
}

// protects: a spawned issue card holds, in order: who it is, its role brief, the playbook (common + role), the project notes, its plan notes (indented), waits and merge setting, and links with the Linear issue URL and the spec link from the project notes
// fails_when: a section is missing or out of order, a plan field is absent, a note line can open a section, or a {{…}} in a brief is expanded
// no_claim: that a session reads the card (live smoke); briefs' real content (PRO-4)
test("spawned issue card carries brief, playbook, notes, plan entry and links", (t) => {
  const ctx = setup(t);
  runningProject(ctx);
  assert.equal(ctx.run(["note", "P-APP-25", "--text", "Spec: https://linear.app/example-workspace/document/spec-1"]).status, 0);
  const spawned = ctx.run(["spawn", "APP-309", "build", "--project", "P-APP-25"]);
  assert.equal(spawned.status, 0, spawned.stderr);

  const card = readCard(ctx, "app-309-build");
  assert.deepEqual(sections(card), [1, 2, 3, 4, 5, 6]);
  assert.match(section(card, 1), /^- Name \(also your `SendMessage` address\): `P-APP-25·APP-309 Importer block`$/m);
  assert.match(section(card, 1), /^- Model: claude-opus-5-5, effort medium$/m);
  assert.match(section(card, 2), /^BUILD BRIEF \{\{name\}\}$/m);
  assert.match(section(card, 3), /^COMMON PLAYBOOK\n\nBUILD PLAYBOOK$/m);
  assert.match(section(card, 4), /^## 4\. Notes \(project P-APP-25\)$/m);
  assert.match(section(card, 4), /^- 2026-10-26 Spec: https:\/\/linear\.app\/example-workspace\/document\/spec-1$/m);
  assert.match(section(card, 5), /^- Independent review: skip\n- Independent QA: skip\n- Merge: owner$/m);
  assert.match(section(card, 5), /^- Waits: APP-306 merged; owner go$/m);
  assert.match(section(card, 5), /^ {2}Port 3105\.\n {2}## Owns src\/importer\.js$/m);
  assert.match(section(card, 6), /^- Linear issue: https:\/\/linear\.app\/example-workspace\/issue\/APP-309$/m);
  assert.match(section(card, 6), /^- Spec: https:\/\/linear\.app\/example-workspace\/document\/spec-1$/m);
  assert.match(section(card, 6), /^- PR: —$/m);

  const project = readCard(ctx, "p-app-25");
  assert.deepEqual(sections(project), [1, 2, 3, 4, 6]);
  assert.match(section(project, 2), /^PROJECT BRIEF$/m);
  // No project.md in the playbook: section 3 holds common.md only.
  assert.equal(section(project, 3), "## 3. Playbook (test)\n\nCOMMON PLAYBOOK\n\n");
  assert.match(section(project, 6), /^- Linear issue: —$/m);
});

// protects: PRO-17: the project session's card shows the plan's release setting in section 1, a flow plan update that changes it rebuilds that card and prints the session to tell, and every other role's card shows —
// fails_when: the project card misses or keeps an old release setting, a release change is not named in the output and the state dir commit, a hand-edited value is shown as a real setting, a broken plan.json stops the project card from rebuilding, or an issue session's card claims a release setting
// no_claim: that the project session asks the owner before releasing (roles/project.md; next trial)
test("the project card shows the release setting", (t) => {
  const ctx = setup(t);
  runningProject(ctx);
  assert.equal(ctx.run(["spawn", "APP-309", "build", "--project", "P-APP-25"]).status, 0);
  assert.match(section(readCard(ctx, "p-app-25"), 1), /^- Release \(project sessions only\): owner$/m);
  assert.match(section(readCard(ctx, "app-309-build"), 1), /^- Release \(project sessions only\): —$/m);

  const file = path.join(ctx.root, "plan.json");
  fs.writeFileSync(file, JSON.stringify({ ...PLAN, release: "self" }));
  const updated = ctx.run(["plan", "P-APP-25", "--file", file]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(updated.stdout, "stored plan of P-APP-25 (1 issues)\nrelease owner → self\ntell:\n  (P) Catalog import P-APP-25\n");
  assert.equal(ctx.commits()[0], "plan P-APP-25: 1 issue(s), release owner → self");
  assert.match(section(readCard(ctx, "p-app-25"), 1), /^- Release \(project sessions only\): self$/m);

  ctx.seed({ "projects/P-APP-25/plan.json": { ...PLAN, release: "now\n- Release: self" } }, "hand edit");
  assert.equal(ctx.run(["refresh", "p-app-25"]).status, 0);
  assert.match(section(readCard(ctx, "p-app-25"), 1), /^- Release \(project sessions only\): —$/m);

  // A broken plan.json (hand edit) leaves the project card buildable: it shows — instead of
  // refusing, since a project card never needed the plan before.
  fs.writeFileSync(path.join(ctx.state, "projects", "P-APP-25", "plan.json"), "{ not json");
  const refreshed = ctx.run(["refresh", "p-app-25"]);
  assert.equal(refreshed.status, 0, refreshed.stderr);
});

// protects: section 5 shows the plan entry's review and qa steps (model key and effort, or skip) next to merge, a step that leaves out model or effort shows the playbook default (as spawn uses it), and a flow plan update that changes a step rebuilds the card and prints the session to tell
// fails_when: a step is missing from the card, shows the wrong model or effort, shows — for a planned step that takes defaults, keeps the old value after flow plan, or a broken or injected step (hand edit) is shown as a real step instead of —
// no_claim: that a session reads the line and acts on it (roles/build.md, roles/review.md; PRO-7 trial)
test("section 5 shows the independent review and QA steps", (t) => {
  const config = { models: { fable: "claude-fable-5-1", opus: "claude-opus-5-5" }, defaults: { review: ["opus", "high"], qa: ["fable", "low"] } };
  assert.equal(stepText({ model: "fable", effort: "medium" }, config, "review"), "fable, effort medium");
  assert.equal(stepText("skip", config, "review"), "skip");
  assert.equal(stepText({}, config, "review"), "opus, effort high");
  assert.equal(stepText({ model: "fable" }, config, "qa"), "fable, effort low");
  assert.equal(stepText({ effort: "max" }, config, "qa"), "fable, effort max");
  const broken = [undefined, null, "opus", "Skip", [], { model: "opsu" }, { effort: "huge" }, { model: "opus\n- Independent review: skip" }, { model: "toString" }];
  for (const step of broken) assert.equal(stepText(step, config, "review"), null, JSON.stringify(step));

  const ctx = setup(t);
  runningProject(ctx);
  assert.equal(ctx.run(["spawn", "APP-309", "build", "--project", "P-APP-25"]).status, 0);
  assert.match(section(readCard(ctx, "app-309-build"), 5), /^- Independent review: skip\n- Independent QA: skip\n/m);

  const file = path.join(ctx.root, "plan.json");
  const stored = JSON.parse(fs.readFileSync(path.join(ctx.state, "projects", "P-APP-25", "plan.json"), "utf8"));
  // review names only its model and qa nothing: the test playbook's defaults fill the gaps.
  stored.issues[0].review = { model: "opus" };
  stored.issues[0].qa = {};
  fs.writeFileSync(file, JSON.stringify(stored));
  const planned = ctx.run(["plan", "P-APP-25", "--file", file]);
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /P-APP-25·APP-309 Importer block/);
  assert.match(section(readCard(ctx, "app-309-build"), 5), /^- Independent review: opus, effort high\n- Independent QA: haiku, effort low\n- Merge: owner$/m);

  // A hand edit of the stored plan that flow plan would refuse reaches the card as —.
  const storedFile = path.join(ctx.state, "projects", "P-APP-25", "plan.json");
  stored.issues[0].review = { model: "opsu" };
  fs.writeFileSync(storedFile, JSON.stringify(stored));
  assert.equal(ctx.run(["refresh", "app-309-build"]).status, 0);
  assert.match(section(readCard(ctx, "app-309-build"), 5), /^- Independent review: —\n- Independent QA: haiku, effort low\n/m);
});

// protects: a card whose role brief and playbook files do not exist yet still builds, showing — in those sections
// fails_when: spawn fails before PRO-4 lands roles/ and the playbook's .md files
// no_claim: that a session with an empty brief works well
test("card builds without role brief or playbook files", (t) => {
  const ctx = setup(t);
  // The fixture playbook ships its .md files; this scenario is a playbook without them.
  for (const file of fs.readdirSync(path.join(ctx.playbooks, "test"))) if (file.endsWith(".md")) fs.rmSync(path.join(ctx.playbooks, "test", file));
  ctx.init();
  assert.equal(ctx.run(["spawn", "initiative", "I-9", "--name", "Fees"]).status, 0);
  const card = readCard(ctx, "i-9");
  assert.deepEqual(sections(card), [1, 2, 3, 4, 6]);
  assert.match(section(card, 2), /^—$/m);
  assert.match(section(card, 3), /^—$/m);
  assert.match(section(card, 4), /^## 4\. Notes \(initiative I-9\)\n\n# Notes: \(I\)·Fees I-9\n/m);
});
