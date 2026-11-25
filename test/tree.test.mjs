import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { treeLines } from "../lib/tree.mjs";
import { ROOT, assertRefusal, setup } from "./helpers.mjs";

const EXPECTED = path.join(ROOT, "test", "fixtures", "tree");

// A record as flow spawn writes it, with the fields the tree reads overridden.
function record(fields) {
  return {
    jobId: "00000000",
    sessionId: `session-${fields.slug}`,
    parentSlug: null,
    parentName: null,
    initiative: null,
    project: null,
    issue: null,
    model: "claude-opus-5-5",
    effort: "high",
    playbook: "test",
    worktree: fields.slug,
    branch: null,
    pr: null,
    status: "running",
    orphanAlertedAt: null,
    cleanedAt: null,
    createdAt: "2026-10-26T09:00:00Z",
    ...fields,
  };
}

// One state with every case the tree has to show: an initiative with a project and
// issue sessions (PR, waits, done), a second initiative with no sessions (I-10 sorts
// after I-9), a project without an initiative whose coordinator is archived (its open
// child is ORPHAN, its archived child is not), a child whose parent record is missing,
// hygiene with a child, and a record whose project folder does not exist.
function seedFixture(ctx) {
  const files = {
    "initiatives/I-9/initiative.json": { id: "I-9", name: "Imports and feeds", slug: "i-9", playbook: "test" },
    "initiatives/I-10/initiative.json": { id: "I-10", name: "Reporting", slug: "i-10", playbook: "test" },
    "projects/P-APP-25/project.json": { id: "P-APP-25", name: "Catalog import", initiative: "I-9", phase: "running", playbook: "test", slug: "p-app-25" },
    "projects/P-APP-25/plan.json": {
      project: "P-APP-25",
      issues: [
        { id: "APP-306", title: "Feed reader any format", build: { model: "opus", effort: "high" }, review: "skip", qa: "skip", merge: "self" },
        { id: "APP-309", title: "Importer block", waits: ["APP-306 merged", "owner go"], build: { model: "opus", effort: "medium" }, review: { model: "opus", effort: "high" }, qa: "skip", merge: "owner" },
      ],
    },
    "projects/P-APP-30/project.json": { id: "P-APP-30", name: "Close page", initiative: null, phase: "spec", playbook: "test", slug: "p-app-30" },
    "projects/P-APP-30/plan.json": { project: "P-APP-30", issues: [] },
    "projects/H/project.json": { id: "H", name: "Hygiene", initiative: null, phase: "running", playbook: "test", slug: "hygiene" },
    "projects/H/plan.json": { project: "H", issues: [{ id: "APP-371", title: "Offsite test cleanup", waits: ["none"], build: { model: "sonnet", effort: "low" }, review: "skip", qa: "skip", merge: "self" }] },
  };
  const records = [
    record({ slug: "i-9", name: "(I)·Imports and feeds I-9", role: "initiative", initiative: "I-9", model: "claude-fable-5-1" }),
    record({ slug: "p-app-25", name: "(P) I-9·Catalog import P-APP-25", role: "project", initiative: "I-9", project: "P-APP-25", parentSlug: "i-9", model: "claude-fable-5-1" }),
    record({ slug: "app-309-review", name: "I-9·P-APP-25·APP-309 Importer block·review", role: "review", initiative: "I-9", project: "P-APP-25", issue: "APP-309", parentSlug: "p-app-25", createdAt: "2026-10-26T11:00:00Z" }),
    record({ slug: "app-309-build", name: "I-9·P-APP-25·APP-309 Importer block", role: "build", initiative: "I-9", project: "P-APP-25", issue: "APP-309", parentSlug: "p-app-25", effort: "medium", pr: 301, createdAt: "2026-10-26T10:00:00Z" }),
    record({ slug: "app-306-build", name: "I-9·P-APP-25·APP-306 Feed reader any format", role: "build", initiative: "I-9", project: "P-APP-25", issue: "APP-306", parentSlug: "p-app-25", status: "done", pr: 296, branch: "dev/app-306" }),
    record({ slug: "p-app-30", name: "(P) Close page P-APP-30", role: "project", project: "P-APP-30", status: "archived", model: "claude-fable-5-1" }),
    record({ slug: "app-400-build", name: "P-APP-30·APP-400 Close lock", role: "build", project: "P-APP-30", issue: "APP-400", parentSlug: "p-app-30" }),
    record({ slug: "app-401-build", name: "P-APP-30·APP-401 Close rulings", role: "build", project: "P-APP-30", issue: "APP-401", parentSlug: "p-app-30", status: "archived" }),
    record({ slug: "app-402-qa", name: "P-APP-30·APP-402 Close export·qa", role: "qa", project: "P-APP-30", issue: "APP-402", parentSlug: "p-app-30-7" }),
    record({ slug: "hygiene", name: "(H)·Hygiene", role: "hygiene", project: "H" }),
    record({ slug: "app-371-build", name: "H·APP-371 Offsite test cleanup", role: "build", project: "H", issue: "APP-371", parentSlug: "hygiene", model: "claude-sonnet-5-5", effort: "low" }),
    record({ slug: "app-500-build", name: "P-APP-99·APP-500 Lost", role: "build", project: "P-APP-99", issue: "APP-500", parentSlug: "p-app-99" }),
  ];
  for (const item of records) files[`sessions/${item.slug}/record.json`] = item;
  ctx.seed(files, "fixture");
}

