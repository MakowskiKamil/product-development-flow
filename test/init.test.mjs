import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ROOT, assertRefusal, gitIn, setup } from "./helpers.mjs";

// protects: flow init on a missing dir creates it as a git repo with exactly one commit
// fails_when: the dir is not created, has no commit, or more than one
// no_claim: anything about the default path ~/.product-dev-flow/state (tests always use FLOW_STATE)
test("flow init creates the state dir with one commit", (t) => {
  const ctx = setup(t);
  const result = ctx.run(["init"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(ctx.commits(), ["flow init"]);
  assert.equal(ctx.untracked(), "");
  assert.equal(fs.existsSync(path.join(ctx.state, "config.json")), false);
});

// protects: the state repo ignores the lock and temp files and has its own git identity
// fails_when: .lock or *.tmp would be committed, or commits depend on a global git identity
// no_claim: behaviour with a global commit.gpgsign or hooks config (git runs with them off)
test("flow init writes .gitignore and a local identity", (t) => {
  const ctx = setup(t);
  ctx.run(["init"]);
  assert.deepEqual(fs.readFileSync(path.join(ctx.state, ".gitignore"), "utf8").trim().split("\n"), [".lock", ".lock.*", "*.tmp"]);
  assert.equal(gitIn(ctx.state, ["config", "--local", "user.name"]).trim(), "flow");
  assert.equal(gitIn(ctx.state, ["config", "--local", "user.email"]).trim(), "flow@localhost");
});

// protects: flow init --playbook stores the default playbook in <state>/config.json
// fails_when: the file is missing, has another shape, or an unknown playbook is accepted
// no_claim: that spawn uses it (spawn.test covers that)
test("flow init --playbook writes config.json and checks the playbook", (t) => {
  const ctx = setup(t);
  assertRefusal(ctx.run(["init", "--playbook", "nope"]), { first: /^flow init: playbook "nope" not found/, fix: /use one of: test/ });
  assert.equal(fs.existsSync(ctx.state), false);
  assert.equal(ctx.run(["init", "--playbook", "test"]).status, 0);
  assert.deepEqual(ctx.readJson("config.json"), { defaultPlaybook: "test" });
  assert.deepEqual(ctx.commits(), ["flow init --playbook test"]);
});

// protects: flow init never touches an existing dir
// fails_when: it exits 0, or changes anything in the existing dir
// no_claim: anything about a dir that exists but is unreadable
test("flow init on an existing dir exits 1 and changes nothing", (t) => {
  const ctx = setup(t);
  fs.mkdirSync(ctx.state);
  fs.writeFileSync(path.join(ctx.state, "keep.txt"), "mine");
  assertRefusal(ctx.run(["init"]), { first: /^flow init: state dir .* already exists$/ });
  assert.deepEqual(fs.readdirSync(ctx.state), ["keep.txt"]);

  const other = setup(t);
  other.init();
  assertRefusal(other.run(["init"]), { first: /already exists/ });
  assert.deepEqual(other.commits(), ["flow init --playbook test"]);
});

// --- flow init --playbook <name> --repo <path>: a playbook scaffolded from playbooks/example ---

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EXAMPLE = path.join(ROOT, "playbooks", "example");

// Nothing of a refused scaffold is on disk: no state dir, no <name> folder.
function assertNothingWritten(ctx, name) {
  assert.equal(fs.existsSync(ctx.state), false, "state dir was created");
  assert.equal(fs.existsSync(path.join(ctx.playbooks, name)), false, `${name} was scaffolded`);
}

// protects: acceptance 3: with FLOW_PLAYBOOKS unset and a temp HOME, init --repo copies the repo's playbooks/example to $HOME/.product-dev-flow/playbooks/<name>/ with the repo path (resolved, absolute), the --linear URL and --base set and "template" stripped, creates the state dir with <name> as default playbook, prints the directory and the three next-step lines, and a spawn then runs on it with the fake claude
// fails_when: a file of the example is missing from the copy, a config value is the placeholder or as typed (relative), the template key survives so spawn refuses it, the state dir has another default, or a next-step line is missing
// no_claim: that the printed ln -s and settings lines work on the reader's machine (README, QA); a real claude session
test("flow init --repo scaffolds a playbook from the example and spawn runs on it", (t) => {
  const ctx = setup(t, { home: true });
  const relative = path.relative(process.cwd(), ctx.repo);
  const result = ctx.run(["init", "--playbook", "demo", "--repo", relative, "--linear", "https://linear.app/acme", "--base", "trunk"]);
  assert.equal(result.status, 0, result.stderr);
  const dir = path.join(ctx.playbooks, "demo");
  assert.deepEqual(fs.readdirSync(dir).sort(), fs.readdirSync(EXAMPLE).sort());
  const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  const { template, ...rest } = JSON.parse(fs.readFileSync(path.join(EXAMPLE, "config.json"), "utf8"));
  assert.equal(template, true);
  assert.deepEqual(config, { ...rest, repo: ctx.repo, linearWorkspaceUrl: "https://linear.app/acme", baseBranch: "trunk" });
  assert.equal(fs.readFileSync(path.join(dir, "common.md"), "utf8"), fs.readFileSync(path.join(EXAMPLE, "common.md"), "utf8"));
  assert.deepEqual(ctx.readJson("config.json"), { defaultPlaybook: "demo" });

  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines[0], `created playbook ${dir}`);
  assert.match(result.stdout, /ln -s \S+bin\/flow\.mjs/);
  assert.match(result.stdout, new RegExp(`ln -s ${escape(path.join(ROOT, "bin", "flow.mjs"))} ~/\\.local/bin/flow$`, "m"));
  assert.match(result.stdout, /Bash\(flow:\*\)/);
  assert.match(result.stdout, /flow spawn initiative/);
  assert.doesNotMatch(result.stdout, /linearWorkspaceUrl/);

  const spawned = ctx.run(["spawn", "initiative", "I-1", "--name", "x"]);
  assert.equal(spawned.status, 0, spawned.stderr);
  const card = fs.readFileSync(path.join(ctx.state, "sessions", "i-1", "card.md"), "utf8");
  assert.match(card, /## 3\. Playbook \(demo\)\n\nThis repo's workflow: GitHub pull requests/);
  assert.equal(ctx.readJson("sessions/i-1/record.json").playbook, "demo");
});

// protects: without --linear the output ends with the placeholder line naming the new config.json, and the placeholder URL and the example's base branch stay
// fails_when: the placeholder line is missing or names another file, or a missing --linear/--base blanks the key
// no_claim: that spawn refuses the placeholder URL (it does not; the line is the warning)
test("flow init --repo without --linear ends with the placeholder line", (t) => {
  const ctx = setup(t, { home: true });
  const result = ctx.run(["init", "--playbook", "demo", "--repo", ctx.repo]);
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(ctx.playbooks, "demo", "config.json");
  assert.equal(result.stdout.trimEnd().split("\n").at(-1), `linearWorkspaceUrl is a placeholder; edit ${file} before the first spawn`);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.linearWorkspaceUrl, "https://linear.app/your-workspace");
  assert.equal(config.baseBranch, "main");
});

// protects: acceptance 3, refusals before any write: a bad name (fix suggests one), a missing --repo path, a --linear that is not an https URL, a <name> folder already in a searched directory with or without config.json (fix names that directory), the repo's own example, and an existing state dir (fix is the cp -R recipe into the private directory)
// fails_when: a refusal exits 0 or another code, writes the state dir or the playbook folder, or its fix line lacks the suggestion, the recipe or the directory
// no_claim: the order between checks when one command trips several (each case trips one)
test("flow init --repo refuses before writing anything", (t) => {
  const ctx = setup(t, { home: true });
  assertRefusal(ctx.run(["init", "--playbook", "My Repo", "--repo", ctx.repo]), {
    first: /^flow init: playbook name "My Repo" is not a name \(lowercase letters, digits, dashes\)$/,
    fix: /^fix: use a name matching \^\[a-z0-9\]\[a-z0-9-\]\*\$, e\.g\. my-repo$/,
  });
  assertRefusal(ctx.run(["init", "--playbook", "../up", "--repo", ctx.repo]), { first: /is not a name/, fix: /e\.g\. up$/ });
  assertNothingWritten(ctx, "My Repo");

  const missing = path.join(ctx.root, "no-such-repo");
  assertRefusal(ctx.run(["init", "--playbook", "demo", "--repo", missing]), {
    first: new RegExp(`^flow init: repo ${escape(missing)} does not exist$`),
    fix: new RegExp(`: ${escape(missing)}$`),
  });
  assertNothingWritten(ctx, "demo");

  assertRefusal(ctx.run(["init", "--playbook", "demo", "--repo", ctx.repo, "--linear", "linear.app/acme"]), {
    first: /^flow init: --linear needs a URL; "linear\.app\/acme" is not one$/,
    fix: /--linear https:\/\/linear\.app\/<your-workspace>$/,
  });
  assertNothingWritten(ctx, "demo");

  for (const files of [{ "config.json": "{}" }, {}]) {
    fs.mkdirSync(path.join(ctx.playbooks, "taken"), { recursive: true });
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(ctx.playbooks, "taken", file), text);
    assertRefusal(ctx.run(["init", "--playbook", "taken", "--repo", ctx.repo]), {
      first: new RegExp(`^flow init: playbook "taken" already exists in ${escape(ctx.playbooks)}$`),
      fix: new RegExp(`^fix: pick another name, or run flow init --playbook taken without --repo: ${escape(ctx.playbooks)}$`),
    });
    assert.deepEqual(fs.readdirSync(path.join(ctx.playbooks, "taken")), Object.keys(files));
    assert.equal(fs.existsSync(ctx.state), false);
    fs.rmSync(path.join(ctx.playbooks, "taken"), { recursive: true });
  }

  // A dangling symlink is a taken path too (existsSync says no to it); it is left alone.
  fs.symlinkSync(path.join(ctx.root, "nowhere"), path.join(ctx.playbooks, "dangling"));
  assertRefusal(ctx.run(["init", "--playbook", "dangling", "--repo", ctx.repo]), { first: /^flow init: playbook "dangling" already exists in /, fix: /without --repo: / });
  assert.ok(fs.lstatSync(path.join(ctx.playbooks, "dangling")).isSymbolicLink());
  fs.rmSync(path.join(ctx.playbooks, "dangling"));

  // The repo's own playbooks/ is the second searched directory: the name example is taken
  // there, and the fix does not send the user to init --playbook example (refused as a template).
  const repoPlaybooks = path.join(ROOT, "playbooks");
  assertRefusal(ctx.run(["init", "--playbook", "example", "--repo", ctx.repo]), {
    first: new RegExp(`^flow init: playbook "example" already exists in ${escape(repoPlaybooks)}$`),
    fix: new RegExp(`^fix: pick another name; example is the template: ${escape(repoPlaybooks)}$`),
  });
  assertNothingWritten(ctx, "example");

  ctx.init();
  const target = path.join(ctx.playbooks, "second");
  assertRefusal(ctx.run(["init", "--playbook", "second", "--repo", ctx.repo]), {
    first: new RegExp(`^flow init: state dir ${escape(ctx.state)} already exists$`),
    fix: new RegExp(`^fix: mkdir -p ${escape(ctx.playbooks)} && cp -R ${escape(EXAMPLE)} ${escape(target)}/, then set repo, linearWorkspaceUrl and baseBranch and delete the "template": true line in ${escape(path.join(target, "config.json"))}$`),
  });
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(ctx.commits(), ["flow init --playbook test"]);
});

