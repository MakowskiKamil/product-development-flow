// Role briefs (roles/) and the example playbook (playbooks/example/): what they must
// say, what roles/ must never say, and the six cards they render into.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ROOT, setup } from "./helpers.mjs";

const ROLES = ["initiative", "project", "hygiene", "build", "review", "qa"];
const ROLES_DIR = path.join(ROOT, "roles");
const PLAYBOOK_DIR = path.join(ROOT, "playbooks", "example");
const FIXTURE_PLAYBOOK_DIR = path.join(ROOT, "test", "fixtures", "playbooks", "test");
const CARDS_DIR = path.join(ROOT, "test", "fixtures", "cards");

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

// Terms that tie a brief to one repo: a package manager, ports (and other 4-5 digit
// numbers, so roles/ carries no dates either), a base branch other than the playbook's,
// an environment. The owner's private terms are the private-terms guard's, not this list's.
const REPO_SPECIFIC = [
  [/\bnpm\b/, "npm"],
  [/\b\d{4,5}\b/, "a port (or another 4-5 digit number)"],
  [/\bPORT=|localhost:\d/i, "a port"],
  [/\bdevelop\b/, "a repo's base branch"],
  [/\bstaging\b/i, "a repo's environments"],
];

// protects: roles/*.md stay repo-agnostic: no npm, port number, base branch or environment in any of the six briefs
// fails_when: a repo-specific rule is written into a role brief instead of the playbook
// no_claim: that the briefs are free of every other repo's terms (only this list is checked; the owner's terms are the private-terms guard's)
test("role briefs contain no repo-specific term", () => {
  for (const role of ROLES) {
    const text = read(`roles/${role}.md`);
    assert.ok(text.trim().length > 0, `roles/${role}.md is empty`);
    for (const [pattern, what] of REPO_SPECIFIC) {
      const line = text.split("\n").find((candidate) => pattern.test(candidate));
      assert.equal(line, undefined, `roles/${role}.md names ${what}: ${line}`);
    }
  }
});

