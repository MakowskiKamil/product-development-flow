import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { appendedNotes, formatNote } from "../lib/plan.mjs";
import { archive, assertRefusal, setup } from "./helpers.mjs";

function entry(fields = {}) {
  return { id: "APP-309", title: "Importer block", build: { model: "opus", effort: "medium" }, review: { model: "sonnet", effort: "high" }, qa: "skip", merge: "self", ...fields };
}

function planFile(ctx, value) {
  const file = path.join(ctx.root, "plan.json");
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

const card = (ctx, slug) => fs.readFileSync(path.join(ctx.state, "sessions", slug, "card.md"), "utf8");

// Every card in the state dir, slug → text.
function cards(ctx) {
  const dir = path.join(ctx.state, "sessions");
  return Object.fromEntries(fs.readdirSync(dir).filter((slug) => fs.existsSync(path.join(dir, slug, "card.md"))).map((slug) => [slug, card(ctx, slug)]));
}

// Initiative I-9, project P-APP-25 running with APP-309 and APP-310, sessions
// app-309-build, app-309-review, app-310-build, and an archived app-309-build-2.
function lanes(ctx) {
  ctx.init();
  const ok = (args) => {
    const result = ctx.run(args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  };
  ok(["spawn", "initiative", "I-9", "--name", "Fees"]);
  ok(["spawn", "project", "P-APP-25", "--name", "Catalog import", "--initiative", "I-9"]);
  ok(["phase", "P-APP-25", "spec"]);
  ok(["phase", "P-APP-25", "issues"]);
  ok(["plan", "P-APP-25", "--file", planFile(ctx, { project: "P-APP-25", release: "self", issues: [entry({ notes: "Port 3105." }), entry({ id: "APP-310", title: "Other" })] })]);
  ok(["phase", "P-APP-25", "running"]);
  ok(["spawn", "APP-309", "build", "--project", "P-APP-25"]);
  ok(["spawn", "APP-309", "review", "--project", "P-APP-25"]);
  ok(["spawn", "APP-310", "build", "--project", "P-APP-25"]);
  ok(["spawn", "APP-309", "build", "--project", "P-APP-25", "--again"]);
  archive(ctx, "app-309-build-2");
}

const BUILD = "I-9·P-APP-25·APP-309 Importer block";
const REVIEW = "I-9·P-APP-25·APP-309 Importer block·review";
const OTHER = "I-9·P-APP-25·APP-310 Other";
const PROJECT = "(P) I-9·Catalog import P-APP-25";
const INITIATIVE = "(I)·Fees I-9";

// protects: the note format "- <date> <text>" with further lines indented, and appendedNotes (the d3 guard) reading back exactly what formatNote wrote, blank lines and stray control characters included
// fails_when: formatNote and appendedNotes drift apart, so a note's later lines escape the d3 guard, or a note line can start a card section
// no_claim: the CLI path (tests below)
test("formatNote writes what appendedNotes reads", () => {
  assert.equal(formatNote("2026-10-26", "  one line  "), "- 2026-10-26 one line");
  const note = formatNote("2026-10-26", "first\r\n\n## not a heading\n  - nested\u0007\n\n- 2026-10-27 not a new note");
  assert.equal(note, "- 2026-10-26 first\n  ## not a heading\n    - nested\n  - 2026-10-27 not a new note");
  assert.deepEqual(appendedNotes(`Port 3105.\n${note}`), [note]);
  assert.equal(formatNote("2026-10-26", " \n\t\n"), null);
});

// protects: flow note <issue-id> appends the note to the plan entry, rebuilds only that issue's non-archived cards (app-309-*), prints their names and commits once
// fails_when: another issue's, the project's, or an archived session's card changes, a session to tell is missing, or the note lands elsewhere
// no_claim: that the sessions act on "Card updated" (they are told by the project session)
test("flow note <issue-id> rebuilds only that issue's live cards", (t) => {
  const ctx = setup(t);
  lanes(ctx);
  const before = cards(ctx);
  const commits = ctx.commits().length;

  const result = ctx.run(["note", "APP-309", "--text", "use the new reader\nnot the old one"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `noted in the plan entry of APP-309 in P-APP-25\ntell:\n  ${BUILD}\n  ${REVIEW}\n`);
  assert.equal(ctx.readJson("projects/P-APP-25/plan.json").issues[0].notes, "Port 3105.\n- 2026-10-26 use the new reader\n  not the old one");
  const after = cards(ctx);
  for (const slug of ["app-309-build", "app-309-review"]) {
    assert.match(after[slug], /^ {2}Port 3105\.\n {2}- 2026-10-26 use the new reader\n {4}not the old one$/m, slug);
  }
  for (const slug of ["app-310-build", "app-309-build-2", "p-app-25", "i-9"]) assert.equal(after[slug], before[slug], slug);
  assert.equal(ctx.commits().length, commits + 1);
  assert.match(ctx.commits()[0], /^note APP-309: - 2026-10-26 use the new reader$/);
});

// protects: flow note <P-id> appends to the project's notes.md and rebuilds all of the project's non-archived cards (project and issue sessions), printing their names; flow note <I-id> rebuilds the initiative's card
// fails_when: an issue card misses the project note, an archived card is rebuilt, or the initiative note reaches cards that do not show it
// no_claim: the order of the names printed beyond the records' order
test("flow note <P-id> rebuilds every live card of the project", (t) => {
  const ctx = setup(t);
  lanes(ctx);
  const before = cards(ctx);

  const result = ctx.run(["note", "P-APP-25", "--text", "Spec: https://linear.app/example-workspace/document/spec-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `noted in projects/P-APP-25/notes.md\ntell:\n  ${BUILD}\n  ${REVIEW}\n  ${OTHER}\n  ${PROJECT}\n`);
  assert.equal(fs.readFileSync(path.join(ctx.state, "projects/P-APP-25/notes.md"), "utf8"), `# Notes: ${PROJECT}\n- 2026-10-26 Spec: https://linear.app/example-workspace/document/spec-1\n`);
  const after = cards(ctx);
  for (const slug of ["app-309-build", "app-309-review", "app-310-build", "p-app-25"]) {
    assert.match(after[slug], /^- 2026-10-26 Spec: https:\/\/linear\.app\/example-workspace\/document\/spec-1$/m, slug);
    assert.match(after[slug], /^- Spec: https:\/\/linear\.app\/example-workspace\/document\/spec-1$/m, slug);
  }
  assert.equal(after["app-309-build-2"], before["app-309-build-2"]);
  assert.equal(after["i-9"], before["i-9"]);

  const initiative = ctx.run(["note", "I-9", "--text", "P-APP-25 first"]);
  assert.equal(initiative.status, 0, initiative.stderr);
  assert.equal(initiative.stdout, `noted in initiatives/I-9/notes.md\ntell:\n  ${INITIATIVE}\n`);
  assert.match(card(ctx, "i-9"), /^- 2026-10-26 P-APP-25 first$/m);
});

// protects: a note added by flow note is guarded by d3: a plan file that drops it is refused naming the issue; one that keeps it is stored and the card keeps the note
// fails_when: flow note's format and the d3 guard drift apart, so a rewritten plan silently loses a parent's note
// no_claim: notes on issues the new plan removes (removal guard)
test("flow plan keeps a note flow note added (d3)", (t) => {
  const ctx = setup(t);
  lanes(ctx);
  assert.equal(ctx.run(["note", "APP-309", "--text", "use the new reader\nnot the old one"]).status, 0);
  const stored = ctx.readJson("projects/P-APP-25/plan.json");

  const dropped = ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, { ...stored, issues: [entry({ notes: "Port 3105.\n- 2026-10-26 use the new reader" }), stored.issues[1]] })]);
  assertRefusal(dropped, { first: /^flow plan: APP-309 notes: the file drops 1 line\(s\) added by flow note: "- 2026-10-26 use the new reader"$/ });

  const kept = ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, { ...stored, issues: [{ ...stored.issues[0], waits: ["APP-306 merged"] }, stored.issues[1]] })]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(kept.stdout, `stored plan of P-APP-25 (2 issues)\ntell:\n  ${BUILD}\n  ${REVIEW}\n`);
  assert.match(card(ctx, "app-309-build"), /^- Waits: APP-306 merged$/m);
  assert.match(card(ctx, "app-309-build"), /^ {4}not the old one$/m);
});