// protects: --repo must name the top folder of a git clone and --base a branch name, checked before any write: an empty --repo (it would resolve to the cwd), a plain folder, a subfolder of a clone, an empty --base and one starting with a dash (the keeper passes it to git, where it would be an option)
// fails_when: one of them is scaffolded, or the state dir or the playbook folder is written
// no_claim: that the branch exists on the remote (the keeper finds out at its first fetch)
test("flow init --repo refuses a repo that is not a clone's top and a base that is not a branch", (t) => {
  const ctx = setup(t, { home: true });
  const plain = path.join(ctx.root, "plain");
  fs.mkdirSync(plain);
  const sub = path.join(ctx.repo, "sub");
  fs.mkdirSync(sub);
  const cases = [
    [["--repo", ""], /^flow init: --repo is empty$/],
    [["--repo", plain], new RegExp(`^flow init: repo ${escape(plain)} is not a git repo$`)],
    [["--repo", sub], new RegExp(`^flow init: repo ${escape(sub)} is not the top of its git repo \\(${escape(ctx.repo)}\\)$`)],
    [["--repo", ctx.repo, "--base", ""], /^flow init: --base needs a branch name; "" is not one$/],
    [["--repo", ctx.repo, "--base=--upload-pack=x"], /^flow init: --base needs a branch name; "--upload-pack=x" is not one$/],
    // Passes the pattern; git check-ref-format --branch refuses it (".." and a ".lock" ending).
    [["--repo", ctx.repo, "--base", "a..b.lock"], /^flow init: --base needs a branch name; "a\.\.b\.lock" is not one$/],
  ];
  for (const [args, first] of cases) {
    assertRefusal(ctx.run(["init", "--playbook", "demo", ...args]), { first });
    assertNothingWritten(ctx, "demo");
  }
});

