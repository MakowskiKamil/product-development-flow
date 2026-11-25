import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PHASES, appendedNotes, validatePlan } from "../lib/plan.mjs";
import { archive, assertRefusal, setup } from "./helpers.mjs";

const MODELS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };

function entry(fields = {}) {
  return { id: "APP-309", title: "Importer block", build: { model: "opus", effort: "medium" }, review: { model: "sonnet", effort: "high" }, qa: "skip", merge: "self", ...fields };
}

// A project plan carries the release setting (PRO-17); hygiene's has none.
function plan(issues = [entry()], project = "P-APP-25") {
  return project === "H" ? { project, issues } : { project, release: "self", issues };
}

// Writes a plan file outside the state dir and returns its path.
function planFile(ctx, value, name = "plan.json") {
  const file = path.join(ctx.root, name);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return file;
}

// A project P-APP-25 with its session, moved to `phase` the way a project session would.
function project(ctx, phase = "intake") {
  ctx.init();
  assert.equal(ctx.run(["spawn", "project", "P-APP-25", "--name", "Catalog import"]).status, 0);
  for (const next of PHASES.slice(1, PHASES.indexOf(phase) + 1)) {
    assert.equal(ctx.run(["phase", "P-APP-25", next]).status, 0);
  }
}

function running(ctx, issues = [entry()]) {
  project(ctx, "issues");
  assert.equal(ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan(issues))]).status, 0);
  const result = ctx.run(["phase", "P-APP-25", "running"]);
  assert.equal(result.status, 0, result.stderr);
}

// protects: every plan validation rule of the spec, each with the exact message naming the issue (or its position), the field, the actual value and the allowed set
// fails_when: a broken plan is accepted, or a message loses the issue, the field or the value
// no_claim: rules the spec does not list (unknown fields are not checked)
test("each validation rule has its exact message", () => {
  assert.deepEqual(validatePlan(plan(), { project: "P-APP-25", models: MODELS }), []);
  assert.deepEqual(validatePlan({ ...plan([entry({ build: {}, review: {}, qa: {}, notes: "n", waits: ["APP-306 merged"], merge: "owner" })]), release: "owner" }, { project: "P-APP-25", models: MODELS }), []);
  assert.deepEqual(validatePlan(plan([entry()], "H"), { project: "H", models: MODELS }), []);
  assert.deepEqual(validatePlan({ ...plan([entry()], "H"), release: "self" }, { project: "H", models: MODELS }), ['plan release: hygiene (H) has no release setting; remove "release"']);
  const cases = [
    [[1, 2], 'plan: [1,2] is not a JSON object'],
    [plan([entry()], "P-APP-26"), 'plan project: "P-APP-26" is not P-APP-25'],
    [{ project: "P-APP-25", release: "self" }, "plan issues: missing is not an array"],
    [plan(["APP-309"]), 'issues[0]: "APP-309" is not an object'],
    [plan([entry({ id: "FIN309" })]), 'issues[0] id: "FIN309" does not match /^[A-Z]+-\\d+$/'],
    [plan([entry(), entry({ title: "Again" })]), "APP-309 id: appears twice (issues[0] and issues[1])"],
    [plan([entry({ title: " \n " })]), 'APP-309 title: " \\n " is not a non-empty string'],
    [plan([entry({ title: undefined })]), "APP-309 title: missing is not a non-empty string"],
    [plan([entry({ build: "skip" })]), 'APP-309 build: "skip" is not an object'],
    [plan([entry({ review: "none" })]), 'APP-309 review: "none" is not an object or "skip"'],
    [plan([entry({ qa: undefined })]), 'APP-309 qa: missing is not an object or "skip"'],
    [plan([entry({ review: { model: "opsu" } })]), 'APP-309 review.model: "opsu" not in opus, sonnet, haiku'],
    [plan([entry({ build: { model: "claude-opus-5-5" } })]), 'APP-309 build.model: "claude-opus-5-5" not in opus, sonnet, haiku'],
    [plan([entry({ build: { effort: "huge" } })]), 'APP-309 build.effort: "huge" not in low, medium, high, xhigh, max'],
    [plan([entry({ notes: 5 })]), "APP-309 notes: 5 is not a string"],
    [plan([entry({ waits: "APP-306 merged" })]), 'APP-309 waits: "APP-306 merged" is not an array of strings'],
    [plan([entry({ waits: [306] })]), "APP-309 waits: [306] is not an array of strings"],
    [plan([entry({ merge: undefined })]), "APP-309 merge: missing not in self, owner"],
    [plan([entry({ merge: "auto" })]), 'APP-309 merge: "auto" not in self, owner'],
    [{ ...plan(), release: undefined }, "plan release: missing not in self, owner"],
    [{ ...plan(), release: "auto" }, 'plan release: "auto" not in self, owner'],
  ];
  for (const [value, message] of cases) {
    assert.deepEqual(validatePlan(value, { project: "P-APP-25", models: MODELS }), [message]);
  }
});

