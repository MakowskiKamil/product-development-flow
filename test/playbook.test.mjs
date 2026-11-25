import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { assembleCard } from "../lib/cards.mjs";
import { FlowError } from "../lib/fail.mjs";
import { checkEffort, loadPlaybook, playbookDir, playbookDirs, playbookNames, resolveModel } from "../lib/playbook.mjs";
import { readLocked } from "../lib/state.mjs";
import { ROOT, assertRefusal, removeTempDir, setup } from "./helpers.mjs";

function withPlaybooks(t, configs) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-pb-")));
  for (const [name, config] of Object.entries(configs)) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, "config.json"), JSON.stringify(config));
  }
  const previous = { FLOW_PLAYBOOKS: process.env.FLOW_PLAYBOOKS, HOME: process.env.HOME };
  process.env.FLOW_PLAYBOOKS = dir;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTempDir(dir);
  });
  return dir;
}

const BASE = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/playbooks/test/config.json"), "utf8"));

// protects: config.repo "~/…" expands to the home dir
// fails_when: "~" is passed on literally and the repo is reported missing
// no_claim: expansion of "~user/…" forms (not supported)
test("repo ~ expands to the home dir", (t) => {
  const dir = withPlaybooks(t, { tilde: { ...BASE, repo: "~/scratch" } });
  fs.mkdirSync(path.join(dir, "home", "scratch"), { recursive: true });
  process.env.HOME = path.join(dir, "home");
  assert.equal(loadPlaybook("tilde").repo, path.join(dir, "home", "scratch"));
});

// protects: a missing playbook and a missing repo path are refused with what to do
// fails_when: a missing playbook crashes, or the list of playbooks is not in the fix line
// no_claim: anything about a repo that exists but is not a git repo (spawn checks that)
test("missing playbook lists playbooks; missing repo is refused", (t) => {
  const dir = withPlaybooks(t, { alpha: { ...BASE, repo: "/nonexistent/flow-repo" }, beta: BASE });
  assert.throws(
    () => loadPlaybook("gamma"),
    (error) => error instanceof FlowError && /"gamma"/.test(error.what) && error.fix === `copy or scaffold it into ${path.join(dir, "gamma")}/ (see playbooks/example/README.md), or use one of: alpha, beta`,
  );
  assert.throws(() => loadPlaybook("alpha"), (error) => error instanceof FlowError && error.what.includes("/nonexistent/flow-repo"));
});

// --- two directories: ~/.product-dev-flow/playbooks, then the repo's playbooks/ ---------

// Sets env keys for one test (undefined deletes the key) and restores them after it.
function withEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  t.after(() => apply(previous));
}

// A copy of bin/, lib/ and templates/ with its own playbooks/: the "repo's playbooks/"
// a test can fill without writing into this repo's playbooks/ (lib/playbook.mjs finds
// that folder next to itself). repoPlaybooks: { name: { "config.json": object, "x.md": text } }.
function checkout(root, repoPlaybooks) {
  const dir = path.join(root, "checkout");
  for (const sub of ["bin", "lib", "templates"]) fs.cpSync(path.join(ROOT, sub), path.join(dir, sub), { recursive: true });
  writePlaybooks(path.join(dir, "playbooks"), repoPlaybooks);
  return { dir, flow: path.join(dir, "bin", "flow.mjs"), playbooks: path.join(dir, "playbooks") };
}