// protects: PRO-39: the state-dir refusal's cp -R recipe works as printed for a second repo's playbook (run in a temp HOME without the private directory), and every fix line on the way leads on: the recipe names the edits, deleting the template mark among them; a copy that still carries the mark is refused at spawn and at init with the fix to delete that line from its own config.json, not flow init --repo (refused again here); doing just that moves the refusal on to the next edit (repo), and with repo set the copy is spawned on
// fails_when: the recipe fails or copies into the wrong place, a fix line points at a command that is refused again, the delete-line fix names another file, or a copy still marked as a template loads
// no_claim: the README's wording of the same edits (the README is checked by hand)
test("the cp -R recipe of the state-dir refusal makes a working playbook", (t) => {
  const ctx = setup(t, { home: true });
  ctx.init();
  fs.rmSync(ctx.playbooks, { recursive: true }); // no private directory yet: the recipe's mkdir -p makes it
  const fix = ctx.run(["init", "--playbook", "second", "--repo", ctx.repo]).stderr.trimEnd().split("\n").at(-1);
  const file = path.join(ctx.playbooks, "second", "config.json");
  const [, mkdirDir, cpSource, cpTarget, edited] = fix.match(/^fix: mkdir -p (\S+) && cp -R (\S+) (\S+), then set repo, linearWorkspaceUrl and baseBranch and delete the "template": true line in (\S+)$/);
  assert.equal(edited, file);
  execFileSync("mkdir", ["-p", mkdirDir]);
  execFileSync("cp", ["-R", cpSource, cpTarget]);

  const editsLine = new RegExp(`^fix: set repo, linearWorkspaceUrl and baseBranch and delete the "template": true line in ${escape(file)}$`);
  assertRefusal(ctx.run(["spawn", "initiative", "I-1", "--name", "x", "--playbook", "second"]), { first: /^flow spawn: second is a template$/, fix: editsLine });
  assertRefusal(ctx.run(["init", "--playbook", "second"], { FLOW_STATE: path.join(ctx.root, "other-state") }), { first: /^flow init: second is a template$/, fix: editsLine });

  // Only the template line deleted: the next refusal is the placeholder repo, not the template again.
  const { template, ...config } = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(template, true);
  fs.writeFileSync(file, JSON.stringify(config));
  assertRefusal(ctx.run(["spawn", "initiative", "I-1", "--name", "x", "--playbook", "second"]), { first: /^flow spawn: repo \S+your-repo of playbook second does not exist$/ });

  fs.writeFileSync(file, JSON.stringify({ ...config, repo: ctx.repo, linearWorkspaceUrl: "https://linear.app/acme" }));
  const spawned = ctx.run(["spawn", "initiative", "I-1", "--name", "x", "--playbook", "second"]);
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.equal(ctx.readJson("sessions/i-1/record.json").playbook, "second");
});