// protects: flow plan refuses an invalid file with exit 1, the first error on the first line (naming issue and field), the others listed, nothing stored
// fails_when: an invalid plan is stored, or the refusal hides which issue is wrong
// no_claim: the wording of every message (unit test above)
test("flow plan refuses an invalid plan and stores nothing", (t) => {
  const ctx = setup(t);
  project(ctx, "issues");
  const before = ctx.commits();
  const file = planFile(ctx, plan([entry({ merge: undefined }), entry({ id: "APP-310", review: { model: "opsu" } })]));
  const result = ctx.run(["plan", "P-APP-25", "--file", file]);
  assertRefusal(result, { first: /^flow plan: APP-309 merge: missing not in self, owner$/, fix: /flow plan P-APP-25 --file/ });
  assert.match(result.stderr, /^also: APP-310 review\.model: "opsu" not in opus, sonnet, haiku$/m);
  assert.deepEqual(ctx.commits(), before);
  assert.deepEqual(ctx.readJson("projects/P-APP-25/plan.json"), { project: "P-APP-25", issues: [] });
  assertRefusal(ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan([entry({ merge: "always" })]), "always.json")]), { first: /^flow plan: APP-309 merge: "always" not in self, owner$/ });
  assertRefusal(ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, "{ not json", "broken.json")]), { first: /^flow plan: plan file .* is not valid JSON/ });
  assertRefusal(ctx.run(["plan", "P-APP-25", "--file", path.join(ctx.root, "missing.json")]), { first: /^flow plan: cannot read plan file .*missing\.json \(ENOENT\)$/ });
  assertRefusal(ctx.run(["plan", "P-APP-25"]), { first: /^flow plan: plan of P-APP-25 has no --file$/ });
  assertRefusal(ctx.run(["plan", "P-NOPE-1", "--file", file]), { first: /^flow plan: project P-NOPE-1 does not exist$/ });
  assert.deepEqual(ctx.commits(), before);
});

// protects: flow plan stores the plan in phases issues and running (one commit each), makes no commit for an unchanged plan, and is refused in intake, spec and closed
// fails_when: a plan is stored before the spec is accepted or after the project closed, or an unchanged plan adds a commit
// no_claim: card rebuilds (notes.test.mjs)
test("flow plan is allowed in issues and running only", (t) => {
  const ctx = setup(t);
  project(ctx, "intake");
  const file = planFile(ctx, plan());
  assertRefusal(ctx.run(["plan", "P-APP-25", "--file", file]), { first: /^flow plan: P-APP-25 is in phase intake; a plan is stored only in phases issues and running$/, fix: /flow phase P-APP-25 spec/ });
  assert.equal(ctx.run(["phase", "P-APP-25", "spec"]).status, 0);
  assertRefusal(ctx.run(["plan", "P-APP-25", "--file", file]), { first: /in phase spec;/, fix: /flow phase P-APP-25 issues/ });
  assert.equal(ctx.run(["phase", "P-APP-25", "issues"]).status, 0);
  const stored = ctx.run(["plan", "P-APP-25", "--file", file]);
  assert.equal(stored.status, 0, stored.stderr);
  // The project card shows the plan's release setting (PRO-17), so its session is told.
  assert.equal(stored.stdout, "stored plan of P-APP-25 (1 issues)\nrelease none → self\ntell:\n  (P) Catalog import P-APP-25\n");
  assert.deepEqual(ctx.readJson("projects/P-APP-25/plan.json"), plan());
  assert.equal(ctx.commits()[0], "plan P-APP-25: 1 issue(s), release none → self");
  const count = ctx.commits().length;
  assert.equal(ctx.run(["plan", "P-APP-25", "--file", file]).stdout, "unchanged: plan of P-APP-25 (1 issues)\n");
  assert.equal(ctx.commits().length, count);
  assert.equal(ctx.run(["phase", "P-APP-25", "running"]).status, 0);
  assert.equal(ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan([entry(), entry({ id: "APP-310" })]))]).status, 0);
  assert.equal(ctx.run(["phase", "P-APP-25", "closed"]).status, 0);
  assertRefusal(ctx.run(["plan", "P-APP-25", "--file", file]), { first: /in phase closed;/, fix: /closed; nothing to plan/ });
});