function writePlaybooks(dir, playbooks) {
  for (const [name, files] of Object.entries(playbooks)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name, file), typeof content === "string" ? content : JSON.stringify(content, null, 2));
    }
  }
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function runFlow(script, args, env) {
  const result = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// protects: acceptance 1: with FLOW_PLAYBOOKS unset, a playbook under $HOME/.product-dev-flow/playbooks/<name>/ is found by init and spawn, and its text lands in the card's section 3
// fails_when: only FLOW_PLAYBOOKS or the repo's playbooks/ is searched, so init or spawn refuses the name, or the card shows "—" for the playbook
// no_claim: precedence when the name is also in the repo's playbooks/ (next test); a real claude session
test("spawn resolves a playbook from ~/.product-dev-flow/playbooks", (t) => {
  const ctx = setup(t, { home: true });
  assert.equal(ctx.env.FLOW_PLAYBOOKS, undefined);
  assert.equal(ctx.playbooks, path.join(ctx.root, ".product-dev-flow", "playbooks"));
  fs.writeFileSync(path.join(ctx.playbooks, "test", "common.md"), "Private playbook text.\n");
  ctx.init();
  const result = ctx.run(["spawn", "initiative", "I-1", "--name", "x", "--playbook", "test"]);
  assert.equal(result.status, 0, result.stderr);
  const card = fs.readFileSync(path.join(ctx.state, "sessions", "i-1", "card.md"), "utf8");
  assert.match(card, /## 3\. Playbook \(test\)\n\nPrivate playbook text\.\n/);
  assert.equal(ctx.readJson("sessions/i-1/record.json").playbook, "test");
});

// protects: acceptance 2: a name in both directories resolves to the private copy, for loadPlaybook (its repo) and for the card's section 3 (its text); the repo's own `example` is refused as a template once no private copy shadows it, with a fix that copies it under a new name, never an edit of the tracked file, also through a symlink; a marked copy under another name in the repo's playbooks/ gets the recipe's edits for its own config.json, the mark's deletion among them (PRO-39)
// fails_when: the repo's playbooks/ is searched first, so the template's config or text wins, or the repo's example loads as a playbook, the repo's template (also through a symlink) is named for editing, or a marked copy under another name in the repo's playbooks/ is sent to copy the template again instead of deleting its own mark
// no_claim: anything about the content of the real playbooks/example (the example tests below); merging files across the two copies (none is done: the first folder is the whole playbook)
test("the same name in both directories takes the private one", async (t) => {
  const ctx = setup(t, { home: true });
  const repo = checkout(ctx.root, {
    example: { "config.json": { ...BASE, template: true, repo: "/nonexistent/template-repo" }, "common.md": "Template text.\n" },
  });
  writePlaybooks(ctx.playbooks, { example: { "config.json": { ...BASE, repo: ctx.repo }, "common.md": "Private example text.\n" } });

  withEnv(t, { FLOW_PLAYBOOKS: undefined, HOME: ctx.root });
  const lib = await import(pathToFileURL(path.join(repo.dir, "lib", "playbook.mjs")));
  assert.deepEqual(lib.playbookDirs(), [ctx.playbooks, repo.playbooks]);
  assert.equal(lib.playbookDir("example"), ctx.playbooks);
  assert.equal(lib.loadPlaybook("example").repo, ctx.repo);

  assert.equal(runFlow(repo.flow, ["init", "--playbook", "example"], ctx.env).status, 0);
  const result = runFlow(repo.flow, ["spawn", "initiative", "I-1", "--name", "x"], ctx.env);
  assert.equal(result.status, 0, result.stderr);
  const card = fs.readFileSync(path.join(ctx.state, "sessions", "i-1", "card.md"), "utf8");
  assert.match(card, /## 3\. Playbook \(example\)\n\nPrivate example text\.\n/);
  assert.doesNotMatch(card, /Template text/);

  // A private folder without config.json is no playbook: the name falls through to the repo's.
  writePlaybooks(ctx.playbooks, { half: { "common.md": "Half a copy.\n" } });
  writePlaybooks(repo.playbooks, { half: { "config.json": { ...BASE, repo: ctx.repo } } });
  assert.equal(lib.playbookDir("half"), repo.playbooks);

  fs.rmSync(path.join(ctx.playbooks, "example"), { recursive: true });
  assert.equal(lib.playbookDir("example"), repo.playbooks);
  // The copy's own FlowError class: lib/ was loaded from the copy, not from this repo.
  const { FlowError: CopyFlowError } = await import(pathToFileURL(path.join(repo.dir, "lib", "fail.mjs")));
  // PRO-39: the repo's own template is never edited (tracked): scaffold it, or copy it under a new name.
  const copyTo = path.join(ctx.playbooks, "NAME");
  const fix = `copy it under a new name: mkdir -p ${ctx.playbooks} && cp -R ${path.join(repo.playbooks, "example")} ${copyTo}/, then set repo, linearWorkspaceUrl and baseBranch and delete the "template": true line in ${path.join(copyTo, "config.json")}`;
  assert.throws(() => lib.loadPlaybook("example"), (error) => error instanceof CopyFlowError && error.what === "example is a template" && error.fix === fix);

  // A marked copy inside the repo's playbooks/ under another name is the user's own: its
  // fix is the recipe's edits for its own config.json. A private `example` that is a symlink to the repo's
  // template is the template itself: never told to edit it.
  writePlaybooks(repo.playbooks, { mine: { "config.json": { ...BASE, template: true, repo: ctx.repo } } });
  assert.throws(() => lib.loadPlaybook("mine"), (error) => error instanceof CopyFlowError && error.fix === `set repo, linearWorkspaceUrl and baseBranch and delete the "template": true line in ${path.join(repo.playbooks, "mine", "config.json")}`);
  fs.symlinkSync(path.join(repo.playbooks, "example"), path.join(ctx.playbooks, "example"));
  assert.equal(lib.playbookDir("example"), ctx.playbooks);
  assert.throws(() => lib.loadPlaybook("example"), (error) => error instanceof CopyFlowError && error.fix === fix);
});

// protects: PRO-39 review: the repo's template is recognised by its config.json being the very file (device and inode), so no fix names it for editing: a private folder whose config.json is a symlink or a hard link to the template's, and the repo's playbooks/ reached through FLOW_PLAYBOOKS in another case (case-insensitive disks), all get the copy-under-a-new-name fix; and the name-taken refusal of init --repo says "is the template" for a private example symlinked to the template, but not for a marked copy under another name in the repo's playbooks/
// fails_when: the check compares folder paths (a linked config.json, or another spelling of the folder, is told to delete the template's own line), or the name-taken fix calls a copy "the template" or misses a symlinked one
// no_claim: hard links on a CI runner whose temp dir is another device (that row is skipped there); the case-spelling row on a case-sensitive disk (skipped)
test("the repo's template is known by its config.json file, not its folder path", async (t) => {
  const ctx = setup(t, { home: true });
  const repo = checkout(ctx.root, {
    example: { "config.json": { ...BASE, template: true, repo: "/nonexistent/template-repo" }, "common.md": "Template text.\n" },
    mine: { "config.json": { ...BASE, template: true, repo: ctx.repo } },
  });
  const templateConfig = path.join(repo.playbooks, "example", "config.json");
  withEnv(t, { FLOW_PLAYBOOKS: undefined, HOME: ctx.root });
  const lib = await import(pathToFileURL(path.join(repo.dir, "lib", "playbook.mjs")));
  const copyFix = `copy it under a new name: mkdir -p ${ctx.playbooks} && cp -R ${path.join(repo.playbooks, "example")} ${path.join(ctx.playbooks, "NAME")}/, then set repo, linearWorkspaceUrl and baseBranch and delete the "template": true line in ${path.join(ctx.playbooks, "NAME", "config.json")}`;
  const refusedAsTemplate = (name, fix) => assert.throws(() => lib.loadPlaybook(name), (error) => error.what === `${name} is a template` && error.fix === fix, name);

  fs.mkdirSync(path.join(ctx.playbooks, "linked"));
  fs.symlinkSync(templateConfig, path.join(ctx.playbooks, "linked", "config.json"));
  refusedAsTemplate("linked", copyFix);
  fs.mkdirSync(path.join(ctx.playbooks, "hard"));
  let hardLinked = true;
  try {
    fs.linkSync(templateConfig, path.join(ctx.playbooks, "hard", "config.json"));
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    hardLinked = false; // the temp dir is on another device: no hard link possible
  }
  if (hardLinked) refusedAsTemplate("hard", copyFix);
  else t.diagnostic("hard-link row skipped: the temp dir is on another device than the checkout");

  const upper = path.join(path.dirname(repo.playbooks), "PLAYBOOKS");
  if (fs.existsSync(upper)) {
    // A case-insensitive disk: the same folder, spelled another way.
    withEnv(t, { FLOW_PLAYBOOKS: upper });
    refusedAsTemplate("example", `copy it under a new name: mkdir -p ${upper} && cp -R ${path.join(repo.playbooks, "example")} ${path.join(upper, "NAME")}/, then set repo, linearWorkspaceUrl and baseBranch and delete the "template": true line in ${path.join(upper, "NAME", "config.json")}`);
    withEnv(t, { FLOW_PLAYBOOKS: undefined });
  } else {
    t.diagnostic("case-spelling row skipped: case-sensitive file system");
  }

  // The name-taken refusal of init --repo, through the checkout's own flow.
  fs.symlinkSync(path.join(repo.playbooks, "example"), path.join(ctx.playbooks, "example"));
  const symlinked = runFlow(repo.flow, ["init", "--playbook", "example", "--repo", ctx.repo], ctx.env);
  assert.equal(symlinked.status, 1, symlinked.stderr);
  assert.equal(symlinked.stderr.trimEnd().split("\n").at(-1), `fix: pick another name; example is the template: ${ctx.playbooks}`);
  const copy = runFlow(repo.flow, ["init", "--playbook", "mine", "--repo", ctx.repo], ctx.env);
  assert.equal(copy.status, 1, copy.stderr);
  assert.equal(copy.stderr.trimEnd().split("\n").at(-1), `fix: pick another name, or run flow init --playbook mine without --repo: ${repo.playbooks}`);
});

// protects: acceptance 3: a missing name exits 1 naming both searched directories (private first) and the fix to copy it into the private one; with FLOW_PLAYBOOKS set, that directory only
// fails_when: the message names one directory while two are searched, names the repo's when FLOW_PLAYBOOKS replaces both, or the exit code is not 1
// no_claim: the list of names in the fix line beyond containing the test playbook (the repo's playbooks/ changes over time)
test("a missing playbook names every searched directory", (t) => {
  const home = setup(t, { home: true });
  home.init();
  const repoPlaybooks = path.join(ROOT, "playbooks");
  assertRefusal(home.run(["spawn", "initiative", "I-1", "--name", "x", "--playbook", "nope"]), {
    first: new RegExp(`^flow spawn: playbook "nope" not found in ${escape(home.playbooks)} or ${escape(repoPlaybooks)}$`),
    fix: new RegExp(`^fix: copy or scaffold it into ${escape(path.join(home.playbooks, "nope"))}/ \\(see playbooks/example/README\\.md\\), or use one of: (.*, )?test(, .*)?$`),
  });

  const single = setup(t);
  single.init();
  assertRefusal(single.run(["spawn", "initiative", "I-1", "--name", "x", "--playbook", "nope"]), {
    first: new RegExp(`^flow spawn: playbook "nope" not found in ${escape(single.playbooks)}$`),
    fix: new RegExp(`^fix: copy or scaffold it into ${escape(path.join(single.playbooks, "nope"))}/ \\(see playbooks/example/README\\.md\\), or use one of: test$`),
  });
});

// protects: acceptance 4: playbookNames() is the union of both directories, sorted, a name in both listed once, folders without config.json left out
// fails_when: only one directory is listed, a shared name appears twice, the order is not sorted, or a folder without config.json counts
// no_claim: which directory a shared name resolves to (the precedence test)
test("playbookNames lists both directories once each, sorted", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-pb-")));
  t.after(() => removeTempDir(root));
  // The private names sort after the repo's, so the union in search order (private first)
  // is out of order: only a real sort yields the expected list.
  const repo = checkout(root, { alpha: { "config.json": BASE }, shared: { "config.json": BASE }, notes: { "README.md": "no config" } });
  writePlaybooks(path.join(root, ".product-dev-flow", "playbooks"), { zeta: { "config.json": BASE }, mid: { "config.json": BASE }, shared: { "config.json": BASE } });
  withEnv(t, { FLOW_PLAYBOOKS: undefined, HOME: root });
  const lib = await import(pathToFileURL(path.join(repo.dir, "lib", "playbook.mjs")));
  assert.deepEqual(lib.playbookNames(), ["alpha", "mid", "shared", "zeta"]);
});

// protects: a playbook name is one folder name exactly as listed, as before two directories: a path ("../x", "./alpha", "alpha/") or another case ("ALPHA") is not found, so no config outside the playbooks directories loads and the template check cannot be sidestepped
// fails_when: the name is joined onto the directory and any existing path is accepted
// no_claim: which characters a new playbook name may use (any folder name is listed as it is)
test("a playbook name is a listed folder name, not a path", (t) => {
  const dir = withPlaybooks(t, { alpha: BASE });
  fs.mkdirSync(path.join(dir, "..", `${path.basename(dir)}-outside`));
  t.after(() => removeTempDir(path.join(dir, "..", `${path.basename(dir)}-outside`)));
  fs.writeFileSync(path.join(dir, "..", `${path.basename(dir)}-outside`, "config.json"), JSON.stringify(BASE));
  for (const name of [`../${path.basename(dir)}-outside`, "./alpha", "alpha/", "ALPHA"]) {
    assert.throws(() => loadPlaybook(name), (error) => error instanceof FlowError && error.what.startsWith(`playbook ${JSON.stringify(name)} not found in`), name);
  }
  assert.equal(playbookDir("alpha"), dir);
});

// protects: a playbooks directory that exists but cannot be listed fails in the fail(what, fix) shape naming it (Eng review E7)
// fails_when: the raw EACCES escapes as an unexpected error, or the directory is skipped as if empty
// no_claim: other read errors than a permission refusal; running as root (skipped: root reads it anyway)
test("an unreadable playbooks directory is refused naming it", { skip: process.getuid?.() === 0 && "root reads a 0o000 directory" }, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-pb-")));
  const dir = path.join(root, ".product-dev-flow", "playbooks");
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o000);
  t.after(() => {
    fs.chmodSync(dir, 0o755);
    removeTempDir(root);
  });
  withEnv(t, { FLOW_PLAYBOOKS: undefined, HOME: root });
  assert.throws(
    () => playbookNames(),
    (error) => error instanceof FlowError && error.what === `cannot read playbooks directory ${dir} (EACCES)` && error.fix === `fix its permissions or point FLOW_PLAYBOOKS elsewhere: ${dir}`,
  );
});