// protects: flow init --playbook <name> without --repo now reads the playbook's config: a broken config.json is refused before the state dir is made (it used to pass an existence check and fail at the first spawn)
// fails_when: init exits 0 or creates the state dir for a config.json that is not JSON
// no_claim: configs that are JSON but miss keys (loadPlaybook refuses those at spawn)
test("flow init --playbook refuses a config.json that is not JSON", (t) => {
  const ctx = setup(t, { home: true });
  fs.mkdirSync(path.join(ctx.playbooks, "broken"));
  fs.writeFileSync(path.join(ctx.playbooks, "broken", "config.json"), "{ not json");
  assertRefusal(ctx.run(["init", "--playbook", "broken"]), { first: /^flow init: \S+broken\/config\.json is not valid JSON/ });
  assert.equal(fs.existsSync(ctx.state), false);
});

// protects: the option combinations init refuses with the usage line: --linear or --base without --repo, --repo without --playbook; and --playbook example without --repo, refused as a template so no state dir is made around the placeholder repo
// fails_when: one of them exits 0, creates the state dir, or the fix line is not the usage line with both init forms
// no_claim: a private playbook named example (the precedence test in playbook.test: it is no template and init accepts it)
test("flow init refuses --linear/--base without --repo, --repo without --playbook, and the template", (t) => {
  const ctx = setup(t, { home: true });
  const usage = /^fix: usage: flow init \[--playbook <name>\] \| flow init --playbook <name> --repo <path> \[--linear <url>\] \[--base <branch>\]$/;
  assertRefusal(ctx.run(["init", "--linear", "https://linear.app/acme"]), { first: /^flow init: --linear needs --repo$/, fix: usage });
  assertRefusal(ctx.run(["init", "--playbook", "test", "--base", "main"]), { first: /^flow init: --base needs --repo$/, fix: usage });
  assertRefusal(ctx.run(["init", "--repo", ctx.repo]), { first: /^flow init: --repo needs --playbook <name>$/, fix: usage });
  assertRefusal(ctx.run(["init", "--playbook", "example"]), { first: /^flow init: example is a template; use --repo <path>$/, fix: /^fix: flow init --playbook <name> --repo <path>$/ });
  assert.equal(fs.existsSync(ctx.state), false);
});