function expected(name) {
  return fs.readFileSync(path.join(EXPECTED, name), "utf8");
}

// protects: flow tree prints initiative → project (phase) → sessions with role, model, effort, status, PR and waits, in a fixed order, archived sessions left out
// fails_when: the text differs from test/fixtures/tree/expected.txt in any character (grouping, order, a field, the hidden count)
// no_claim: that the layout reads well in a narrow terminal; that waits are true (they are shown, never evaluated)
test("flow tree matches the checked-in text for the fixture state", (t) => {
  const ctx = setup(t);
  ctx.init();
  seedFixture(ctx);
  const result = ctx.run(["tree"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, expected("expected.txt"));
});

// protects: --all adds the archived sessions, in their place; an open child of an archived or missing parent is ORPHAN, an archived child is not
// fails_when: the text differs from test/fixtures/tree/expected-all.txt, or ORPHAN is missing / shown on an archived record
// no_claim: that the keeper's ORPHAN log line is written (PRO-5)
test("flow tree --all adds archived sessions and keeps ORPHAN on open children only", (t) => {
  const ctx = setup(t);
  ctx.init();
  seedFixture(ctx);
  const result = ctx.run(["tree", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, expected("expected-all.txt"));
  const orphans = result.stdout.split("\n").filter((line) => line.includes("ORPHAN"));
  assert.deepEqual(orphans.map((line) => line.trim().split(" — ")[0]), ["P-APP-30·APP-400 Close lock", "P-APP-30·APP-402 Close export·qa", "P-APP-99·APP-500 Lost"]);
  // The default view shows the same ORPHAN lines: the marker does not depend on --all.
  const plain = ctx.run(["tree"]).stdout.split("\n").filter((line) => line.includes("ORPHAN"));
  assert.deepEqual(plain, orphans);
});

// A real writer that fails: under the lock it writes a session folder, says it is ready,
// holds for holdMs, then throws, so transact rolls the state dir back (git reset + clean).
function startFailingWriter(ctx, holdMs) {
  const ready = path.join(ctx.root, "writer-ready");
  const script = path.join(ctx.root, "failing-writer.mjs");
  fs.writeFileSync(
    script,
    [
      `import fs from "node:fs";`,
      `import { sleepMs, transact } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "lib", "state.mjs")).href)};`,
      `try {`,
      `  transact("test failing writer", (ctx) => {`,
      `    ctx.writeJson("sessions/ghost-build/record.json", { slug: "ghost-build", name: "GHOST rolled back", role: "build", project: "P-APP-25", issue: "APP-999", status: "running" });`,
      `    ctx.writeText("sessions/ghost-build/card.md", "ghost");`,
      `    fs.writeFileSync(${JSON.stringify(ready)}, "");`,
      `    sleepMs(${holdMs});`,
      `    throw new Error("writer fails on purpose");`,
      `  });`,
      `} catch (error) {`,
      `  if (error.message !== "writer fails on purpose") throw error;`,
      `}`,
    ].join("\n"),
  );
  const child = spawn(process.execPath, [script], { env: ctx.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("close", (status) => resolve({ status, stderr })));
  return { ready, exited };
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} did not appear within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// protects: PRO-8: flow tree's read, started while another command is mid-write and then rolls back, waits for the lock and returns the state as the rollback left it; it commits nothing and leaves no lock behind
// fails_when: the read runs without the lock (it returns the GHOST session the writer never kept, or throws ENOENT), writes to the state dir, or leaves .lock behind
// no_claim: the random interleavings of the original race (shown by the stress run in the PR, not here); the CLI wrapper (the other tests run it); that a writer holding the lock past 45 s lets tree through (it is refused like any command)
test("flow tree waits for a writer that rolls back and shows the state it left", async (t) => {
  const ctx = setup(t);
  ctx.init();
  seedFixture(ctx);
  const before = ctx.commits();
  const writer = startFailingWriter(ctx, 3000);
  await waitForFile(writer.ready, 30_000);
  // In-process, called the moment the writer is ready: a `flow tree` child would spend
  // its node start-up inside the hold, and on a busy machine start-up can outlast it.
  process.env.FLOW_STATE = ctx.state;
  t.after(() => delete process.env.FLOW_STATE);
  const lines = treeLines();
  const writerResult = await writer.exited;
  assert.equal(writerResult.status, 0, writerResult.stderr);
  const text = `${lines.join("\n")}\n`;
  assert.doesNotMatch(text, /GHOST/);
  assert.equal(text, expected("expected.txt"));
  assert.deepEqual(ctx.commits(), before);
  assert.equal(ctx.untracked(), "");
  assert.equal(fs.existsSync(path.join(ctx.state, ".lock")), false);
});

// protects: an empty state says so; an unexpected argument and a missing state dir are refused with the d5 shape
// fails_when: empty output, exit 0 on a stray argument, or a stack trace without state dir
// no_claim: —
test("flow tree on an empty state, with a stray argument, and without a state dir", (t) => {
  const ctx = setup(t);
  assertRefusal(ctx.run(["tree"]), { first: /^flow tree: state dir .* is not set up$/, fix: /flow init/ });
  ctx.init();
  const empty = ctx.run(["tree"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, "no initiatives, projects or sessions yet\n");
  assertRefusal(ctx.run(["tree", "P-APP-25"]), { first: /^flow tree: unexpected argument "P-APP-25"$/ });
  assertRefusal(ctx.run(["tree", "--deep"]), { first: /^flow tree: .*--deep/ });
});