// protects: flow plan rebuilds the project's cards and prints only the sessions whose card changed
// fails_when: a plan change to APP-310 tells APP-309's sessions, or an unchanged plan tells anyone
// no_claim: the plan validation itself (plan.test.mjs)
test("flow plan tells only sessions whose card changed", (t) => {
  const ctx = setup(t);
  lanes(ctx);
  const stored = ctx.readJson("projects/P-APP-25/plan.json");
  const result = ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, { ...stored, issues: [stored.issues[0], { ...stored.issues[1], merge: "owner" }] })]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `stored plan of P-APP-25 (2 issues)\ntell:\n  ${OTHER}\n`);
  assert.match(card(ctx, "app-310-build"), /^- Merge: owner$/m);
  const same = ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, ctx.readJson("projects/P-APP-25/plan.json"))]);
  assert.equal(same.stdout, "unchanged: plan of P-APP-25 (2 issues)\n");
});

// protects: an issue in more than one plan is refused without --project, naming the plans; --project picks one and reads only that plan; --project not holding the issue is refused
// fails_when: the note lands in a guessed plan, the refusal does not say which plans, or a broken unrelated plan blocks a note with --project
// no_claim: an issue in two real projects is sensible (it is not; this is the guard)
test("flow note <issue-id> in two plans needs --project", (t) => {
  const ctx = setup(t);
  lanes(ctx);
  assert.equal(ctx.run(["spawn", "hygiene"]).status, 0);
  assert.equal(ctx.run(["plan", "H", "--file", planFile(ctx, { project: "H", issues: [entry({ title: "Offsite cleanup" })] })]).status, 0);
  const before = ctx.commits();

  assertRefusal(ctx.run(["note", "APP-309", "--text", "x"]), { first: /^flow note: APP-309 is in the plans of H and P-APP-25$/, fix: /flow note APP-309 --project H --text/ });
  assertRefusal(ctx.run(["note", "APP-310", "--project", "H", "--text", "x"]), { first: /^flow note: APP-310 is not in the plan of H$/, fix: /add APP-310 to the plan first \(flow plan H/ });
  assert.deepEqual(ctx.commits(), before);

  // With --project only that plan is read: a broken plan elsewhere does not block the note.
  ctx.seed({ "projects/P-OLD-1/plan.json": "{ not json" }, "broken plan");
  assertRefusal(ctx.run(["note", "APP-310", "--text", "x"]), { first: /^flow note: .*P-OLD-1\/plan\.json is not valid JSON/ });
  const scoped = ctx.run(["note", "APP-310", "--project", "P-APP-25", "--text", "scoped"]);
  assert.equal(scoped.status, 0, scoped.stderr);

  const result = ctx.run(["note", "APP-309", "--project", "H", "--text", "hygiene only"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "noted in the plan entry of APP-309 in H\n");
  assert.match(ctx.readJson("projects/H/plan.json").issues[0].notes, /^- 2026-10-26 hygiene only$/);
  assert.equal(ctx.readJson("projects/P-APP-25/plan.json").issues[0].notes, "Port 3105.");
});

// protects: unknown or invalid targets for note and refresh, an empty note, --project on a non-issue target and an archived slug exit 1 with nothing committed
// fails_when: a bad target is accepted, creates files, or commits
// no_claim: the wording beyond the first line's subject
test("flow note and flow refresh refuse unknown targets", (t) => {
  const ctx = setup(t);
  lanes(ctx);
  const before = ctx.commits();
  const refusals = [
    [["note", "app-309", "--text", "x"], /^flow note: note target "app-309" is not a project id, an initiative id, H or an issue id$/],
    [["note", "P-APP-99", "--text", "x"], /^flow note: project P-APP-99 does not exist$/],
    [["note", "I-8", "--text", "x"], /^flow note: initiative I-8 does not exist$/],
    [["note", "H", "--text", "x"], /^flow note: project H does not exist$/],
    [["note", "APP-999", "--text", "x"], /^flow note: APP-999 is in no project's plan$/],
    [["note", "APP-309", "--text", " \n "], /^flow note: note for APP-309 has no text$/],
    [["note", "APP-309"], /^flow note: note for APP-309 has no --text$/],
    [["note", "P-APP-25", "--project", "P-APP-25", "--text", "x"], /^flow note: --project is only for an issue target, not P-APP-25$/],
    [["refresh"], /^flow refresh: no refresh target given$/],
    [["refresh", "nope"], /^flow refresh: refresh target "nope" is not a session slug, a project id, H or all$/],
    [["refresh", "P-APP-99"], /^flow refresh: project P-APP-99 does not exist$/],
    [["refresh", "app-309-build-2"], /^flow refresh: session app-309-build-2 is archived; its card is not rebuilt$/],
  ];
  for (const [args, first] of refusals) assertRefusal(ctx.run(args), { first });
  assert.deepEqual(ctx.commits(), before);
  assert.equal(ctx.untracked(), "");
});

// protects: flow refresh all rebuilds every non-archived card from the current role briefs and playbook, prints the names whose card changed and commits once; a card right after spawn needs no rebuild; refresh of a slug or a project id rebuilds just those
// fails_when: a live card keeps an old brief, an archived card is rebuilt, spawn and refresh build different cards, or an unchanged refresh commits
// no_claim: that the repo's real roles/ and playbooks/ render well (PRO-4)
test("flow refresh rebuilds cards from current briefs and playbook", (t) => {
  const ctx = setup(t);
  lanes(ctx);
  const archived = card(ctx, "app-309-build-2");
  const commits = ctx.commits().length;
  // Spawn and refresh build the same card.
  assert.equal(ctx.run(["refresh", "all"]).stdout, "rebuilt 5 card(s) for all, 0 changed\n");
  assert.equal(ctx.commits().length, commits);

  fs.writeFileSync(path.join(ctx.roles, "build.md"), "NEW BUILD BRIEF\n");
  const slug = ctx.run(["refresh", "app-310-build"]);
  assert.equal(slug.stdout, `rebuilt 1 card(s) for app-310-build, 1 changed\ntell:\n  ${OTHER}\n`);
  assert.match(card(ctx, "app-310-build"), /^NEW BUILD BRIEF$/m);
  assert.doesNotMatch(card(ctx, "app-309-build"), /NEW BUILD BRIEF/);

  fs.writeFileSync(path.join(ctx.playbooks, "test", "common.md"), "NEW COMMON\n");
  const all = ctx.run(["refresh", "all"]);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(all.stdout, `rebuilt 5 card(s) for all, 5 changed\ntell:\n  ${BUILD}\n  ${REVIEW}\n  ${OTHER}\n  ${INITIATIVE}\n  ${PROJECT}\n`);
  for (const [cardSlug, text] of Object.entries(cards(ctx))) {
    if (cardSlug === "app-309-build-2") assert.equal(text, archived);
    else assert.match(text, /^NEW COMMON$/m, cardSlug);
  }
  assert.match(card(ctx, "app-309-build"), /^NEW BUILD BRIEF$/m);
  assert.equal(ctx.commits()[0], "refresh all: 5 card(s) changed");

  fs.writeFileSync(path.join(ctx.roles, "review.md"), "REVIEW BRIEF\n");
  assert.equal(ctx.run(["refresh", "P-APP-25"]).stdout, `rebuilt 4 card(s) for P-APP-25, 1 changed\ntell:\n  ${REVIEW}\n`);
});

// protects: flow set pr=<n> rebuilds that session's card so its links show the PR, in the same commit as the record
// fails_when: the card keeps "PR: —" after flow set, or another session's card changes
// no_claim: a link to the PR on GitHub (the card shows the number)
test("flow set pr rebuilds the session's card", (t) => {
  const ctx = setup(t);
  lanes(ctx);
  const other = card(ctx, "app-310-build");
  const commits = ctx.commits().length;
  const result = ctx.run(["set", "app-309-build", "pr=12"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(card(ctx, "app-309-build"), /^- PR: 12$/m);
  assert.equal(card(ctx, "app-310-build"), other);
  assert.equal(ctx.commits().length, commits + 1);
  assert.equal(ctx.untracked(), "");
});