// protects: under node --test with FLOW_PLAYBOOKS unset, playbookDirs() refuses a HOME outside the temp dir, so no test reads the real ~/.product-dev-flow/playbooks (Eng rerun R3); a temp HOME is accepted
// fails_when: a test without FLOW_PLAYBOOKS silently searches the real home, or a temp HOME is refused
// no_claim: real use (NODE_TEST_CONTEXT unset), where any HOME is accepted
test("under node --test a HOME outside the temp dir is refused", (t) => {
  assert.ok(process.env.NODE_TEST_CONTEXT, "runs under node --test");
  withEnv(t, { FLOW_PLAYBOOKS: undefined, HOME: path.parse(os.tmpdir()).root });
  assert.throws(
    () => playbookDirs(),
    (error) => error instanceof FlowError && error.what === "running under node --test with HOME outside the temp dir and no FLOW_PLAYBOOKS" && error.fix === "set FLOW_PLAYBOOKS or HOME to a temp path (see test/helpers.mjs)",
  );
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-home-")));
  t.after(() => removeTempDir(home));
  process.env.HOME = home;
  assert.deepEqual(playbookDirs(), [path.join(home, ".product-dev-flow", "playbooks"), path.join(ROOT, "playbooks")]);
});

// protects: a card whose playbook is in no searched directory still renders, with section 3 as "—" (today's tolerance kept inside assembleCard)
// fails_when: assembleCard throws or renders a path for a playbook that resolves nowhere
// no_claim: flow refresh, which still refuses such a record through loadPlaybook (unchanged)
test("a card for a playbook in no directory shows — in section 3", (t) => {
  const ctx = setup(t);
  ctx.init();
  assert.equal(ctx.run(["spawn", "initiative", "I-1", "--name", "x"]).status, 0);
  withEnv(t, { FLOW_STATE: ctx.state, FLOW_ROLES: ctx.roles, FLOW_PLAYBOOKS: ctx.playbooks });
  const record = { ...ctx.readJson("sessions/i-1/record.json"), playbook: "gone" };
  const card = readLocked("test", (state) => assembleCard(state, record, { ...BASE, name: "gone" }));
  assert.match(card, /## 3\. Playbook \(gone\)\n\n—\n/);
});

// protects: --model takes a key of models or a full claude- id; --effort one of five levels
// fails_when: an unknown key passes through to claude, or a valid level is refused
// no_claim: that claude accepts every id that starts with claude-
test("model keys, full ids and efforts", () => {
  const config = { name: "test", models: BASE.models };
  assert.equal(resolveModel(config, "opus"), "claude-opus-5-5");
  assert.equal(resolveModel(config, "claude-fable-5-1"), "claude-fable-5-1");
  assert.throws(() => resolveModel(config, "opsu"), (error) => error instanceof FlowError && error.what.includes('"opsu"'));
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) assert.equal(checkEffort(effort), effort);
  assert.throws(() => checkEffort("huge"), FlowError);
});

