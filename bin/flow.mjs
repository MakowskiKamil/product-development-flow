#!/usr/bin/env node
// flow: starts Claude Code sessions as a hierarchy that mirrors Linear and keeps
// their records, cards, plans and notes in a local git store.
// Exit codes: 0 done, 1 refused or invalid, 2 claude failed. Messages go to stderr.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { refreshCards } from "../lib/cards.mjs";
import { FlowError, fail, formatError } from "../lib/fail.mjs";
import { COORDINATOR_ROLES, ISSUE_ROLES } from "../lib/ids.mjs";
import { PHASES, addNote, movePhase, storePlan } from "../lib/plan.mjs";
import { checkInitPlaybook, scaffoldPlaybook } from "../lib/playbook.mjs";
import { spawn } from "../lib/spawn.mjs";
import { initState } from "../lib/state.mjs";
import { treeLines } from "../lib/tree.mjs";
import { archive, setFields } from "../lib/update.mjs";

// One line per command: its usage and the function that runs it.
const COMMANDS = {
  init: { usage: "flow init [--playbook <name>] | flow init --playbook <name> --repo <path> [--linear <url>] [--base <branch>]", run: init },
  spawn: { usage: "flow spawn initiative <I-id> --name <n> | project <P-id> --name <n> [--initiative <I-id>] | hygiene | <issue-id> <build|review|qa> --project <P-id|H> [--again]   (all: [--model <m>] [--effort <e>]; initiative, project, hygiene also [--playbook <pb>])", run: spawnCommand },
  plan: { usage: "flow plan <P-id|H> --file <path>", run: planCommand },
  phase: { usage: `flow phase <P-id> <${PHASES.join("|")}>`, run: phaseCommand },
  note: { usage: "flow note <P-id|I-id|H|issue-id> --text <t> [--project <P-id|H>]", run: noteCommand },
  refresh: { usage: "flow refresh <slug|P-id|H|all>", run: refreshCommand },
  tree: { usage: "flow tree [--all]", run: treeCommand },
  set: { usage: "flow set <slug> pr=<n> | branch=<b> | status=done", run: setCommand },
  archive: { usage: "flow archive <slug>", run: archiveCommand },
};

function commandList() {
  return Object.values(COMMANDS).map((command) => `  ${command.usage}`);
}

function parse(argv, options, usage) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    fail(error.message, `usage: ${usage}`);
  }
}

const INIT_OPTIONS = { playbook: { type: "string" }, repo: { type: "string" }, linear: { type: "string" }, base: { type: "string" } };

function init(argv) {
  const usage = COMMANDS.init.usage;
  const { values, positionals } = parse(argv, INIT_OPTIONS, usage);
  if (positionals.length) fail(`unexpected argument ${JSON.stringify(positionals[0])}`, `usage: ${usage}`);
  if (values.repo === undefined) {
    for (const option of ["linear", "base"]) if (values[option] !== undefined) fail(`--${option} needs --repo`, `usage: ${usage}`);
    if (values.playbook) checkInitPlaybook(values.playbook);
    const dir = initState({ playbook: values.playbook });
    console.log(`created state dir ${dir}`);
    return;
  }
  if (values.playbook === undefined) fail("--repo needs --playbook <name>", `usage: ${usage}`);
  const result = scaffoldPlaybook(values.playbook, { repo: values.repo, linear: values.linear, base: values.base });
  console.log(
    [
      `created playbook ${result.playbookDir}`,
      `created state dir ${result.stateDir}`,
      "next:",
      `  mkdir -p ~/.local/bin && ln -s ${fileURLToPath(import.meta.url)} ~/.local/bin/flow`,
      '  add "Bash(flow:*)" to permissions.allow in ~/.claude/settings.json (see README: Install)',
      '  flow spawn initiative I-1 --name "<an initiative name>" --model haiku',
      ...(result.placeholder ? [`linearWorkspaceUrl is a placeholder; edit ${path.join(result.playbookDir, "config.json")} before the first spawn`] : []),
    ].join("\n"),
  );
}

const SPAWN_OPTIONS = {
  name: { type: "string" },
  initiative: { type: "string" },
  project: { type: "string" },
  playbook: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  again: { type: "boolean" },
};

