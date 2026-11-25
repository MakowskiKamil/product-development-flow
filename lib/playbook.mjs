// Playbooks: <dir>/<name>/config.json carries everything repo-specific (repo path,
// Linear workspace, models, defaults), next to the repo's workflow files.
//
// Where they live (open-source release, decision D1): private playbooks in
// ~/.product-dev-flow/playbooks/, searched before the repo's own playbooks/, so a
// private playbook never has to be in the repo and a name in both takes the private
// one. FLOW_PLAYBOOKS replaces both directories (tests and smokes, gate decision d1).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, testFault } from "./fail.mjs";
import { COORDINATOR_ROLES, ISSUE_ROLES } from "./ids.mjs";
import { checkStateDirFree, git, initState } from "./state.mjs";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const ROLES = [...COORDINATOR_ROLES, ...ISSUE_ROLES];
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_PLAYBOOKS = path.join(REPO_ROOT, "playbooks");
// The repo's own template playbook: it names no real repo, so a session must never run
// from it. Its config.json carries "template": true; flow init --repo copies it and
// strips the key, and loadPlaybook refuses any config that still carries it.
const TEMPLATE = "example";
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const LINEAR_URL = /^https:\/\/\S+$/;
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

// The real path when it exists, so /var and /private/var (macOS) compare equal.
function realOrResolved(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function isInside(dir, parent) {
  return dir === parent || dir.startsWith(`${parent}${path.sep}`);
}

// The directories searched for playbooks, first match wins.
export function playbookDirs() {
  if (process.env.FLOW_PLAYBOOKS) return [process.env.FLOW_PLAYBOOKS];
  // WHY: like envOverride (lib/fail.mjs), no test may fall through to the owner's real
  // ~/.product-dev-flow/playbooks; a test that wants both directories sets a temp HOME.
  if (process.env.NODE_TEST_CONTEXT && !isInside(realOrResolved(os.homedir()), realOrResolved(os.tmpdir()))) {
    fail("running under node --test with HOME outside the temp dir and no FLOW_PLAYBOOKS", "set FLOW_PLAYBOOKS or HOME to a temp path (see test/helpers.mjs)");
  }
  return [path.join(os.homedir(), ".product-dev-flow", "playbooks"), REPO_PLAYBOOKS];
}

// The playbook names in one directory: its entries that hold a config.json. A missing
// directory has none; one that exists but cannot be listed is refused, never skipped.
function namesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    fail(`cannot read playbooks directory ${dir} (${error.code})`, `fix its permissions or point FLOW_PLAYBOOKS elsewhere: ${dir}`);
  }
  return entries.filter((name) => fs.existsSync(path.join(dir, name, "config.json")));
}

// The directory that holds the playbook <name> (its parent, not <name>/ itself), or
// null when no searched directory has <name>/config.json.
// WHY match listed entries, not test the path: a name is one folder name, exactly as
// listed. "../x", "./alpha" or "ALPHA" (case-insensitive disks) would otherwise load a
// config from elsewhere.
export function playbookDir(name) {
  return playbookDirs().find((dir) => namesIn(dir).includes(name)) ?? null;
}

// Every playbook name in any searched directory, once each, sorted.
export function playbookNames() {
  return [...new Set(playbookDirs().flatMap(namesIn))].sort();
}