// protects: a failing initState after the copy leaves no scaffold behind and says so: the <name> folder is removed and a pre-existing private playbooks directory (with its other playbooks) is kept; when this run created the private playbooks directory, that directory is removed; stderr ends with `removed <dir>`
// fails_when: the copied folder stays (an orphan playbook), the pre-existing directory or its other playbook is removed, a created directory stays, the state dir is left, or the removed line is missing
// no_claim: failures other than the injected one before the state commit (every failure takes the same catch); another init filling the playbooks directory this run made (rmdir then leaves it, not exercised here); removing ~/.product-dev-flow itself (left, it may hold more)
test("flow init --repo removes what it wrote when the state dir fails", (t) => {
  const ctx = setup(t, { home: true });
  const failed = ctx.run(["init", "--playbook", "demo", "--repo", ctx.repo], { FLOW_TEST_FAIL: "init" });
  assert.equal(failed.status, 1, failed.stderr);
  const target = path.join(ctx.playbooks, "demo");
  assert.match(failed.stderr, /^flow init: unexpected error: test fault at init$/m);
  assert.equal(failed.stderr.trimEnd().split("\n").at(-1), `removed ${target}`);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(ctx.playbooks), ["test"]);
  assert.equal(fs.existsSync(ctx.state), false);

  fs.rmSync(ctx.playbooks, { recursive: true });
  const fresh = ctx.run(["init", "--playbook", "demo", "--repo", ctx.repo], { FLOW_TEST_FAIL: "init" });
  assert.equal(fresh.status, 1, fresh.stderr);
  assert.equal(fresh.stderr.trimEnd().split("\n").at(-1), `removed ${ctx.playbooks}`);
  assert.equal(fs.existsSync(ctx.playbooks), false);
  assert.equal(fs.existsSync(ctx.state), false);

  // The playbooks directory this run made gains other content before the failure (here
  // initState's own parent folders): only <name> goes, the directory and the rest stay.
  const nested = path.join(ctx.playbooks, "other", "state");
  const crowded = ctx.run(["init", "--playbook", "demo", "--repo", ctx.repo], { FLOW_TEST_FAIL: "init", FLOW_STATE: nested });
  assert.equal(crowded.status, 1, crowded.stderr);
  assert.equal(crowded.stderr.trimEnd().split("\n").at(-1), `removed ${target}`);
  assert.deepEqual(fs.readdirSync(ctx.playbooks), ["other"]);

  // An empty playbooks directory that existed before the run stays: the run did not make it.
  fs.rmSync(path.join(ctx.playbooks, "other"), { recursive: true });
  const empty = ctx.run(["init", "--playbook", "demo", "--repo", ctx.repo], { FLOW_TEST_FAIL: "init" });
  assert.equal(empty.stderr.trimEnd().split("\n").at(-1), `removed ${target}`);
  assert.deepEqual(fs.readdirSync(ctx.playbooks), []);
});

