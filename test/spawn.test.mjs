import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { FIXED_NOW, FLOW, archive, assertRefusal, gitIn, setup } from "./helpers.mjs";

function spawnInitiative(ctx, id = "I-9", name = "Imports and feeds") {
  const result = ctx.run(["spawn", "initiative", id, "--name", name]);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function spawnProject(ctx, extra = ["--initiative", "I-9"], id = "P-APP-25", name = "Catalog import") {
  const result = ctx.run(["spawn", "project", id, "--name", name, ...extra]);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

// A plan written by hand, with the project moved to running so issue sessions may start
// (flow plan and flow phase have their own tests in plan.test.mjs).
function seedPlan(ctx, project = "P-APP-25", issues = [{ id: "APP-309", title: "Importer block", build: { model: "opus", effort: "medium" }, review: { model: "sonnet", effort: "xhigh" }, qa: "skip", merge: "self" }]) {
  const meta = ctx.readJson(`projects/${project}/project.json`);
  ctx.seed({ [`projects/${project}/plan.json`]: { project, issues }, [`projects/${project}/project.json`]: { ...meta, phase: "running" } }, `plan ${project}`);
}

function bgCalls(ctx) {
  return ctx.fakeCalls().filter((call) => call.argv[0] === "--bg");
}

// protects: flow spawn passes claude exactly the spec's argv, in order, with cwd = the playbook's repo
// fails_when: any flag, value or position differs, or the prompt/system prompt is not the rendered one
// no_claim: that real claude accepts these flags (live smoke)
test("spawn initiative passes exactly the spec argv", (t) => {
  const ctx = setup(t);
  ctx.init();
  spawnInitiative(ctx);
  const [call] = bgCalls(ctx);
  const name = "(I)·Imports and feeds I-9";
  const card = path.join(ctx.state, "sessions", "i-9", "card.md");
  const expected = [
    "--bg",
    "-w", "i-9",
    "-n", name,
    "--remote-control", name,
    "--permission-mode", "auto",
    "--model", "claude-opus-5-5",
    "--effort", "high",
    "--append-system-prompt",
    [
      `1. You are \`${name}\`, role \`initiative\`, for \`I-9 › —\`.`,
      `2. Read your card at \`${card}\` before anything else; re-read it after a compaction and whenever a message starts \`Card updated:\`.`,
      "3. Ask the owner in your own conversation, and send a push notification `I-9: <one line>` with every question. A project session may send FYI to its initiative session.",
      "4. Answer a child by `SendMessage` to its name. After `flow note`, `flow plan` or `flow refresh`, send `Card updated: <one line>` to each name it printed.",
    ].join("\n"),
    `Read your card at ${card} and begin.`,
  ];
  assert.equal(call.argv.length, expected.length);
  expected.forEach((value, index) => assert.equal(call.argv[index], value, `argv[${index}]`));
  assert.equal(call.cwd, ctx.repo);
});

// protects: the record holds the parsed jobId and the sessionId from the job's state.json, and the spawn is one commit
// fails_when: jobId/sessionId come from anywhere else, a field is missing, or the spawn makes 0 or 2+ commits
// no_claim: that the session is alive afterwards (the keeper's job)
test("spawn writes the record from the job and commits once", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = spawnInitiative(ctx);
  const [call] = bgCalls(ctx);
  const record = ctx.readJson("sessions/i-9/record.json");
  const jobState = JSON.parse(fs.readFileSync(path.join(ctx.claudeHome, "jobs", call.jobId, "state.json"), "utf8"));
  assert.deepEqual(record, {
    slug: "i-9",
    jobId: call.jobId,
    sessionId: jobState.sessionId,
    name: "(I)·Imports and feeds I-9",
    role: "initiative",
    parentSlug: null,
    parentName: null,
    initiative: "I-9",
    project: null,
    issue: null,
    model: "claude-opus-5-5",
    effort: "high",
    playbook: "test",
    worktree: "i-9",
    branch: null,
    pr: null,
    status: "running",
    orphanAlertedAt: null,
    cleanedAt: null,
    createdAt: FIXED_NOW,
  });
  assert.deepEqual(ctx.commits(), ["spawn i-9: (I)·Imports and feeds I-9", "flow init --playbook test"]);
  assert.equal(ctx.untracked(), "");
  assert.deepEqual(ctx.readJson("initiatives/I-9/initiative.json"), { id: "I-9", name: "Imports and feeds", slug: "i-9", playbook: "test" });
  assert.ok(fs.existsSync(path.join(ctx.state, "initiatives/I-9/notes.md")));
  assert.match(fs.readFileSync(path.join(ctx.state, "sessions/i-9/card.md"), "utf8"), /^- Role: initiative$/m);
  assert.match(result.stdout, new RegExp(`job: ${call.jobId} \\(session ${jobState.sessionId}\\)`));
});

// protects: a spawn succeeds when the job's state.json does not list its worktree yet (as real claude does at first)
// fails_when: every real spawn fails with "has no string worktreePath" (seen in the live smoke before this fix)
// no_claim: the worktree claude creates later (not checked at spawn time)
test("spawn succeeds before claude writes worktreePath", (t) => {
  const ctx = setup(t);
  ctx.init();
  const result = ctx.run(["spawn", "initiative", "I-1", "--name", "A"], { FAKE_CLAUDE_LATE_WORKTREE: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ctx.readJson("sessions/i-1/record.json").jobId, bgCalls(ctx)[0].jobId);
});

// protects: a project under an initiative gets phase intake, an empty plan, the initiative as parent and the spec name
// fails_when: the parent is not the initiative's live record, the phase is not intake, or the plan is not empty
// no_claim: phase moves (plan.test.mjs)
test("spawn project under an initiative", (t) => {
  const ctx = setup(t);
  ctx.init();
  spawnInitiative(ctx);
  spawnProject(ctx);
  const record = ctx.readJson("sessions/p-app-25/record.json");
  assert.equal(record.name, "(P) I-9·Catalog import P-APP-25");
  assert.equal(record.parentSlug, "i-9");
  assert.equal(record.parentName, "(I)·Imports and feeds I-9");
  assert.equal(record.initiative, "I-9");
  assert.equal(record.project, "P-APP-25");
  assert.deepEqual(ctx.readJson("projects/P-APP-25/project.json"), { id: "P-APP-25", name: "Catalog import", initiative: "I-9", phase: "intake", playbook: "test", slug: "p-app-25" });
  assert.deepEqual(ctx.readJson("projects/P-APP-25/plan.json"), { project: "P-APP-25", issues: [] });
  const [, call] = bgCalls(ctx);
  assert.match(call.argv[14], /`I-9 › P-APP-25: <one line>`/);
});

// protects: a project without an initiative drops the "<I-id>·" part and has no parent
// fails_when: the name keeps a separator, or --initiative of a missing initiative is accepted
// no_claim: anything about the initiative's own session
test("spawn project without an initiative; unknown initiative refused", (t) => {
  const ctx = setup(t);
  ctx.init();
  assertRefusal(ctx.run(["spawn", "project", "P-APP-30", "--name", "Name", "--initiative", "I-4"]), { first: /^flow spawn: initiative I-4 does not exist$/, fix: /flow spawn initiative I-4/ });
  assert.deepEqual(ctx.commits(), ["flow init --playbook test"]);
  spawnProject(ctx, [], "P-APP-30", "Name");
  const record = ctx.readJson("sessions/p-app-30/record.json");
  assert.equal(record.name, "(P) Name P-APP-30");
  assert.equal(record.parentSlug, null);
  assert.equal(record.initiative, null);
});

// protects: hygiene gets projects/H with phase running, the (H)·Hygiene name, and only one live hygiene session
// fails_when: a second live hygiene session can start, or a re-spawn after archive does not get " 2"
// no_claim: hygiene's plan (plan.test.mjs)
test("spawn hygiene; one live hygiene; re-spawn after archive", (t) => {
  const ctx = setup(t);
  ctx.init();
  assert.equal(ctx.run(["spawn", "hygiene"]).status, 0);
  assert.deepEqual(ctx.readJson("projects/H/project.json"), { id: "H", name: "Hygiene", initiative: null, phase: "running", playbook: "test", slug: "hygiene" });
  const record = ctx.readJson("sessions/hygiene/record.json");
  assert.equal(record.name, "(H)·Hygiene");
  assert.equal(record.model, "claude-sonnet-5-5");
  assert.equal(record.effort, "medium");
  assertRefusal(ctx.run(["spawn", "hygiene"]), { first: /^flow spawn: hygiene H already has a session: "\(H\)·Hygiene" \(hygiene, running\)$/, fix: /flow archive hygiene/ });
  archive(ctx, "hygiene");
  assert.equal(ctx.run(["spawn", "hygiene"]).status, 0);
  assert.equal(ctx.readJson("sessions/hygiene-2/record.json").name, "(H)·Hygiene 2");
});

// protects: an issue session takes title, model and effort from its plan entry and its project's record as parent
// fails_when: the name, slug, parent, model or effort differ from the plan and spec patterns
// no_claim: the phase/skip gate (plan.test.mjs)
test("spawn issue sessions from the plan", (t) => {
  const ctx = setup(t);
  ctx.init();
  spawnInitiative(ctx);
  spawnProject(ctx);
  seedPlan(ctx);
  assert.equal(ctx.run(["spawn", "APP-309", "build", "--project", "P-APP-25"]).status, 0);
  const build = ctx.readJson("sessions/app-309-build/record.json");
  assert.equal(build.name, "I-9·P-APP-25·APP-309 Importer block");
  assert.equal(build.role, "build");
  assert.equal(build.parentSlug, "p-app-25");
  assert.equal(build.parentName, "(P) I-9·Catalog import P-APP-25");
  assert.equal(build.issue, "APP-309");
  assert.equal(build.model, "claude-opus-5-5");
  assert.equal(build.effort, "medium");

  assert.equal(ctx.run(["spawn", "APP-309", "review", "--project", "P-APP-25"]).status, 0);
  const review = ctx.readJson("sessions/app-309-review/record.json");
  assert.equal(review.name, "I-9·P-APP-25·APP-309 Importer block·review");
  assert.equal(review.model, "claude-sonnet-5-5");
  assert.equal(review.effort, "xhigh");

  const call = bgCalls(ctx).at(-1);
  assert.equal(call.argv[2], "app-309-review");
  assert.match(call.argv[14], /^1\. You are `I-9·P-APP-25·APP-309 Importer block·review`, role `review`, working on `APP-309 Importer block` in `I-9 › P-APP-25`\. Your parent is `\(P\) I-9·Catalog import P-APP-25`\.$/m);
  const card = fs.readFileSync(path.join(ctx.state, "sessions/app-309-review/card.md"), "utf8");
  assert.match(card, /Linear issue: https:\/\/linear\.app\/example-workspace\/issue\/APP-309/);
});

// protects: --model and --effort override independently; the other value still comes from the plan, then the playbook
// fails_when: overriding one resets the other to the default, or a plan step without model falls back wrongly
// no_claim: validation of plan entries (plan.test.mjs)
test("--model and --effort override independently", (t) => {
  const ctx = setup(t);
  ctx.init();
  spawnProject(ctx, [], "P-APP-30", "Name");
  seedPlan(ctx, "P-APP-30", [{ id: "APP-400", title: "Title", build: { model: "sonnet", effort: "low" }, merge: "owner" }]);
  assert.equal(ctx.run(["spawn", "APP-400", "build", "--project", "P-APP-30", "--model", "haiku"]).status, 0);
  const one = ctx.readJson("sessions/app-400-build/record.json");
  assert.deepEqual([one.model, one.effort, one.name], ["claude-haiku-5-5", "low", "P-APP-30·APP-400 Title"]);
  assert.equal(ctx.run(["spawn", "APP-400", "build", "--project", "P-APP-30", "--effort", "max", "--again"]).status, 0);
  const two = ctx.readJson("sessions/app-400-build-2/record.json");
  assert.deepEqual([two.model, two.effort], ["claude-sonnet-5-5", "max"]);
  assert.equal(ctx.run(["spawn", "APP-400", "qa", "--project", "P-APP-30"]).status, 0);
  const qa = ctx.readJson("sessions/app-400-qa/record.json");
  assert.deepEqual([qa.model, qa.effort], ["claude-haiku-5-5", "low"]);
  assertRefusal(ctx.run(["spawn", "APP-400", "qa", "--project", "P-APP-30", "--model", "gpt", "--again"]), { first: /model "gpt"/, fix: /opus, sonnet, haiku/ });
  assertRefusal(ctx.run(["spawn", "APP-400", "qa", "--project", "P-APP-30", "--effort", "huge", "--again"]), { first: /effort "huge"/ });
});

// protects: a held slug is refused without --again; --again twice gives -2 then -3 with names " 2", " 3"
// fails_when: a held slug is reused, or the suffixes skip or repeat
// no_claim: which session the parent should talk to (cards say)
test("--again takes -2 then -3", (t) => {
  const ctx = setup(t);
  ctx.init();
  spawnInitiative(ctx);
  spawnProject(ctx);
  seedPlan(ctx);
  const args = ["spawn", "APP-309", "build", "--project", "P-APP-25"];
  assert.equal(ctx.run(args).status, 0);
  assertRefusal(ctx.run(args), { first: /^flow spawn: slug app-309-build is held by "I-9·P-APP-25·APP-309 Importer block" \(running\)$/, fix: /--again/ });
  archive(ctx, "app-309-build");
  assertRefusal(ctx.run(args), { first: /held by .* \(archived\)$/ });
  assert.equal(ctx.run([...args, "--again"]).status, 0);
  assert.equal(ctx.run([...args, "--again"]).status, 0);
  assert.equal(ctx.readJson("sessions/app-309-build-2/record.json").name, "I-9·P-APP-25·APP-309 Importer block 2");
  assert.equal(ctx.readJson("sessions/app-309-build-3/record.json").name, "I-9·P-APP-25·APP-309 Importer block 3");
  assert.deepEqual(bgCalls(ctx).slice(-2).map((call) => call.argv[2]), ["app-309-build-2", "app-309-build-3"]);
});

// protects: a name held by a non-archived record is refused, even under another slug
// fails_when: two live sessions could share a SendMessage address
// no_claim: names of archived records (they may repeat)
test("name collision with a non-archived record exits 1", (t) => {
  const ctx = setup(t);
  ctx.init();
  ctx.seed({
    "sessions/elsewhere/record.json": { slug: "elsewhere", name: "(I)·Clash I-5", role: "initiative", initiative: "I-77", status: "done" },
  });
  assertRefusal(ctx.run(["spawn", "initiative", "I-5", "--name", "Clash"]), { first: /^flow spawn: name "\(I\)·Clash I-5" is held by session elsewhere \(done\)$/ });
  assert.equal(bgCalls(ctx).length, 0);
  assert.equal(ctx.commits().length, 2);
  archive(ctx, "elsewhere");
  assert.equal(ctx.run(["spawn", "initiative", "I-5", "--name", "Clash"]).status, 0);
});

// protects: a coordinator re-spawn reuses the folder, takes the next suffix without --again, and refuses differing flags
// fails_when: phase/notes/plan are reset, a live coordinator is duplicated, or a differing --name/--playbook/--initiative is ignored
// no_claim: anything about what the new session reads from the old one's transcript
test("coordinator re-spawn", (t) => {
  const ctx = setup(t);
  ctx.init();
  spawnInitiative(ctx);
  spawnProject(ctx);
  assertRefusal(ctx.run(["spawn", "project", "P-APP-25"]), { first: /^flow spawn: project P-APP-25 already has a session: .*\(p-app-25, running\)$/ });
  ctx.seed({ "projects/P-APP-25/project.json": { ...ctx.readJson("projects/P-APP-25/project.json"), phase: "running" }, "projects/P-APP-25/notes.md": "- kept note\n" });
  archive(ctx, "p-app-25");
  assertRefusal(ctx.run(["spawn", "project", "P-APP-25", "--name", "Other name"]), { first: /--name "Other name" differs from the stored project name "Catalog import"/ });
  assertRefusal(ctx.run(["spawn", "project", "P-APP-25", "--initiative", "I-2"]), { first: /--initiative "I-2" differs/ });
  assertRefusal(ctx.run(["spawn", "project", "P-APP-25", "--playbook", "other"]), { first: /--playbook "other" differs/ });
  assert.equal(ctx.run(["spawn", "project", "P-APP-25"]).status, 0);
  const record = ctx.readJson("sessions/p-app-25-2/record.json");
  assert.equal(record.name, "(P) I-9·Catalog import P-APP-25 2");
  assert.equal(record.parentSlug, "i-9");
  assert.equal(ctx.readJson("projects/P-APP-25/project.json").phase, "running");
  assert.equal(fs.readFileSync(path.join(ctx.state, "projects/P-APP-25/notes.md"), "utf8"), "- kept note\n");
});

// protects: an issue spawn needs its project, a plan entry and a live parent; each refusal says what to run
// fails_when: a session starts with no title or no parent to report to
// no_claim: the phase and skip refusals (plan.test.mjs)
test("issue spawn refusals: no project, not in plan, no parent", (t) => {
  const ctx = setup(t);
  ctx.init();
  assertRefusal(ctx.run(["spawn", "APP-309", "build", "--project", "P-APP-25"]), { first: /^flow spawn: project P-APP-25 does not exist$/, fix: /flow spawn project P-APP-25/ });
  spawnProject(ctx, [], "P-APP-25", "Catalog import");
  seedPlan(ctx, "P-APP-25", [{ id: "APP-1", title: "Other", build: {}, review: "skip", qa: "skip", merge: "self" }]);
  assertRefusal(ctx.run(["spawn", "APP-309", "build", "--project", "P-APP-25"]), { first: /^flow spawn: APP-309 is not in the plan of P-APP-25$/, fix: /^fix: add APP-309 to the plan \(flow plan P-APP-25 --file <path>\)$/ });
  seedPlan(ctx);
  archive(ctx, "p-app-25");
  assertRefusal(ctx.run(["spawn", "APP-309", "build", "--project", "P-APP-25"]), { first: /^flow spawn: P-APP-25 has no running project session to be the parent of APP-309$/, fix: /flow spawn project P-APP-25/ });
  assertRefusal(ctx.run(["spawn", "APP-1", "build", "--project", "H"]), { first: /project H does not exist/, fix: /flow spawn hygiene/ });
  assert.equal(bgCalls(ctx).length, 1);
});

// protects: hygiene issue sessions are named H·<issue> <title> with the hygiene record as parent
// fails_when: a hygiene issue gets a project-style name or no parent
// no_claim: hygiene's plan workflow (plan.test.mjs)
test("hygiene issue session", (t) => {
  const ctx = setup(t);
  ctx.init();
  assert.equal(ctx.run(["spawn", "hygiene"]).status, 0);
  seedPlan(ctx, "H", [{ id: "APP-371", title: "Offsite test cleanup", build: { model: "opus", effort: "high" }, merge: "self" }]);
  assert.equal(ctx.run(["spawn", "APP-371", "build", "--project", "H"]).status, 0);
  const record = ctx.readJson("sessions/app-371-build/record.json");
  assert.equal(record.name, "H·APP-371 Offsite test cleanup");
  assert.equal(record.parentSlug, "hygiene");
  assert.equal(record.project, "H");
  assert.match(bgCalls(ctx).at(-1).argv[14], /in `— › H`/);
});

// protects: argument errors are refused before anything runs, each with a usage or fix line
// fails_when: a bad id, role, missing --name/--project or a misplaced option reaches claude
// no_claim: the complete list of option combinations
test("argument refusals", (t) => {
  const ctx = setup(t);
  ctx.init();
  assertRefusal(ctx.run(["spawn", "initiative", "I9", "--name", "x"]), { first: /^flow spawn: initiative id "I9" does not match/, fix: /I-9/ });
  assertRefusal(ctx.run(["spawn", "project", "p-app-25", "--name", "x"]), { first: /project id "p-app-25"/ });
  assertRefusal(ctx.run(["spawn", "FIN309", "build", "--project", "P-APP-25"]), { first: /issue id "FIN309"/ });
  assertRefusal(ctx.run(["spawn", "initiative", "I-9"]), { first: /^flow spawn: initiative I-9 is new and has no --name$/ });
  assertRefusal(ctx.run(["spawn", "APP-309", "deploy", "--project", "P-APP-25"]), { first: /role "deploy"/ });
  assertRefusal(ctx.run(["spawn", "APP-309", "build"]), { first: /APP-309 build has no --project/ });
  assertRefusal(ctx.run(["spawn", "initiative", "I-9", "--name", "x", "--again"]), { first: /--again is not an option of flow spawn initiative/ });
  assertRefusal(ctx.run(["spawn", "APP-309", "build", "--project", "P-1", "--playbook", "test"]), { first: /--playbook is not an option/ });
  assertRefusal(ctx.run(["spawn", "initiative", "I-9", "--name", "x", "--bogus"]), { first: /Unknown option '--bogus'/, fix: /usage: flow spawn/ });
  assertRefusal(ctx.run(["spawn", "hygiene", "extra"]), { first: /unexpected argument "extra"/ });
  assert.equal(bgCalls(ctx).length, 0);
  assert.deepEqual(ctx.commits(), ["flow init --playbook test"]);
});

// protects: the playbook comes from --playbook, else the initiative's (projects), else the state default; a missing one is refused
// fails_when: a project ignores its initiative's playbook, or a spawn runs without any playbook
// no_claim: playbooks other than the test fixture
test("playbook resolution", (t) => {
  const ctx = setup(t);
  assert.equal(ctx.run(["init"]).status, 0);
  assertRefusal(ctx.run(["spawn", "initiative", "I-1", "--name", "A"]), { first: /no playbook given and the state dir has no defaultPlaybook/, fix: /--playbook/ });
  assertRefusal(ctx.run(["spawn", "initiative", "I-1", "--name", "A", "--playbook", "zzz"]), { first: /playbook "zzz" not found/, fix: /use one of: test/ });
  fs.cpSync(path.join(ctx.playbooks, "test"), path.join(ctx.playbooks, "second"), { recursive: true });
  assert.equal(ctx.run(["spawn", "initiative", "I-1", "--name", "A", "--playbook", "second"]).status, 0);
  assert.equal(ctx.run(["spawn", "project", "P-A-1", "--name", "B", "--initiative", "I-1"]).status, 0);
  assert.equal(ctx.readJson("projects/P-A-1/project.json").playbook, "second");
  assert.equal(ctx.readJson("sessions/p-a-1/record.json").playbook, "second");
});

// protects: spawn refuses when the worktree dir or the worktree-<slug> branch already exists, or the repo is missing/not git
// fails_when: claude is started onto someone else's worktree or branch
// no_claim: worktrees of other repos
test("existing worktree, branch or bad repo is refused", (t) => {
  const ctx = setup(t);
  ctx.init();
  fs.mkdirSync(path.join(ctx.repo, ".claude", "worktrees", "i-1"), { recursive: true });
  assertRefusal(ctx.run(["spawn", "initiative", "I-1", "--name", "A"]), { first: /worktree .*\/\.claude\/worktrees\/i-1 already exists/, fix: /worktree remove/ });
  gitIn(ctx.repo, ["branch", "worktree-i-2"]);
  assertRefusal(ctx.run(["spawn", "initiative", "I-2", "--name", "B"]), { first: /branch worktree-i-2 already exists/, fix: /branch -d worktree-i-2/ });
  fs.rmSync(path.join(ctx.repo, ".git"), { recursive: true, force: true });
  assertRefusal(ctx.run(["spawn", "initiative", "I-3", "--name", "C"]), { first: /is not a git repo/ });
  fs.rmSync(ctx.repo, { recursive: true, force: true });
  assertRefusal(ctx.run(["spawn", "initiative", "I-3", "--name", "C"]), { first: /^flow spawn: repo .* of playbook test does not exist$/ });
  assert.equal(bgCalls(ctx).length, 0);
  assert.deepEqual(ctx.commits(), ["flow init --playbook test"]);
  assert.deepEqual(fs.readdirSync(ctx.state).sort(), [".git", ".gitignore", "config.json"]);
});

// protects: a relative FLOW_STATE still gives the session an absolute card path (it reads it from its own worktree)
// fails_when: "Read your card at ../state/…" reaches claude
// no_claim: symlinked state dirs (resolved as given, not realpath'd)
test("relative FLOW_STATE gives an absolute card path", (t) => {
  const ctx = setup(t);
  ctx.init();
  const relative = path.relative(process.cwd(), ctx.state);
  assert.equal(ctx.run(["spawn", "initiative", "I-1", "--name", "A"], { FLOW_STATE: relative }).status, 0);
  const [call] = bgCalls(ctx);
  assert.equal(call.argv.at(-1), `Read your card at ${path.join(ctx.state, "sessions", "i-1", "card.md")} and begin.`);
});

// protects: a sessions/<slug> folder without a record (left by a crash) holds its slug: refused without --again, skipped with it
// fails_when: a new session reuses a crashed spawn's folder and card
// no_claim: how the folder was left behind
test("crash-leftover session folder holds its slug", (t) => {
  const ctx = setup(t);
  ctx.init();
  spawnProject(ctx, [], "P-APP-30", "Name");
  seedPlan(ctx, "P-APP-30", [{ id: "APP-400", title: "Title", build: { model: "opus", effort: "high" }, merge: "self" }]);
  ctx.seed({ "sessions/app-400-build/card.md": "left by a crash\n" });
  const args = ["spawn", "APP-400", "build", "--project", "P-APP-30"];
  assertRefusal(ctx.run(args), { first: /^flow spawn: slug app-400-build is held by sessions\/app-400-build$/, fix: /--again/ });
  assert.equal(ctx.run([...args, "--again"]).status, 0);
  assert.equal(ctx.readJson("sessions/app-400-build-2/record.json").name, "P-APP-30·APP-400 Title 2");
  assert.equal(fs.readFileSync(path.join(ctx.state, "sessions/app-400-build/card.md"), "utf8"), "left by a crash\n");
});

// protects: a playbook whose repo is a subdirectory of a git repo is refused (claude -w would put worktrees elsewhere)
// fails_when: worktree checks and rollback look in <subdir>/.claude/worktrees while claude uses the top level
// no_claim: repos reached through symlinks (compared by realpath)
test("playbook repo must be the git top level", (t) => {
  const ctx = setup(t);
  ctx.init();
  const sub = path.join(ctx.repo, "sub");
  fs.mkdirSync(sub);
  const configFile = path.join(ctx.playbooks, "test", "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, "utf8")), repo: sub }));
  assertRefusal(ctx.run(["spawn", "initiative", "I-1", "--name", "A"]), { first: /is not the top of its git repo/, fix: new RegExp(`set "repo" to ${ctx.repo}`) });
  assert.equal(bgCalls(ctx).length, 0);
});

// protects: a re-spawn refusal for a flag the stored folder has no value for suggests only dropping it
// fails_when: the fix suggests --initiative "" , which is refused again
// no_claim: other flags' wording
test("stored null initiative: fix says drop the flag", (t) => {
  const ctx = setup(t);
  ctx.init();
  spawnProject(ctx, [], "P-APP-30", "Name");
  archive(ctx, "p-app-30");
  assertRefusal(ctx.run(["spawn", "project", "P-APP-30", "--initiative", "I-9"]), { first: /--initiative "I-9" differs from the stored initiative null/, fix: /^fix: drop --initiative \(the stored initiative is none\)$/ });
});

// protects: SIGINT/SIGTERM sent to flow during a spawn does not kill it halfway: the spawn completes, the lock is released
// fails_when: flow dies with the lock held, an uncommitted card, or a job without a record
// no_claim: SIGKILL (cannot be handled), and a Ctrl-C that also reaches claude (the job then fails and rolls back)
test("SIGINT during spawn: the command completes cleanly", async (t) => {
  const ctx = setup(t);
  ctx.init();
  // WHY a start file, not a fixed delay: on a loaded machine node alone can take ~1 s to start,
  // so a signal sent after a fixed 500 ms could land before flow is running at all.
  const started = path.join(ctx.state, "..", "claude-started");
  const child = spawnChild(process.execPath, [FLOW, "spawn", "initiative", "I-1", "--name", "A"], { env: { ...ctx.env, FAKE_CLAUDE_SLEEP_MS: "1500", FAKE_CLAUDE_STARTED_FILE: started } });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  t.after(() => child.kill("SIGKILL")); // a failed assertion must not leave flow running
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(started) && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(started), `fake claude never started; flow stderr:\n${stderr}`);
  assert.ok(child.kill("SIGINT"), "flow exited before SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(child.kill("SIGTERM"), "flow exited before SIGTERM");
  assert.equal(await exited, 0, stderr);
  assert.equal(fs.existsSync(path.join(ctx.state, ".lock")), false);
  assert.equal(ctx.untracked(), "");
  assert.equal(ctx.readJson("sessions/i-1/record.json").status, "running");
});

// protects: a spawn before flow init is refused with "flow init" as the fix
// fails_when: spawn creates a state dir on its own
// no_claim: anything about a half-initialised dir
test("spawn without a state dir is refused", (t) => {
  const ctx = setup(t);
  assertRefusal(ctx.run(["spawn", "hygiene", "--playbook", "test"]), { first: /state dir .* is not set up/, fix: /^fix: flow init$/ });
  assert.equal(fs.existsSync(ctx.state), false);
});