// protects: hygiene stores plans at any time (no phases), with "project": "H"
// fails_when: hygiene is gated by a phase, or accepts a plan for another project
// no_claim: anything about hygiene's Triage workflow
test("flow plan H is always allowed", (t) => {
  const ctx = setup(t);
  ctx.init();
  assert.equal(ctx.run(["spawn", "hygiene"]).status, 0);
  assertRefusal(ctx.run(["plan", "H", "--file", planFile(ctx, plan())]), { first: /^flow plan: plan project: "P-APP-25" is not H$/ });
  assert.equal(ctx.run(["plan", "H", "--file", planFile(ctx, plan([entry()], "H"))]).status, 0);
  assert.equal(ctx.run(["spawn", "APP-309", "build", "--project", "H"]).status, 0);
});

// protects: a new plan that removes an issue, or sets a step to "skip", while that step has a non-archived session is refused, listing each session; archived sessions do not block
// fails_when: a running lane loses its plan entry or its step, or archived sessions keep blocking plan changes
// no_claim: what the lane does once it is archived
test("flow plan guards issues and steps with live sessions", (t) => {
  const ctx = setup(t);
  running(ctx, [entry(), entry({ id: "APP-310", title: "Other" })]);
  assert.equal(ctx.run(["spawn", "APP-309", "build", "--project", "P-APP-25"]).status, 0);
  assert.equal(ctx.run(["spawn", "APP-309", "review", "--project", "P-APP-25"]).status, 0);
  const before = ctx.commits();

  const dropped = ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan([entry({ id: "APP-310", title: "Other" })]))]);
  assertRefusal(dropped, { first: /^flow plan: the plan drops work of 2 non-archived session\(s\): "P-APP-25·APP-309 Importer block" \(app-309-build, running\): APP-309 removed from the plan$/, fix: /flow archive/ });
  assert.match(dropped.stderr, /^session "P-APP-25·APP-309 Importer block" \(app-309-build, running\): APP-309 removed from the plan$/m);
  assert.match(dropped.stderr, /^session "P-APP-25·APP-309 Importer block·review" \(app-309-review, running\): APP-309 removed from the plan$/m);

  const skipped = ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan([entry({ review: "skip" })]))]);
  assertRefusal(skipped, { first: /^flow plan: the plan drops work of 1 non-archived session\(s\): "P-APP-25·APP-309 Importer block·review" \(app-309-review, running\): APP-309 review set to "skip"$/ });
  assert.deepEqual(ctx.commits(), before);

  // A plan change that keeps them prints the live issue sessions to tell.
  const kept = ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan([entry({ notes: "Port 3105" })]))]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(kept.stdout, "stored plan of P-APP-25 (1 issues)\ntell:\n  P-APP-25·APP-309 Importer block\n  P-APP-25·APP-309 Importer block·review\n");

  archive(ctx, "app-309-review");
  assert.equal(ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan([entry({ notes: "Port 3105", review: "skip" })]))]).status, 0);
  archive(ctx, "app-309-build");
  assert.equal(ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan([entry({ id: "APP-310", title: "Other" })]))]).status, 0);
});