function expandHome(value) {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

function refuseMissing(name) {
  const dirs = playbookDirs();
  // Templates are left out: offered here, they would only be refused as a template. One
  // scan per directory, first match per name, as playbookDir resolves it.
  const first = new Map();
  for (const dir of dirs) for (const other of namesIn(dir)) if (!first.has(other)) first.set(other, path.join(dir, other));
  const usable = [...first].filter(([, folder]) => !isTemplateFolder(folder)).map(([other]) => other).sort();
  fail(
    `playbook ${JSON.stringify(name)} not found in ${dirs.join(" or ")}`,
    `copy or scaffold it into ${path.join(dirs[0], name)}/ (see playbooks/example/README.md), or use one of: ${usable.join(", ") || "(none)"}`,
  );
}

export function checkPlaybookExists(name) {
  if (playbookDir(name) === null) refuseMissing(name);
}

function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file} is not valid JSON (${error.message})`, `fix ${file}`);
  }
}

// WHY by the key, not by where the folder sits: a `cp -R` copy of the template that
// still carries it is refused the same way, so nobody runs a session on ~/src/your-repo.
function isTemplate(config) {
  return config?.template === true;
}

// The edits that make a copy of the template a playbook, ending with the file to edit
// (the path last, as in every fix line). A copy that keeps the mark is refused as a template.
function editsFor(file) {
  return `set repo, linearWorkspaceUrl and baseBranch and delete the "template": true line in ${file}`;
}

// The cp -R recipe for a playbook copied by hand from the template (a second repo's,
// once the state dir exists).
function copyRecipe(target) {
  return `mkdir -p ${path.dirname(target)} && cp -R ${path.join(REPO_PLAYBOOKS, TEMPLATE)} ${target}/, then ${editsFor(path.join(target, "config.json"))}`;
}

// Whether <dir>/<name> is the repo's own playbooks/example: its config.json is the very
// file of the template (same device and inode; statSync follows links). So a copy in the
// repo's playbooks/ under another name is not, while a symlinked folder, a symlinked or
// hard-linked config.json, or FLOW_PLAYBOOKS spelled in another case still is. The
// template is tracked, so no fix ever says to edit it. The folder's own real path is
// checked first: the template reached directly never depends on two stats agreeing
// (an editor's atomic save or a pull can swap its inode between them).
function isRepoTemplate(dir, name) {
  if (realOrResolved(path.join(dir, name)) === realOrResolved(path.join(REPO_PLAYBOOKS, TEMPLATE))) return true;
  try {
    const candidate = fs.statSync(path.join(dir, name, "config.json"));
    const template = fs.statSync(path.join(REPO_PLAYBOOKS, TEMPLATE, "config.json"));
    return candidate.dev === template.dev && candidate.ino === template.ino;
  } catch {
    return false;
  }
}

// The fix for a playbook refused as a template, for every caller: loadPlaybook (spawn,
// plan, refresh, the keeper, which all run with a state dir) and flow init --playbook
// <name> for a copy. A copy (the recipe's output) needs the recipe's edits, the mark's
// deletion among them: pointing it at flow init --repo would be refused again, for the
// state dir or the taken name. The repo's own template is copied under a new name instead;
// the placeholder NAME has no space or angle bracket, so a pasted recipe cannot misparse.
function templateFix(dir, name) {
  if (!isRepoTemplate(dir, name)) return editsFor(path.join(dir, name, "config.json"));
  return `copy it under a new name: ${copyRecipe(path.join(playbookDirs()[0], "NAME"))}`;
}

// flow init --playbook <name> without --repo: the name must exist and not be a template.
// Here no state dir exists yet, so the repo's template under its own name is scaffolded
// with --repo; a folder linked to it under another name gets the copy fix, because init
// --repo would refuse that taken name.
export function checkInitPlaybook(name) {
  const dir = playbookDir(name);
  if (dir === null) refuseMissing(name);
  if (isTemplate(readConfig(path.join(dir, name, "config.json")))) {
    if (name === TEMPLATE && isRepoTemplate(dir, name)) fail(`${name} is a template; use --repo <path>`, "flow init --playbook <name> --repo <path>");
    fail(`${name} is a template`, templateFix(dir, name));
  }
}

export function loadPlaybook(name) {
  // Resolved once: a second lookup could land elsewhere if a copy is changing meanwhile.
  const dir = playbookDir(name);
  if (dir === null) refuseMissing(name);
  const file = path.join(dir, name, "config.json");
  const config = readConfig(file);
  // Before the key and repo checks: the template's placeholder repo does not exist, and
  // "is a template" is the message that says what to do.
  if (isTemplate(config)) fail(`${name} is a template`, templateFix(dir, name));
  for (const key of ["repo", "linearWorkspaceUrl", "permissionMode", "models", "defaults"]) {
    if (config[key] === undefined) fail(`${file} has no "${key}"`, `add "${key}" to ${file}`);
  }
  for (const role of ROLES) {
    if (!Array.isArray(config.defaults[role]) || config.defaults[role].length !== 2) {
      fail(`${file} defaults.${role} is not [model, effort]`, `set defaults.${role} in ${file}, e.g. ["opus", "high"]`);
    }
  }
  const repo = expandHome(config.repo);
  if (!fs.existsSync(repo)) {
    fail(`repo ${repo} of playbook ${name} does not exist`, `clone it there, or fix "repo" in ${file}`);
  }
  // The real path: claude records worktree paths from its resolved cwd (/var → /private/var
  // on macOS), and rollback matches jobs by worktree path.
  return { ...config, name, repo: fs.realpathSync(repo) };
}

// A playbook name a refusal can suggest: lowercased, every run of other characters a dash.
function suggestName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "my-repo";
}

// A path that exists in any form, a dangling symlink included (existsSync says no to one).
function pathTaken(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
}

// A folder whose config.json carries the template mark; an unreadable one is not, nor one
// that is not a regular file (a FIFO would block the read, and with it a refusal).
function isTemplateFolder(folder) {
  try {
    const file = path.join(folder, "config.json");
    if (!fs.statSync(file).isFile()) return false;
    return isTemplate(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return false;
  }
}

// flow init --playbook <name> --repo <path> [--linear <url>] [--base <branch>]: copies
// the repo's own playbooks/example to the first playbooks directory as <name>, with
// repo, linearWorkspaceUrl and baseBranch set, then creates the state dir with <name>
// as its default playbook. Everything is checked before anything is written; if any
// later step fails (the copy, the config write, the state dir), what this run created
// is removed again and named in error.removed; a <name> folder that cannot be removed is
// refused instead, naming it and the original error (rollBack).
export function scaffoldPlaybook(name, { repo, linear, base } = {}) {
  if (!NAME.test(name)) {
    fail(`playbook name ${JSON.stringify(name)} is not a name (lowercase letters, digits, dashes)`, `use a name matching ${NAME.source}, e.g. ${suggestName(name)}`);
  }
  const dirs = playbookDirs();
  const target = path.join(dirs[0], name);
  const source = path.join(REPO_PLAYBOOKS, TEMPLATE);
  // mkdir -p first: the private directory may not exist yet, and cp -R then fails. When
  // <name> is already there (init run twice), cp would nest a copy inside it: use it instead.
  const stateFix = pathTaken(target)
    ? `the playbook exists; spawn with --playbook ${name}, or pick another name: ${target}`
    : copyRecipe(target);
  checkStateDirFree({ fix: stateFix });
  if (repo === "") fail("--repo is empty", "pass the path of your clone: --repo <path>");
  const repoPath = path.resolve(expandHome(repo));
  if (!fs.existsSync(repoPath)) fail(`repo ${repoPath} does not exist`, `clone your repo first, or pass --repo <path of your clone>: ${repoPath}`);
  // The same check spawn makes, here before anything is written: found at the first
  // spawn, the mistake would sit in a state dir that init then refuses to make again.
  const topLevel = git(repoPath, ["rev-parse", "--show-toplevel"], { allowFail: true })?.trim();
  if (!topLevel) fail(`repo ${repoPath} is not a git repo`, `pass the top folder of your clone: ${repoPath}`);
  if (fs.realpathSync(topLevel) !== fs.realpathSync(repoPath)) fail(`repo ${repoPath} is not the top of its git repo (${topLevel})`, `pass --repo ${topLevel}`);
  if (linear !== undefined && !LINEAR_URL.test(linear)) {
    fail(`--linear needs a URL; ${JSON.stringify(linear)} is not one`, `pass your workspace, e.g. --linear https://linear.app/<your-workspace>`);
  }
  // WHY: the keeper passes baseBranch to git as an argument; a leading dash would be an
  // option. The pattern keeps dashes out before git sees the value; git then applies its
  // own branch-name rules (no "..", no ".lock" ending, …).
  if (base !== undefined && (!BRANCH.test(base) || git(repoPath, ["check-ref-format", "--branch", base], { allowFail: true }) === null)) {
    fail(`--base needs a branch name; ${JSON.stringify(base)} is not one`, "pass the branch PRs go into, e.g. --base main");
  }
  // WHY any path, with or without config.json: the scaffold must never shadow a repo
  // playbook of the same name, nor merge into a half-made folder.
  for (const dir of dirs) {
    const existing = path.join(dir, name);
    if (!pathTaken(existing)) continue;
    // The repo's template itself: running init without --repo would only be refused again.
    const fix = isRepoTemplate(dir, name) && isTemplateFolder(existing) ? `pick another name; ${name} is the template: ${dir}` : `pick another name, or run flow init --playbook ${name} without --repo: ${dir}`;
    fail(`playbook ${JSON.stringify(name)} already exists in ${dir}`, fix);
  }
  if (!fs.existsSync(path.join(source, "config.json"))) fail(`template playbooks/${TEMPLATE} missing in ${REPO_ROOT}`, `git checkout -- playbooks/${TEMPLATE}`);
  // Read before any write, so a broken template is refused naming the template's file.
  const config = readConfig(path.join(source, "config.json"));
  delete config.template;
  config.repo = fs.realpathSync(repoPath);
  if (linear !== undefined) config.linearWorkspaceUrl = linear;
  if (base !== undefined) config.baseBranch = base;

  // Each folder is claimed with a plain mkdir, which throws if it appeared meanwhile, so
  // the rollback only ever removes a folder this run made.
  let createdParent = false;
  let createdTarget = false;
  try {
    if (!pathTaken(dirs[0])) {
      fs.mkdirSync(path.dirname(dirs[0]), { recursive: true });
      fs.mkdirSync(dirs[0]);
      createdParent = true;
    }
    fs.mkdirSync(target);
    createdTarget = true;
    // Entry by entry into the folder just claimed: cpSync onto an existing directory
    // throws EEXIST on Linux (not on macOS), and none of the entries exists yet.
    for (const entry of fs.readdirSync(source)) {
      fs.cpSync(path.join(source, entry), path.join(target, entry), { recursive: true, errorOnExist: true, force: false });
    }
    fs.writeFileSync(path.join(target, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    const stateDir = initState({ playbook: name });
    return { playbookDir: target, stateDir, placeholder: linear === undefined };
  } catch (error) {
    error.removed = rollBack(error, createdTarget && target, createdParent && dirs[0]);
    throw error;
  }
}

// Removes the <name> folder this run made, then the playbooks directory if this run made
// it and it is empty: another init may have put its own playbook there meanwhile, and
// that directory then stays (ENOTEMPTY). Returns the folders removed.
// A <name> folder that cannot be removed is refused in the fail shape, naming the folder
// and the error that started the rollback, so neither is lost.
function rollBack(cause, target, parent) {
  const removed = [];
  if (target) {
    try {
      testFault("rollback");
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      fail(`${cause.what ?? cause.message}; and could not remove ${target} (${error.code ?? error.message})`, `move it away by hand, then run flow init again: ${target}`);
    }
    removed.push(target);
  }
  if (parent) {
    try {
      fs.rmdirSync(parent);
      removed.splice(0, removed.length, parent);
    } catch {
      // ENOTEMPTY: another run's playbook is in it. It is not ours to remove.
    }
  }
  return removed;
}

// --model takes a key of config.models or a full id starting "claude-".
export function resolveModel(config, value) {
  if (Object.hasOwn(config.models, value)) return config.models[value];
  if (typeof value === "string" && value.startsWith("claude-")) return value;
  fail(`model ${JSON.stringify(value)} is not a key of playbook ${config.name}'s models or a claude-… id`, `use one of: ${Object.keys(config.models).join(", ")}`);
}

export function checkEffort(value) {
  if (!EFFORTS.includes(value)) fail(`effort ${JSON.stringify(value)} is not one of ${EFFORTS.join(", ")}`, `use one of: ${EFFORTS.join(", ")}`);
  return value;
}