// Which options each spawn form takes besides --model/--effort. Coordinators also take
// --playbook; issue sessions always use their project's playbook.
const SPAWN_FORMS = {
  initiative: { extra: ["name"], takesId: true },
  project: { extra: ["name", "initiative"], takesId: true },
  hygiene: { extra: [], takesId: false },
  issue: { extra: ["project", "again"], takesId: true },
};

function spawnCommand(argv) {
  const usage = COMMANDS.spawn.usage;
  const { values, positionals } = parse(argv, SPAWN_OPTIONS, usage);
  const [first, second, ...rest] = positionals;
  const kind = COORDINATOR_ROLES.includes(first) ? first : "issue";
  const form = SPAWN_FORMS[kind];
  const allowed = new Set([...form.extra, ...(kind === "issue" ? ["model", "effort"] : ["playbook", "model", "effort"])]);
  for (const option of Object.keys(values)) {
    if (!allowed.has(option)) fail(`--${option} is not an option of flow spawn ${kind === "issue" ? "<issue-id> <role>" : kind}`, `usage: ${usage}`);
  }

  const options = { kind, ...values };
  if (kind === "issue") {
    if (first === undefined) fail("no spawn target given", `usage: ${usage}`);
    if (!ISSUE_ROLES.includes(second)) fail(`role ${JSON.stringify(second ?? "")} for ${first} is not one of ${ISSUE_ROLES.join(", ")}`, `flow spawn ${first} build --project <P-id|H>`);
    if (values.project === undefined) fail(`${first} ${second} has no --project`, `flow spawn ${first} ${second} --project <P-id|H>`);
    if (rest.length) fail(`unexpected argument ${JSON.stringify(rest[0])}`, `usage: ${usage}`);
    Object.assign(options, { id: first, role: second });
  } else {
    const extra = form.takesId ? rest : [second, ...rest].filter((value) => value !== undefined);
    if (extra.length) fail(`unexpected argument ${JSON.stringify(extra[0])}`, `usage: ${usage}`);
    if (form.takesId) options.id = second;
  }

  const { record, cardFile } = spawn(options);
  console.log(`started "${record.name}"`);
  console.log(`  slug: ${record.slug}`);
  console.log(`  job: ${record.jobId} (session ${record.sessionId})`);
  console.log(`  card: ${cardFile}`);
}

function treeCommand(argv) {
  const { values, positionals } = parse(argv, { all: { type: "boolean" } }, COMMANDS.tree.usage);
  if (positionals.length) fail(`unexpected argument ${JSON.stringify(positionals[0])}`, `usage: ${COMMANDS.tree.usage}`);
  console.log(treeLines({ all: values.all }).join("\n"));
}

function setCommand(argv) {
  const { positionals } = parse(argv, {}, COMMANDS.set.usage);
  const [slug, ...pairs] = positionals;
  if (slug === undefined) fail("no slug given", `usage: ${COMMANDS.set.usage}`);
  const { record, changed } = setFields(slug, pairs);
  if (!changed.length) console.log(`${slug}: no change`);
  else console.log(`${slug}: ${changed.map((key) => `${key}=${record[key]}`).join(" ")}`);
}

function archiveCommand(argv) {
  const { positionals } = parse(argv, {}, COMMANDS.archive.usage);
  const [slug, ...rest] = positionals;
  if (slug === undefined) fail("no slug given", `usage: ${COMMANDS.archive.usage}`);
  if (rest.length) fail(`unexpected argument ${JSON.stringify(rest[0])}`, `usage: ${COMMANDS.archive.usage}`);
  const { record, wasArchived, openChildren, stop, unpin } = archive(slug);
  console.log(`${wasArchived ? "already archived" : "archived"} "${record.name}" (${slug})`);
  console.log(stop.gone ? `  ${stop.message}` : `  stopped job ${stop.jobId}`);
  if (unpin.warning) process.stderr.write(`flow archive: warning: ${unpin.warning}\n`);
  else console.log(unpin.written ? "  unpinned" : "  was not pinned");
  if (openChildren.length) {
    console.log(`  open children, now ORPHAN until archived: ${openChildren.map((child) => `"${child.name}" (${child.slug})`).join(", ")}`);
  }
}