// protects: a state dir that cannot be made (here a read-only parent, a natural failure) rolls the scaffold back; and a <name> folder the rollback cannot remove is refused in the fail shape naming the folder and the error that started the rollback, the folder left for the user
// fails_when: the copy stays after a natural failure, a failed removal is swallowed (the user is told nothing about a leftover folder), or the original error is lost
// no_claim: which real errors make rmSync fail (the second case injects one with FLOW_TEST_FAIL=rollback); running as root (skipped: root writes a 0o555 dir)
test("flow init --repo rollback: a natural failure, and a removal that fails", { skip: process.getuid?.() === 0 && "root writes a read-only dir" }, (t) => {
  const ctx = setup(t, { home: true });
  const readOnly = path.join(ctx.root, "ro");
  fs.mkdirSync(readOnly);
  fs.chmodSync(readOnly, 0o555); // empty, so setup's cleanup can still remove it
  const env = { FLOW_STATE: path.join(readOnly, "state") };
  const target = path.join(ctx.playbooks, "demo");

  const natural = ctx.run(["init", "--playbook", "demo", "--repo", ctx.repo], env);
  assert.equal(natural.status, 1, natural.stderr);
  assert.match(natural.stderr, /^flow init: unexpected error: EACCES/m);
  assert.equal(natural.stderr.trimEnd().split("\n").at(-1), `removed ${target}`);
  assert.equal(fs.existsSync(target), false);

  assertRefusal(ctx.run(["init", "--playbook", "demo", "--repo", ctx.repo], { ...env, FLOW_TEST_FAIL: "rollback" }), {
    first: new RegExp(`^flow init: EACCES.*; and could not remove ${escape(target)} \\(test fault at rollback\\)$`),
    fix: new RegExp(`^fix: move it away by hand, then run flow init again: ${escape(target)}$`),
  });
  assert.ok(fs.existsSync(path.join(target, "config.json")), "the folder that could not be removed is left as it was");
});

// protects: the spec's order of checks: when one command trips two of them, the earlier one's message is the one shown (name before state dir, state dir before repo, repo before --linear, --linear before the name already taken)
// fails_when: the checks are reordered, so a user fixes one problem only to meet an earlier one, or a later check writes something first
// no_claim: every pair of checks (one adjacent pair each)
test("flow init --repo checks in the spec's order", (t) => {
  const ctx = setup(t, { home: true });
  const missing = path.join(ctx.root, "no-such-repo");
  fs.mkdirSync(path.join(ctx.playbooks, "taken"));
  // Before a state dir exists: repo before --linear, --linear before the taken name.
  assertRefusal(ctx.run(["init", "--playbook", "taken", "--repo", missing, "--linear", "x"]), { first: /^flow init: repo .* does not exist$/ });
  assertRefusal(ctx.run(["init", "--playbook", "taken", "--repo", ctx.repo, "--linear", "x"]), { first: /^flow init: --linear needs a URL/ });
  ctx.init();
  // With a state dir: the name before it, and it before the repo.
  assertRefusal(ctx.run(["init", "--playbook", "Bad Name", "--repo", missing]), { first: /^flow init: playbook name "Bad Name" is not a name/ });
  assertRefusal(ctx.run(["init", "--playbook", "fresh", "--repo", missing]), { first: /^flow init: state dir .* already exists$/ });
  assert.deepEqual(fs.readdirSync(ctx.playbooks).sort(), ["taken", "test"]);
});

// protects: the missing-playbook refusal offers only playbooks that can be used: the repo's template is left out of `or use one of:`
// fails_when: example is offered, so the user is sent to a name that is refused as a template
// no_claim: a private copy still marked as a template (left out the same way; not tested separately)
test("a missing playbook's fix line does not offer the template", (t) => {
  const ctx = setup(t, { home: true });
  const result = ctx.run(["init", "--playbook", "nope"]);
  assertRefusal(result, { first: /^flow init: playbook "nope" not found in /, fix: /, or use one of: test$/ });
  assert.doesNotMatch(result.stderr, /example,|, example/);
});