// The spec's child 4 mapping table, row by row: the destination files and, for each,
// phrases that carry the rule. A phrase is a regex so wording can move, the rule not.
const MAPPING = [
  {
    rule: "spec is the law; autoplan decisions binding",
    files: ["roles/build.md", "roles/review.md"],
    must: [/### The spec is the law/, /autoplan decisions .*binding/, /\*\*Spec differs\*\*/],
  },
  {
    rule: "setup: fetch base, checkout -B the Linear branch, never touch another worktree",
    files: ["playbooks/example/common.md"],
    must: [/git fetch origin main/, /git checkout -B <the issue's Linear git branch name> origin\/main/, /Never touch the main checkout .*another session's worktree/],
  },
  {
    rule: "move the issue to In Progress and check its project",
    files: ["playbooks/example/build.md"],
    must: [/\*\*In Progress\*\*/, /check its project in the same step/],
  },
  {
    rule: "Definition of Done: tests exit 0, /review before the commit, /qa, acceptance criteria, test cards",
    files: ["playbooks/example/build.md"],
    must: [/### Definition of Done/, /exit 0/, /`\/review` on the diff, before the commit that lands it/, /`\/qa` on what the change does/, /Each acceptance criterion/, /protects \/ fails_when \/ no_claim/],
  },
  {
    rule: "own server port, shared files one session at a time, load flakes",
    files: ["playbooks/example/common.md"],
    must: [/on the port your plan notes name/, /never on the repo's default port/, /one session at a time/, /load flake/],
  },
  {
    rule: "hand-off (general): PR, Behavior changes, bind PR, ready for independent review, never force-push",
    files: ["roles/build.md"],
    must: [/## Behavior changes/, /Bind the PR/, /ready for independent review \(head <sha>\)/, /Never force-push/],
  },
  {
    rule: "hand-off (repo): PR into main, binding, CI checks",
    files: ["playbooks/example/build.md"],
    must: [/PR into `main`/, /## Behavior changes/, /add_repo/, /git remote get-url origin/, /subscribe_pr_activity/, /every check green on the head commit/],
  },
  {
    rule: "clean worktree before ending a turn",
    files: ["roles/build.md", "roles/review.md", "roles/qa.md"],
    must: [/### Before you end a turn/, /git status --short/, /restore what your/],
  },
  {
    rule: "independent review steps and the bring-to-owner list (role)",
    files: ["roles/review.md"],
    must: [/### Steps/, /Run `\/review` on the diff/, /each acceptance criterion .* has a test with its card/, /re-derive one worked example/, /read the exit code/, /P0 to P3/, /### Bring to the owner, never decide/, /### Never/],
  },
  {
    rule: "independent review steps and the bring-to-owner list (repo)",
    files: ["playbooks/example/review.md"],
    // Detached: the build session's worktree holds the PR branch, so checking it out by name fails.
    must: [/git checkout --detach origin\/<pr branch>/, /the repo's test command/, /### Bring to the owner/],
    mustNot: [/git checkout -B <pr branch>/],
  },
  {
    rule: "merging follows the merge setting (rule)",
    files: ["roles/build.md", "roles/review.md"],
    must: [/### Merge rule/, /`self`/, /`owner`/, /last session in .*chain/, /ready to merge \(head <sha>\)/, /clean checkout \(your worktree at exactly that commit, `git status --short` empty/, /head SHA and the test summary as a PR comment/, /green on that head commit/, /one\*\* background wait/],
  },
  {
    // PRO-10: who follows is on the card, so the briefs no longer send a session into the state dir.
    rule: "build reads from section 5 whether an independent review follows",
    files: ["roles/build.md"],
    must: [/The `Independent review` line in section 5/, /shows `—`, ask your parent/],
    mustNot: [/plan\.json/],
  },
  {
    rule: "review reads from section 5 whether an independent QA follows",
    files: ["roles/review.md"],
    must: [/The `Independent QA` line in section 5/, /shows `—`, ask your parent/],
    mustNot: [/plan\.json/],
  },
  {
    rule: "merging follows the merge setting (command, only when the rule says so)",
    files: ["playbooks/example/build.md", "playbooks/example/review.md"],
    must: [/gh pr merge <n> --merge --match-head-commit <sha>/, /Only when your merge rule says you merge \(`self`, or `owner` after `go`\)/],
  },
  {
    rule: "merging (repo): self is the owner's approval, the merge-check test command, one background CI wait",
    files: ["playbooks/example/common.md"],
    must: [/`merge: "self"` in your plan entry is the owner's approval/, /Merge-check test command .*exit 0, in a clean checkout of the PR head commit/, /\*\*one\*\* background `gh pr checks <n> --watch`/],
  },
  {
    rule: "the reviewer gets its PR from its parent; QA starts only after the merge; QA findings go back to the build session",
    files: ["roles/project.md", "roles/hygiene.md"],
    must: [/flow set <review slug> pr=<n>/, /QA starts only after the merge/, /QA findings .* go to the build session/],
  },
  {
    rule: "ask the owner for each issue's merge setting before storing the plan",
    files: ["roles/project.md", "roles/hygiene.md"],
    must: [/\*\*Merge settings\.\*\*/, /Before `flow plan` stores the plan, ask the owner in \*\*one\*\* question that lists every issue/, /proposed setting/],
  },
  {
    // PRO-17: the owner chooses before builds start whether the release waits for their go; a session always runs it.
    rule: "the project session asks for the release setting with the merge settings and releases under it",
    files: ["roles/project.md"],
    must: [/\*\*Release setting\.\*\*/, /same question as the merge settings/, /store only the owner's answer/, /the owner never runs them/, /### Release/, /release approved\?/, /Only the owner's own message in your conversation is a go/, /only when the release carries nothing but your own project's issues/],
    mustNot: [/After the release, which the owner does/],
  },
  {
    rule: "the project session is the release session; release self is the owner's approval in advance",
    files: ["playbooks/example/project.md"],
    must: [/is yours, under the plan's `release` setting/, /every issue of your project merged into `main`/, /the owner told what to pull/, /`release: "self"` is the owner's approval of this release given in advance/, /`flow phase <project> closed` comes after the release/],
  },
  {
    // PRO-16: a closed project's session ends by reporting to its initiative, which archives it.
    rule: "a closed project session reports [DONE] once its own PRs merged",
    files: ["roles/project.md"],
    must: [/### Closing/, /wait until your own open PRs/, /the `\[DONE\]` is your last action/, /`\[DONE\] <your name> \(<your slug>\): project closed` to your initiative session/, /If your Parent is `—`, the send fails, or `flow tree` shows you `ORPHAN`/, /project closed, ready to archive/],
    mustNot: [/to a new project session/],
  },
  {
    rule: "the initiative archives a closed project's session without asking the owner",
    files: ["roles/initiative.md"],
    must: [/`\[DONE\] <name> \(<slug>\): project closed`/, /archive it without asking the owner/, /never relayed or quoted/, /under your initiative, in a project that is `closed`/, /starts `# Card: <name>`/, /its output must say `archived "<name>"`/],
    mustNot: [/`flow archive` of a project session only when the owner asks/],
  },
  {
    // PRO-18: steps only the owner can do live in one Linear issue per project, not in a chat report.
    rule: "the project session keeps owner steps in one Linear issue and pushes its link after the release",
    files: ["roles/project.md"],
    must: [/### Owner steps/, /`Owner steps: <project name>`, assigned to the owner/, /Never only in a chat message/, /Steps come from any source/, /never a value/, /search your project for it/, /by a patch to the description/, /never in the Scope decisions table, the plan or the deletion rule/, /list it in the `release approved\?` ask, even under `self`/, /if the issue exists, push `<push path>: owner steps for <project name>: <issue link>`/, /does not hold the project open/],
    mustNot: [/marks it Done/],
  },
  {
    rule: "build sessions name owner steps in their closing [DONE]",
    files: ["roles/build.md"],
    must: [/one `Owner step: <what to do and where>` line per step/, /never their values/],
  },
  {
    rule: "the initiative lists open owner-step issues when asked",
    files: ["roles/initiative.md"],
    must: [/### Owner steps/, /list those not yet closed across your projects/, /Never close one yourself/, /whose session is archived/],
  },
  {
    rule: "example: the owner-steps issue never holds the project open",
    files: ["playbooks/example/project.md"],
    must: [/`Owner steps: <project name>` issue is in your team/, /\(never Triage/, /The owner closes it/, /when its last other issue is Done/],
  },
  {
    rule: "hygiene keeps owner steps in one standing Linear issue",
    files: ["roles/hygiene.md"],
    must: [/`Owner steps: hygiene`/, /Never only in a chat message/],
  },
  {
    rule: "QA: widths, touch and WebKit, design flags, browser rules (role)",
    files: ["roles/qa.md"],
    must: [/\/qa-only/, /real touch events/, /design rules/, /### Browser rules/],
  },
  {
    rule: "QA: on what is merged, 1280 and 390, touch and WebKit, a caller's view without a UI, browser rules (repo)",
    files: ["playbooks/example/qa.md"],
    must: [/git checkout --detach origin\/main/, /\*\*1280 and 390\*\*/, /real touch events and WebKit/, /run it as its caller does/, /### Browser rules/, /Never sign in anywhere/],
  },
  {
    rule: "out-of-scope findings go to Linear as observations, logged not defined",
    files: ["playbooks/example/common.md"],
    must: [/an observation in Linear: your team's Triage \(or Backlog when the team has no Triage\), no project/, /Log it, don't define it/, /never widened into your PR/],
  },
  {
    rule: "phases, Scope decisions table, deletion rule, plan writing, choosing models",
    files: ["roles/project.md"],
    must: [/intake → spec → issues → running → closed/, /\*\*Scope decisions\*\* table/, /\| Triage issue \| Decision \| Where \/ reason \|/, /\*\*Deletion rule\.\*\*/, /git grep -w <id>/, /those stay, cancelled/, /### Writing the plan/, /\*\*Choosing models\.\*\*/],
  },
  {
    rule: "hygiene: no spec, triage → plan",
    files: ["roles/hygiene.md"],
    must: [/no spec and no phases/, /straight into your plan/, /flow plan H --file/],
  },
  {
    rule: "priorities across projects, FYI handling",
    files: ["roles/initiative.md"],
    must: [/### Priorities/, /### FYI handling/],
  },
  {
    rule: "sentinel endings replaced by [DONE|FYI] messages to the parent",
    files: ["roles/build.md", "roles/review.md", "roles/qa.md"],
    must: [/\[ASK\|BLOCKED\|DONE\|FYI\] <your name>/],
    mustNot: [/FINDINGS POSTED/, /WORKTREE CLEAN/],
  },
  {
    rule: "no sentinel endings anywhere in the playbook",
    files: ["common", "initiative", "project", "hygiene", "build", "review", "qa"].map((name) => `playbooks/example/${name}.md`),
    must: [],
    mustNot: [/FINDINGS POSTED/, /WORKTREE CLEAN/],
  },
];

// protects: every rule of the spec's child 4 mapping table is present in each of its destination files
// fails_when: a rule is dropped or moved to the wrong file, or an old sentinel ending comes back
// no_claim: that the wording is good, or that a session follows it (PRO-7 trial)
test("every mapping-table rule is in its destination file", () => {
  for (const { rule, files, must, mustNot = [] } of MAPPING) {
    for (const file of files) {
      const text = read(file);
      for (const pattern of must) assert.match(text, pattern, `${file} lacks "${rule}": ${pattern}`);
      for (const pattern of mustNot) assert.doesNotMatch(text, pattern, `${file} still has "${rule}": ${pattern}`);
    }
  }
});

// The flow commands each role runs (plan of sessions, PRO-4 obligations).
const COMMANDS = {
  initiative: ["flow spawn project", "flow note <initiative>", "flow archive <project session slug>", "flow tree"],
  project: ["flow phase", "flow plan <project>", "flow note", "flow spawn <issue>", "flow set <child slug>", "flow archive <child slug>", "flow tree"],
  hygiene: ["flow plan H", "flow note", "flow spawn <issue>", "flow set <child slug>", "flow archive <child slug>", "flow tree"],
  build: ["flow set <your slug> branch=", "flow set <your slug> pr=", "flow tree"],
  review: ["flow set <your slug> pr=", "flow tree"],
  qa: ["flow tree"],
};

// protects: each role brief has a "flow commands you run" section naming that role's commands
// fails_when: a role brief drops the section or a command the role is meant to run
// no_claim: that flow refuses a command a role should not run (flow has no caller identity)
test("each role brief says which flow commands it runs", () => {
  for (const role of ROLES) {
    const text = read(`roles/${role}.md`);
    const start = text.indexOf("### flow commands you run");
    assert.notEqual(start, -1, `roles/${role}.md has no "flow commands you run" section`);
    const commands = text.slice(start);
    for (const command of COMMANDS[role]) assert.ok(commands.includes(command), `roles/${role}.md does not name ${command}`);
  }
});

// `flow --help`, one entry per command: name → the rest of its usage line. init's line
// holds both of its forms.
function helpUsages(t) {
  const ctx = setup(t);
  const help = ctx.run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  const usages = new Map(
    help.stdout
      .split("\n")
      .map((line) => line.trim().match(/^flow (\w+)(.*)$/))
      .filter(Boolean)
      .map(([, command, usage]) => [command, usage]),
  );
  assert.ok(usages.size >= 9, `flow --help listed ${usages.size} commands`);
  return usages;
}

// The whole options of a usage line or a documented command, so `--init` never passes
// as a prefix of `--initiative`.
function optionsOf(text) {
  return new Set(text.match(/--[a-z][a-z-]*/g) ?? []);
}

// The options a documented `flow <command><rest>` may use. spawn and init have several
// forms on one usage line, and bin/flow.mjs refuses an option of another form, so the
// form is picked the way the CLI picks it: init by --repo, spawn by its first word
// (initiative, project, hygiene, else the issue form) plus the "(all: …; … also …)" note.
function allowedOptions(usages, command, rest) {
  const usage = usages.get(command);
  if (command === "init") {
    const [plain, withRepo] = usage.split(" | flow init ");
    assert.ok(withRepo, `flow --help shows one init form: ${usage}`);
    return optionsOf(optionsOf(rest).has("--repo") ? withRepo : plain);
  }
  if (command !== "spawn") return optionsOf(usage);
  const [formsText, note = ""] = usage.split("(all:");
  const forms = formsText.split(" | ").map((form) => form.trim());
  const first = rest.trim().split(/\s+/)[0] ?? "";
  const coordinator = ["initiative", "project", "hygiene"].includes(first);
  const form = forms.find((candidate) => candidate.startsWith(coordinator ? first : "<issue-id>"));
  assert.ok(form, `flow --help has no spawn form for "${first}": ${usage}`);
  const [all, also = ""] = note.split(";");
  return new Set([...optionsOf(form), ...optionsOf(all), ...(coordinator ? optionsOf(also) : [])]);
}

// protects: every `flow <command>` a role brief or the playbook names is a command flow has (from `flow --help`), and each option it names belongs to that command's form (spawn by its first word, init by --repo)
// fails_when: a brief tells a session to run a command or an option flow does not have (a typo, a renamed command), or an option of another form (e.g. --playbook on an issue spawn)
// no_claim: that every argument shape in a brief is accepted (positional arguments are not checked)
test("briefs name only real flow commands and options", (t) => {
  const usages = helpUsages(t);
  const files = [...ROLES.map((role) => `roles/${role}.md`), ...fs.readdirSync(PLAYBOOK_DIR).filter((file) => file.endsWith(".md")).map((file) => `playbooks/example/${file}`)];
  let checked = 0;
  for (const file of files) {
    // Every `flow …` inside backticks, up to the closing backtick.
    for (const [, command, rest] of read(file).matchAll(/`flow (\w+)([^`]*)`/g)) {
      checked += 1;
      assert.ok(usages.has(command), `${file}: flow ${command} is not a flow command`);
      for (const option of optionsOf(rest)) {
        assert.ok(allowedOptions(usages, command, rest).has(option), `${file}: flow ${command}${rest} has no ${option}`);
      }
    }
  }
  // The briefs name dozens of commands; a regex that stops matching must not pass silently.
  assert.ok(checked >= 30, `only ${checked} flow commands found in the briefs`);
});

// The finance example names that the open-source release replaced with neutral ones
// (spec, taste d6). Built from parts so this file does not hold them itself.
const OLD_EXAMPLE_NAMES = [["P-FIN", "-25"], ["FIN", "-309"], ["Multi-currency", " books"], ["Revolut", " block"], ["Fees and foreign", " currency accounts"], ["Enable Banking", " any currency"]].map((parts) => parts.join(""));

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

// protects: acceptance 4 (d6): no file under test/, fixtures included, carries one of the finance example names the release replaced
// fails_when: a test or fixture brings back one of the old ids or names (a copied test, a regenerated snapshot from an old scenario)
// no_claim: the owner's private terms (the private-terms guard checks those); other finance words not on this list; files outside test/ (README.md and CLAUDE.md are the docs issue's)
test("no test or fixture names the old finance examples", () => {
  const files = filesUnder(path.join(ROOT, "test"));
  assert.ok(files.length > 50, `only ${files.length} files under test/`);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const name of OLD_EXAMPLE_NAMES) assert.ok(!text.includes(name), `${path.relative(ROOT, file)} contains "${name}"`);
  }
});

// Model keys both the test fixture and the example have (the fixture has no fable).
const PLAN = {
  project: "P-APP-25",
  release: "self",
  issues: [
    {
      id: "APP-309",
      title: "Importer block",
      notes: "Port 3105. Owns src/importers/feed.js.",
      waits: ["APP-306 merged"],
      build: { model: "opus", effort: "medium" },
      review: { model: "sonnet", effort: "high" },
      qa: { model: "opus", effort: "high" },
      merge: "self",
    },
  ],
};

// One card per role, spawned with the fake claude from the real role briefs.
// test: the `test` fixture playbook (fixed text, so the snapshots do not churn when the
// example's wording improves). example: a playbook scaffolded from playbooks/example by
// flow init --repo, with FLOW_PLAYBOOKS unset and a temp HOME, as a stranger makes one.
function renderAllCards(t, playbook) {
  const ctx = setup(t, { home: playbook === "example" });
  for (const role of ROLES) fs.copyFileSync(path.join(ROLES_DIR, `${role}.md`), path.join(ctx.roles, `${role}.md`));
  const init = playbook === "example" ? ["init", "--playbook", "mine", "--repo", ctx.repo, "--linear", "https://linear.app/example-workspace"] : ["init", "--playbook", "test"];

  const steps = [
    init,
    ["spawn", "initiative", "I-9", "--name", "Imports and feeds"],
    ["note", "I-9", "--text", "Catalog import before the search rewrite."],
    ["spawn", "project", "P-APP-25", "--name", "Catalog import", "--initiative", "I-9"],
    ["note", "P-APP-25", "--text", "Spec: https://linear.app/example-workspace/document/spec-catalog-import"],
    ["phase", "P-APP-25", "spec"],
    ["phase", "P-APP-25", "issues"],
    ["plan", "P-APP-25", "--file", path.join(ctx.root, "plan.json")],
    ["phase", "P-APP-25", "running"],
    ["spawn", "APP-309", "build", "--project", "P-APP-25"],
    ["spawn", "APP-309", "review", "--project", "P-APP-25"],
    ["spawn", "APP-309", "qa", "--project", "P-APP-25"],
    ["spawn", "hygiene"],
  ];
  fs.writeFileSync(path.join(ctx.root, "plan.json"), JSON.stringify(PLAN));
  for (const args of steps) {
    const result = ctx.run(args);
    assert.equal(result.status, 0, `flow ${args.join(" ")}: ${result.stderr}`);
  }
  const slugs = { initiative: "i-9", project: "p-app-25", hygiene: "hygiene", build: "app-309-build", review: "app-309-review", qa: "app-309-qa" };
  // The state dir is a temp path; the fixtures show it as <state>.
  return Object.fromEntries(ROLES.map((role) => [role, fs.readFileSync(path.join(ctx.state, "sessions", slugs[role], "card.md"), "utf8").replaceAll(ctx.state, "<state>")]));
}

// Each card holds its role brief and the playbook's common.md and <role>.md.
function assertCardParts(cards, playbookDir) {
  for (const role of ROLES) {
    assert.ok(cards[role].includes(fs.readFileSync(path.join(ROLES_DIR, `${role}.md`), "utf8").trimEnd()), `${role} card lacks roles/${role}.md`);
    assert.ok(cards[role].includes(fs.readFileSync(path.join(playbookDir, "common.md"), "utf8").trimEnd()), `${role} card lacks the playbook's common.md`);
    assert.ok(cards[role].includes(fs.readFileSync(path.join(playbookDir, `${role}.md`), "utf8").trimEnd()), `${role} card lacks the playbook's ${role}.md`);
  }
}

// protects: a card renders for each of the six roles from the real role briefs and the `test` fixture playbook, and equals the checked-in expected card in test/fixtures/cards/
// fails_when: a brief or playbook file breaks rendering, lands in the wrong role's card, or changes without its expected card being regenerated and reviewed
// no_claim: that a session reads and follows its card (live smoke, PRO-7); the example playbook's text (next test)
test("cards for all six roles match test/fixtures/cards", (t) => {
  const cards = renderAllCards(t, "test");
  assertCardParts(cards, FIXTURE_PLAYBOOK_DIR);
  // FLOW_UPDATE_FIXTURES=1 npm test rewrites the expected cards and then fails on
  // purpose, so a run with the variable left set can never pass: read the diff, then
  // run npm test again without it.
  if (process.env.FLOW_UPDATE_FIXTURES === "1") {
    fs.mkdirSync(CARDS_DIR, { recursive: true });
    for (const role of ROLES) fs.writeFileSync(path.join(CARDS_DIR, `${role}.md`), cards[role]);
    assert.fail("test/fixtures/cards rewritten: review the diff, then run npm test without FLOW_UPDATE_FIXTURES");
  }
  for (const role of ROLES) {
    const expected = fs.readFileSync(path.join(CARDS_DIR, `${role}.md`), "utf8");
    assert.equal(cards[role], expected, `card for ${role} differs from test/fixtures/cards/${role}.md (FLOW_UPDATE_FIXTURES=1 npm test regenerates it)`);
  }
});

// protects: a playbook scaffolded from playbooks/example by flow init --repo renders a card for each of the six roles, each holding the example's common.md and its own <role>.md, with the issue link under the given workspace
// fails_when: an example file breaks rendering or is missing, lands in the wrong role's card, or the scaffolded config does not load for some role's spawn
// no_claim: the exact card text (the snapshots use the `test` fixture on purpose); that the example's workflow suits any given repo
test("cards for all six roles render from the example playbook", (t) => {
  const cards = renderAllCards(t, "example");
  assertCardParts(cards, PLAYBOOK_DIR);
  for (const role of ROLES) assert.match(cards[role], /^## 3\. Playbook \(mine\)$/m, role);
  assert.match(cards.build, /^- Linear issue: https:\/\/linear\.app\/example-workspace\/issue\/APP-309$/m);
});

// --- The docs a stranger reads (README.md, CLAUDE.md, CONTRIBUTING.md, SECURITY.md, LICENSE) ---

// Every `flow …` the README names: inside backticks on a line, and every line of a code
// block that starts with `flow `. Returns [command, the rest of the line].
function readmeFlowCommands(text) {
  const found = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inBlock = !inBlock;
      continue;
    }
    if (inBlock) {
      const match = line.trim().match(/^flow (\w+)(.*)$/);
      // A comment after the command is prose, not options.
      if (match) found.push([match[1], match[2].replace(/\s#.*$/, "")]);
    } else {
      for (const [, command, rest] of line.matchAll(/`flow (\w+)([^`]*)`/g)) found.push([command, rest]);
    }
  }
  return found;
}

// protects: acceptance 3: every `flow` command the README names (inline or in a code block) is in `flow --help`, and every option it names belongs to that command's form (spawn by its first word, init by --repo); every command of `flow --help` has a row in the README's command table; both init forms are documented
// fails_when: the README names a command or option flow does not have (a rename, a typo, an option dropped), an option of another form (e.g. --name on spawn hygiene, --playbook on an issue spawn), leaves a command undocumented, or loses one of the two init forms
// no_claim: that the README's arguments are valid values (positional arguments are not checked), or that its steps work when followed (QA follows them on a scratch repo)
test("README names only real flow commands and options, and documents every command", (t) => {
  const usages = helpUsages(t);
  const readme = read("README.md");
  const commands = readmeFlowCommands(readme);
  for (const [command, rest] of commands) {
    assert.ok(usages.has(command), `README.md: flow ${command} is not a flow command`);
    for (const option of optionsOf(rest)) assert.ok(allowedOptions(usages, command, rest).has(option), `README.md: flow ${command}${rest} has no ${option}`);
  }
  // The per-form check refuses what the CLI refuses, so a README slip of this kind fails.
  assert.ok(!allowedOptions(usages, "spawn", " hygiene --name x").has("--name"), "spawn hygiene takes no --name");
  assert.ok(!allowedOptions(usages, "spawn", " APP-1 build --project P-APP-1 --playbook pb").has("--playbook"), "an issue spawn takes no --playbook");
  assert.ok(allowedOptions(usages, "spawn", " project P-APP-1 --name x --initiative I-1 --playbook pb --model haiku").has("--initiative"), "spawn project takes --initiative");
  assert.ok(!allowedOptions(usages, "init", " --playbook x --linear u").has("--linear"), "init without --repo takes no --linear");
  // A regex that stops matching must not pass silently: the table alone names 13 rows.
  assert.ok(commands.length >= 25, `only ${commands.length} flow commands found in README.md`);
  for (const command of usages.keys()) assert.match(readme, new RegExp(`^\\| \`flow ${command}\\b`, "m"), `README.md has no command-table row for flow ${command}`);
  assert.ok(readme.includes("| `flow init [--playbook <name>]` |"), "README.md lacks the plain init form");
  assert.ok(readme.includes("| `flow init --playbook <name> --repo <path> [--linear <url>] [--base <branch>]` |"), "README.md lacks the init --repo form");
  assert.ok(usages.get("init").includes("flow init --playbook <name> --repo <path> [--linear <url>] [--base <branch>]"), "flow --help lacks the init --repo form the README documents");
});

// protects: every keeper option the README shows (`node keeper/flow-keeper.mjs --…`) is one the keeper reads
// fails_when: the README documents a keeper option that was renamed or removed (e.g. an old --install form)
// no_claim: what the keeper prints for it (test/keeper.test.mjs checks that)
test("README names only real keeper options", () => {
  const keeper = read("keeper/flow-keeper.mjs");
  const options = [...read("README.md").matchAll(/node keeper\/flow-keeper\.mjs((?: --[a-z-]+(?: <[^>]+>)?)+)/g)].flatMap(([, rest]) => [...rest.matchAll(/--[a-z-]+/g)].map(([option]) => option));
  assert.ok(options.length >= 5, `only ${options.length} keeper options found in README.md`);
  for (const option of options) assert.ok(keeper.includes(`ARGS.includes("${option}")`) || keeper.includes(`ARGS.indexOf("${option}")`), `README.md: the keeper reads no ${option}`);
});

function codeFilesIn(dirs) {
  return dirs.flatMap((dir) => filesUnder(path.join(ROOT, dir))).filter((file) => /\.(mjs|template)$/.test(file));
}

// protects: the README's environment-variable table names every FLOW_* variable lib/, bin/ and keeper/ read, and names none that no code or test uses
// fails_when: a new FLOW_* override is added to the code without a table row, or a row outlives its variable
// no_claim: that each row's description and default are right (review reads them)
test("README's environment table lists every FLOW_ variable the code reads", () => {
  const readme = read("README.md");
  const start = readme.indexOf("### Environment variables");
  assert.notEqual(start, -1, "README.md has no Environment variables section");
  const table = readme.slice(start).split("\n\n")[1];
  const rows = new Set([...table.matchAll(/^\| `(FLOW_[A-Z_]+)` \|/gm)].map(([, name]) => name));
  const used = (dirs) => new Set(codeFilesIn(dirs).flatMap((file) => fs.readFileSync(file, "utf8").match(/FLOW_[A-Z_]+/g) ?? []));
  const code = used(["lib", "bin", "keeper"]);
  assert.ok(code.size >= 9, `only ${code.size} FLOW_ variables found in lib/, bin/, keeper/`);
  for (const name of code) assert.ok(rows.has(name), `README.md's environment table has no row for ${name}`);
  const codeAndTests = used(["lib", "bin", "keeper", "test"]);
  for (const name of rows) assert.ok(codeAndTests.has(name), `README.md's environment table names ${name}, which no code or test uses`);
});

// Strings that tie the docs to the maintainer's own machine or Linear (acceptance 2).
// Built from parts so this file does not hold them itself (the private-terms guard
// would flag some of them).
const OWNER_ONLY = [
  [/~\/Developer/, "a ~/Developer path"],
  [new RegExp(["fin", "ance"].join(""), "i"), "the finance repo or domain"],
  [new RegExp(["FIN", "-"].join("")), "a finance issue id"],
  [new RegExp(["Mac", " mini"].join(""), "i"), "the maintainer's machine"],
  [new RegExp(["claude-lane", "-keeper"].join("")), "the old keeper"],
  [new RegExp(["com", "\\.", "makowski"].join(""), "i"), "an owner-specific launchd label"],
  [new RegExp(["session hier", "archy v1"].join(""), "i"), "a Linear document name"],
  [/linear\.app\/(?!your-workspace\b|example-workspace\b|<)[\w-]+/, "a Linear workspace URL"],
];
const DOCS = ["README.md", "CLAUDE.md", "CONTRIBUTING.md", "SECURITY.md"];

// protects: acceptance 2: README.md, CLAUDE.md, CONTRIBUTING.md and SECURITY.md name none of the maintainer's paths, machine, finance ids, old keeper, launchd labels, Linear document names or workspace URL; CLAUDE.md names no maintainer at all (the copyright line lives in LICENSE)
// fails_when: a doc edit brings back one of those strings (a copied example, an old troubleshooting line)
// no_claim: the maintainer's private term list (the private-terms guard checks that), other spellings of these strings
test("the docs carry no owner-specific path, id, label or Linear name", () => {
  for (const file of DOCS) {
    const lines = read(file).split("\n");
    for (const [pattern, what] of OWNER_ONLY) {
      const line = lines.find((candidate) => pattern.test(candidate));
      assert.equal(line, undefined, `${file} names ${what}: ${line}`);
    }
  }
  assert.doesNotMatch(read("CLAUDE.md"), new RegExp(["mak", "owski"].join(""), "i"), "CLAUDE.md names the maintainer");
});

// protects: the public name MakowskiKamil/product-development-flow is in the README's clone line and its CI badge (test.yml on main), and package.json's name, with private: true kept
// fails_when: the clone line or badge points at another repo name, the badge loses its workflow or branch, or package.json is renamed or loses private
// no_claim: that the repo exists under that name (it does only after the cut-over), or that the badge renders
test("README and package.json use the public repo name", () => {
  const readme = read("README.md");
  assert.ok(readme.includes("git clone https://github.com/MakowskiKamil/product-development-flow.git"), "README.md lacks the clone line");
  assert.ok(readme.includes("(https://github.com/MakowskiKamil/product-development-flow/actions/workflows/test.yml/badge.svg?branch=main)"), "README.md lacks the CI badge for test.yml on main");
  assert.ok(fs.existsSync(path.join(ROOT, ".github", "workflows", "test.yml")), "the badge's workflow file is missing");
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.name, "product-development-flow");
  assert.equal(pkg.private, true);
});

// The MIT License as published by the Open Source Initiative, with the spec's copyright line (D2).
const MIT_LICENSE = `MIT License

Copyright (c) 2026 Kamil Makowski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// protects: acceptance 1: LICENSE is the MIT text with the copyright line; CONTRIBUTING.md and SECURITY.md carry the points the spec lists
// fails_when: the license text or copyright line changes, or a point (who merges, no response promise, private roadmap, tests and cards, likely PRs, the guard's skip and dispatch wording, the frozen fixture, the pull rule, private reporting, no bounty) is dropped
// no_claim: that the wording reads well, or that GitHub's private vulnerability reporting is switched on (an owner step at the cut-over)
test("LICENSE, CONTRIBUTING.md and SECURITY.md say what the spec asks", () => {
  assert.equal(read("LICENSE"), MIT_LICENSE);
  const contributing = read("CONTRIBUTING.md");
  for (const pattern of [
    /Issues and pull requests are welcome/,
    /maintainer reviews and merges every PR/,
    /no promised response time/,
    /roadmap is private/,
    /Bug fixes/,
    /Docs/,
    /Playbook examples/,
    /Small and focused/,
    /npm test/,
    /protects: .*\n\/\/ fails_when: .*\n\/\/ no_claim: /,
    /If CI reports it skipped on your fork, that is expected; a hand-started run is red on a fork, that is the maintainer-only path\./,
    /a net, not a lock/,
    /never runs on fork PRs/,
    /frozen snapshots/,
    /`lib\/tree\.mjs` or the keeper's log wording/,
    /reviewed as a rendering change/,
    /quiet moment/,
    /`flow tree` and `node keeper\/flow-keeper\.mjs --dry-run`/,
    /permanent gate/,
  ]) assert.match(contributing, pattern, `CONTRIBUTING.md lacks ${pattern}`);
  const security = read("SECURITY.md");
  for (const pattern of [/\*\*Report a vulnerability\*\*/, /no bounty/i, /best effort/]) assert.match(security, pattern, `SECURITY.md lacks ${pattern}`);
});