function planCommand(argv) {
  const usage = COMMANDS.plan.usage;
  const { values, positionals } = parse(argv, { file: { type: "string" } }, usage);
  const [project, ...rest] = positionals;
  if (project === undefined) fail("no project given", `usage: ${usage}`);
  if (rest.length) fail(`unexpected argument ${JSON.stringify(rest[0])}`, `usage: ${usage}`);
  if (values.file === undefined) fail(`plan of ${project} has no --file`, `flow plan ${project} --file <path>`);
  const result = storePlan(project, values.file);
  console.log(`${result.committed ? "stored" : "unchanged:"} plan of ${result.project} (${result.issues} issues)`);
  if (result.releaseChange) console.log(result.releaseChange);
  printTell(result.tell);
}

function phaseCommand(argv) {
  const usage = COMMANDS.phase.usage;
  const { positionals } = parse(argv, {}, usage);
  const [project, phase, ...rest] = positionals;
  if (project === undefined || phase === undefined) fail("project and phase are both needed", `usage: ${usage}`);
  if (rest.length) fail(`unexpected argument ${JSON.stringify(rest[0])}`, `usage: ${usage}`);
  const result = movePhase(project, phase);
  console.log(`${result.project}: ${result.from} → ${result.to}`);
}

// The names whose card changed; the calling session sends "Card updated: …" to each.
function printTell(names) {
  if (names.length) console.log(["tell:", ...names.map((name) => `  ${name}`)].join("\n"));
}

function noteCommand(argv) {
  const usage = COMMANDS.note.usage;
  const { values, positionals } = parse(argv, { text: { type: "string" }, project: { type: "string" } }, usage);
  const [target, ...rest] = positionals;
  if (target === undefined) fail("no note target given", `usage: ${usage}`);
  if (rest.length) fail(`unexpected argument ${JSON.stringify(rest[0])}`, `usage: ${usage}`);
  if (values.text === undefined) fail(`note for ${target} has no --text`, `flow note ${target} --text "<note>"`);
  const result = addNote(target, values.text, { project: values.project });
  console.log(`noted in ${result.where}`);
  printTell(result.tell);
}

function refreshCommand(argv) {
  const usage = COMMANDS.refresh.usage;
  const { positionals } = parse(argv, {}, usage);
  const [target, ...rest] = positionals;
  if (target === undefined) fail("no refresh target given", `usage: ${usage}`);
  if (rest.length) fail(`unexpected argument ${JSON.stringify(rest[0])}`, `usage: ${usage}`);
  const result = refreshCards(target);
  console.log(`rebuilt ${result.rebuilt} card(s) for ${result.target}, ${result.tell.length} changed`);
  printTell(result.tell);
}

function main(argv) {
  // Tests must never reach the real state dir, claude binary or ~/.claude.
  if (process.env.NODE_TEST_CONTEXT) {
    const missing = ["FLOW_STATE", "FLOW_CLAUDE", "FLOW_CLAUDE_HOME"].filter((key) => !process.env[key]);
    if (missing.length) fail(`running under node --test without ${missing.join(", ")}`, "set them to temp paths (see test/helpers.mjs)");
  }
  const [name, ...rest] = argv;
  if (name === "--help" || name === "-h" || name === "help") {
    console.log(["usage:", ...commandList()].join("\n"));
    return;
  }
  if (name === undefined) fail("no command given", "run one of the commands above", { detail: commandList() });
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null; // not "constructor" etc.
  if (!command) fail(`unknown command ${JSON.stringify(name)}`, "run one of the commands above", { detail: commandList() });
  command.run(rest);
}

// WHY: Ctrl-C, or a tool timeout in the calling session, must not kill flow halfway
// through a spawn: that would skip the rollback, the state restore and the lock
// release. With a listener Node does not exit on these signals; the command (which is
// synchronous and bounded by its timeouts) runs to its end, and its own result decides
// the exit code. A Ctrl-C in a terminal also reaches the claude child, which then
// fails, so the spawn rolls back.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});

try {
  main(process.argv.slice(2));
} catch (error) {
  const operation = ["flow", Object.hasOwn(COMMANDS, process.argv[2] ?? "") ? process.argv[2] : null].filter(Boolean).join(" ");
  process.stderr.write(`${formatError(operation, error)}\n`);
  // flow init --repo removes what it created when a step after its checks fails.
  for (const dir of error.removed ?? []) process.stderr.write(`removed ${dir}\n`);
  process.exitCode = error instanceof FlowError ? error.code : 1;
}