const EXAMPLE = path.join(ROOT, "playbooks", "example");

// protects: the example config is complete and loads: the spec's placeholder values, every required key, four models, opus/high for all six roles; with "template" removed and repo pointed at a scratch repo it loads through loadPlaybook, and with "template" kept it is refused as a template (by its key, wherever the folder sits), the fix naming that copy's config.json and the line to delete (PRO-39)
// fails_when: a key, a model or a role default is missing or drifts from the spec, the template mark is gone, or a copy that still carries the mark loads or is sent to flow init --repo (refused again) instead of its own config.json
// no_claim: that the model ids are available to every account
test("example config is complete and loads", (t) => {
  const config = JSON.parse(fs.readFileSync(path.join(EXAMPLE, "config.json"), "utf8"));
  assert.equal(config.template, true);
  assert.equal(config.repo, "~/src/your-repo");
  assert.equal(config.baseBranch, "main");
  assert.equal(config.linearWorkspaceUrl, "https://linear.app/your-workspace");
  assert.equal(config.permissionMode, "auto");
  assert.deepEqual(Object.keys(config.models).sort(), ["fable", "haiku", "opus", "sonnet"]);
  for (const id of Object.values(config.models)) assert.match(id, /^claude-[a-z]+-\d+-\d+$/);
  assert.deepEqual(config.defaults, Object.fromEntries(["initiative", "project", "hygiene", "build", "review", "qa"].map((role) => [role, ["opus", "high"]])));

  const ctx = setup(t);
  const { template, ...copy } = config;
  const dir = withPlaybooks(t, { mine: { ...copy, repo: ctx.repo }, marked: { ...config, repo: ctx.repo } });
  const loaded = loadPlaybook("mine");
  assert.equal(loaded.repo, ctx.repo);
  assert.equal(loaded.name, "mine");
  // PRO-39: a copy gets the recipe's edits for its own config.json; flow init --repo would be refused again.
  const fix = `set repo, linearWorkspaceUrl and baseBranch and delete the "template": true line in ${path.join(dir, "marked", "config.json")}`;
  assert.throws(() => loadPlaybook("marked"), (error) => error instanceof FlowError && error.what === "marked is a template" && error.fix === fix);
});

// protects: the example names no real repo, person or workspace: no GitHub URL, no Linear URL but the placeholders, no home-folder path, and every file the README describes exists
// fails_when: a real owner, repo, workspace or local path is written into the template a stranger copies, or a file the README lists is missing
// no_claim: the owner's private terms (the private-terms guard checks those, never this test, which must not hold them)
test("the example carries only placeholders", () => {
  const files = fs.readdirSync(EXAMPLE).sort();
  assert.deepEqual(files, ["README.md", "build.md", "common.md", "config.json", "hygiene.md", "initiative.md", "project.md", "qa.md", "review.md"]);
  for (const file of files) {
    const text = fs.readFileSync(path.join(EXAMPLE, file), "utf8");
    assert.doesNotMatch(text, /github\.com\//i, `${file} names a GitHub URL`);
    for (const [url] of text.matchAll(/linear\.app\/[^\s`)"]*/g)) assert.match(url, /^linear\.app\/(your-workspace|<your-workspace>)$/, `${file}: ${url}`);
    assert.doesNotMatch(text, /\/Users\/|\/home\/|~\/Developer/, `${file} names a local path`);
  }
});