// protects: init --repo run a second time (its playbook and state dir both exist) is refused with a fix that uses the existing playbook, not the cp -R recipe, which would nest a template copy inside it
// fails_when: the fix line is the cp -R recipe, or the existing playbook changes
// no_claim: the wording of the recipe itself (the refusal test checks it)
test("flow init --repo run twice points at the existing playbook", (t) => {
  const ctx = setup(t, { home: true });
  assert.equal(ctx.run(["init", "--playbook", "mine", "--repo", ctx.repo]).status, 0);
  const target = path.join(ctx.playbooks, "mine");
  const before = fs.readdirSync(target).sort();
  assertRefusal(ctx.run(["init", "--playbook", "mine", "--repo", ctx.repo]), {
    first: /^flow init: state dir .* already exists$/,
    fix: new RegExp(`^fix: the playbook exists; spawn with --playbook mine, or pick another name: ${escape(target)}$`),
  });
  assert.deepEqual(fs.readdirSync(target).sort(), before);
});

// protects: a checkout without playbooks/example, or with a template config.json that is not JSON, refuses init --repo before any write, naming the checkout or the template's own file (Eng rerun R5)
// fails_when: the scaffold half-runs, creates the state dir or the playbook folder, or the message names another file (e.g. the copy, which the rollback has removed)
// no_claim: a template that is JSON but lacks keys (the copy then fails at spawn through loadPlaybook)
test("flow init --repo refuses when the template is missing or broken", (t) => {
  const ctx = setup(t, { home: true });
  const checkout = path.join(ctx.root, "checkout");
  for (const sub of ["bin", "lib", "templates"]) fs.cpSync(path.join(ROOT, sub), path.join(checkout, sub), { recursive: true });
  const run = () => spawnSync(process.execPath, [path.join(checkout, "bin", "flow.mjs"), "init", "--playbook", "demo", "--repo", ctx.repo], { env: ctx.env, encoding: "utf8" });
  assertRefusal(run(), { first: new RegExp(`^flow init: template playbooks/example missing in ${escape(checkout)}$`), fix: /^fix: git checkout -- playbooks\/example$/ });
  assertNothingWritten(ctx, "demo");

  const broken = path.join(checkout, "playbooks", "example", "config.json");
  fs.mkdirSync(path.dirname(broken), { recursive: true });
  fs.writeFileSync(broken, "{ not json");
  assertRefusal(run(), { first: new RegExp(`^flow init: ${escape(broken)} is not valid JSON`), fix: new RegExp(`^fix: fix ${escape(broken)}$`) });
  assertNothingWritten(ctx, "demo");
});

// protects: a dangling symlink where the state dir goes counts as an existing state dir, refused before the scaffold is written (existsSync says no to it, and mkdir would then fail mid-run)
// fails_when: the scaffold is copied and the run fails later with an unexpected EEXIST, or the symlink is removed
// no_claim: a state dir path whose parent is unwritable
test("flow init --repo refuses a dangling symlink at the state dir", (t) => {
  const ctx = setup(t, { home: true });
  fs.symlinkSync(path.join(ctx.root, "nowhere"), ctx.state);
  assertRefusal(ctx.run(["init", "--playbook", "demo", "--repo", ctx.repo]), { first: /^flow init: state dir .* already exists$/, fix: /^fix: mkdir -p / });
  assert.equal(fs.existsSync(path.join(ctx.playbooks, "demo")), false);
  assert.ok(fs.lstatSync(ctx.state).isSymbolicLink());
});

// protects: flow --help shows both init forms (DX review M6)
// fails_when: the --repo form is missing from the help, or the plain form was dropped
// no_claim: the README's copy of the usage (the docs issue checks it)
test("flow --help shows both init forms", (t) => {
  const ctx = setup(t);
  const help = ctx.run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^ {2}flow init \[--playbook <name>\] \| flow init --playbook <name> --repo <path> \[--linear <url>\] \[--base <branch>\]$/m);
});