// protects: gate decision d3: a new plan that drops note lines `flow note` appended to a kept issue is refused naming the issue
// fails_when: a project session rewriting its plan silently loses a parent's note
// no_claim: notes of issues the new plan removes (the removal guard covers those with sessions); flow note writing this format (notes.test.mjs)
test("flow plan keeps notes appended by flow note (d3)", (t) => {
  const ctx = setup(t);
  running(ctx);
  // As flow note appends them (formatNote): "- <date> <text>", further lines indented.
  const noted = "Port 3105.\n- 2026-10-26 use the new reader\n  not the old one\n- 2026-10-27 waits on APP-306";
  ctx.seed({ "projects/P-APP-25/plan.json": plan([entry({ notes: noted })]) }, "note APP-309");
  assert.deepEqual(appendedNotes(noted), ["- 2026-10-26 use the new reader\n  not the old one", "- 2026-10-27 waits on APP-306"]);

  const lost = ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan([entry({ notes: "Port 3106.\n- 2026-10-26 use the new reader" })]))]);
  assertRefusal(lost, { first: /^flow plan: APP-309 notes: the file drops 2 line\(s\) added by flow note: "- 2026-10-26 use the new reader"$/, fix: /copy the notes of APP-309 from .*plan\.json into the file/ });
  assert.match(lost.stderr, /^dropped: - 2026-10-27 waits on APP-306$/m);
  assertRefusal(ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan([entry()]))]), { first: /^flow plan: APP-309 notes: the file drops 2 line/ });
  // An edited note is a dropped note: lines are matched whole, not as substrings.
  const reworded = noted.replace("waits on APP-306", "waits on APP-306 and APP-307").replace("not the old one", "not the old one at all");
  assertRefusal(ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan([entry({ notes: reworded })]))]), { first: /^flow plan: APP-309 notes: the file drops 2 line/ });

  // Hand-written lines may change; the appended ones must stay.
  const edited = ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan([entry({ notes: `Port 3106.\n${noted.split("\n").slice(1).join("\n")}\n- 2026-10-28 new` })]))]);
  assert.equal(edited.status, 0, edited.stderr);
  // Removing the issue altogether is not a dropped note.
  assert.equal(ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan([entry({ id: "APP-310" })]))]).status, 0);
});

// protects: flow phase moves one step forward only, committing each move; any other target exits 1 naming the current phase and the next one
// fails_when: a phase is skipped, moved backward, repeated, or set to an unknown value
// no_claim: who may run it (advisory, per role brief)
test("flow phase moves one step forward only", (t) => {
  const ctx = setup(t);
  project(ctx, "intake");
  for (const target of ["issues", "running", "closed", "intake", "planning"]) {
    assertRefusal(ctx.run(["phase", "P-APP-25", target]), { first: new RegExp(`^flow phase: P-APP-25 is in phase intake; "${target}" is not its next phase$`), fix: /^fix: flow phase P-APP-25 spec$/ });
  }
  assert.equal(ctx.run(["phase", "P-APP-25", "spec"]).stdout, "P-APP-25: intake → spec\n");
  assert.equal(ctx.readJson("projects/P-APP-25/project.json").phase, "spec");
  assert.equal(ctx.commits()[0], "phase P-APP-25: intake → spec");
  assertRefusal(ctx.run(["phase", "P-APP-25", "spec"]), { first: /is in phase spec; "spec" is not its next phase$/, fix: /flow phase P-APP-25 issues$/ });
  assertRefusal(ctx.run(["phase", "P-APP-25", "intake"]), { first: /is in phase spec; "intake" is not its next phase$/ });
  assertRefusal(ctx.run(["phase", "P-APP-25"]), { first: /^flow phase: project and phase are both needed$/ });
  assertRefusal(ctx.run(["phase", "P-NOPE-1", "spec"]), { first: /^flow phase: project P-NOPE-1 does not exist$/ });
  assertRefusal(ctx.run(["phase", "p-app-25", "spec"]), { first: /project "p-app-25" is neither/ });
  ctx.seed({ "projects/P-APP-25/project.json": { ...ctx.readJson("projects/P-APP-25/project.json"), phase: "planning" } }, "hand-edited phase");
  assertRefusal(ctx.run(["phase", "P-APP-25", "intake"]), { first: /^flow phase: P-APP-25 has an unknown phase "planning" in project\.json$/, fix: /set "phase" to one of intake, spec/ });
  assertRefusal(ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan())]), { first: /^flow plan: P-APP-25 has an unknown phase "planning" in project\.json$/ });
  ctx.seed({ "projects/P-APP-25/project.json": "null\n" }, "broken project.json");
  assertRefusal(ctx.run(["phase", "P-APP-25", "spec"]), { first: /^flow phase: P-APP-25 has an unknown phase undefined in project\.json$/ });
});

// protects: hygiene has no phases: flow phase H exits 1
// fails_when: hygiene's fixed running phase can be moved (to closed, blocking its spawns)
// no_claim: anything else about hygiene
test("flow phase H is refused", (t) => {
  const ctx = setup(t);
  ctx.init();
  assert.equal(ctx.run(["spawn", "hygiene"]).status, 0);
  assertRefusal(ctx.run(["phase", "H", "closed"]), { first: /^flow phase: hygiene \(H\) has no phases; its phase is always running$/ });
  assert.equal(ctx.readJson("projects/H/project.json").phase, "running");
});

// protects: gate decision d2: flow phase <P> running exits 1 until the stored plan is valid and has at least one issue; PRO-17: a plan without the release setting (hand-stored) keeps it out of running
// fails_when: a project reaches running with an empty or broken plan, or before the owner chose who says go for its release
// no_claim: that the plan is the one the owner agreed (the project session's job)
test("flow phase running needs a valid plan with an issue (d2)", (t) => {
  const ctx = setup(t);
  project(ctx, "issues");
  assertRefusal(ctx.run(["phase", "P-APP-25", "running"]), { first: /^flow phase: P-APP-25 has no issues in its plan; running needs at least one$/, fix: /flow plan P-APP-25 --file <path>, then flow phase P-APP-25 running/ });
  ctx.seed({ "projects/P-APP-25/plan.json": plan([entry({ merge: "later" })]) }, "hand-edited plan");
  assertRefusal(ctx.run(["phase", "P-APP-25", "running"]), { first: /^flow phase: APP-309 merge: "later" not in self, owner$/ });
  ctx.seed({ "projects/P-APP-25/plan.json": { ...plan(), release: undefined } }, "plan from before PRO-17");
  assertRefusal(ctx.run(["phase", "P-APP-25", "running"]), { first: /^flow phase: plan release: missing not in self, owner$/ });
  assert.equal(ctx.readJson("projects/P-APP-25/project.json").phase, "issues");
  assert.equal(ctx.run(["plan", "P-APP-25", "--file", planFile(ctx, plan())]).status, 0);
  assert.equal(ctx.run(["phase", "P-APP-25", "running"]).status, 0);
});

// protects: flow phase closed is refused while a non-archived issue session of the project exists, listing each; allowed once all are archived; nothing follows closed
// fails_when: a project closes under a live lane, or the refusal does not say which
// no_claim: the release itself (the project session runs it under the plan's release setting; roles/project.md)
test("flow phase closed waits for every issue session to be archived", (t) => {
  const ctx = setup(t);
  running(ctx);
  assert.equal(ctx.run(["spawn", "APP-309", "build", "--project", "P-APP-25"]).status, 0);
  assert.equal(ctx.run(["spawn", "APP-309", "review", "--project", "P-APP-25"]).status, 0);
  archive(ctx, "app-309-review");
  const result = ctx.run(["phase", "P-APP-25", "closed"]);
  assertRefusal(result, { first: /^flow phase: P-APP-25 still has 1 non-archived issue session\(s\): "P-APP-25·APP-309 Importer block" \(app-309-build, running\)$/, fix: /flow archive/ });
  assert.match(result.stderr, /^open: "P-APP-25·APP-309 Importer block" \(app-309-build, running\)$/m);
  assert.doesNotMatch(result.stderr, /app-309-review/);
  archive(ctx, "app-309-build");
  assert.equal(ctx.run(["phase", "P-APP-25", "closed"]).status, 0);
  assertRefusal(ctx.run(["phase", "P-APP-25", "closed"]), { first: /is in phase closed; "closed" is not its next phase$/, fix: /closed, the last phase/ });
});

// protects: issue spawns are refused in intake, spec, issues and closed with the phase named, allowed in running; a project re-spawn is refused once closed
// fails_when: a lane starts before the plan is agreed, or anything starts in a closed project
// no_claim: model/effort choice (spawn.test.mjs)
test("issue spawn is gated by the phase", (t) => {
  const ctx = setup(t);
  project(ctx, "intake");
  const args = ["spawn", "APP-309", "build", "--project", "P-APP-25"];
  // The plan is seeded so only the phase can refuse.
  ctx.seed({ "projects/P-APP-25/plan.json": plan() });
  assertRefusal(ctx.run(args), { first: /^flow spawn: P-APP-25 is in phase intake; issue sessions start only in phase running$/, fix: /flow phase P-APP-25 spec/ });
  assert.equal(ctx.run(["phase", "P-APP-25", "spec"]).status, 0);
  assertRefusal(ctx.run(args), { first: /^flow spawn: P-APP-25 is in phase spec;/, fix: /flow phase P-APP-25 issues/ });
  assert.equal(ctx.run(["phase", "P-APP-25", "issues"]).status, 0);
  assertRefusal(ctx.run(args), { first: /^flow spawn: P-APP-25 is in phase issues;/, fix: /flow phase P-APP-25 running/ });
  assert.equal(ctx.run(["phase", "P-APP-25", "running"]).status, 0);
  const started = ctx.run(args);
  assert.equal(started.status, 0, started.stderr);
  archive(ctx, "app-309-build");
  assert.equal(ctx.run(["phase", "P-APP-25", "closed"]).status, 0);
  assertRefusal(ctx.run([...args, "--again"]), { first: /^flow spawn: P-APP-25 is in phase closed;/, fix: /P-APP-25 is closed; nothing starts in it/ });
  archive(ctx, "p-app-25");
  assertRefusal(ctx.run(["spawn", "project", "P-APP-25"]), { first: /^flow spawn: project P-APP-25 is closed$/ });
});

// protects: an issue spawn is refused for an issue not in the plan, or a step the plan sets to "skip"
// fails_when: a session starts for work the plan does not ask for
// no_claim: steps missing from a hand-edited plan (flow plan never stores one; spawn falls back to playbook defaults)
test("issue spawn refused for an issue not in the plan or a skipped step", (t) => {
  const ctx = setup(t);
  running(ctx);
  assertRefusal(ctx.run(["spawn", "APP-310", "build", "--project", "P-APP-25"]), { first: /^flow spawn: APP-310 is not in the plan of P-APP-25$/ });
  // A hand-broken plan.json is a refusal, not a crash.
  const good = ctx.readJson("projects/P-APP-25/plan.json");
  for (const broken of [{ project: "P-APP-25", issues: {} }, { project: "P-APP-25", issues: [null] }]) {
    ctx.seed({ "projects/P-APP-25/plan.json": broken }, "hand-broken plan");
    assertRefusal(ctx.run(["spawn", "APP-309", "build", "--project", "P-APP-25"]), { first: /^flow spawn: APP-309 is not in the plan of P-APP-25$/ });
  }
  ctx.seed({ "projects/P-APP-25/plan.json": good }, "plan restored");
  assertRefusal(ctx.run(["spawn", "APP-309", "qa", "--project", "P-APP-25"]), { first: /^flow spawn: APP-309 qa is "skip" in the plan of P-APP-25$/, fix: /flow plan P-APP-25 --file <path>/ });
  assert.equal(ctx.run(["spawn", "APP-309", "review", "--project", "P-APP-25"]).status, 0);
  const record = ctx.readJson("sessions/app-309-review/record.json");
  assert.deepEqual([record.model, record.effort], ["claude-sonnet-5-5", "high"]);
});
