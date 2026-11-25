// Shared test setup: every test gets its own temp state dir, fake claude home,
// playbooks dir and scratch git repo, so no test touches ~/.claude, the real state
// dir or a real repo. The real claude binary is never called (FLOW_CLAUDE is the fake).

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FLOW = path.join(ROOT, "bin", "flow.mjs");
export const FAKE_CLAUDE = path.join(ROOT, "test", "fixtures", "fake-claude.mjs");
const FIXTURE_PLAYBOOK_DIR = path.join(ROOT, "test", "fixtures", "playbooks", "test");
export const FIXED_NOW = "2026-10-26T09:00:00Z";

export function gitIn(cwd, args) {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", ...args], { cwd, encoding: "utf8" });
}

// Removes a test's temp dir. A process the test started can still be writing into it
// when the test ends on a loaded machine (one candidate: the detached `git maintenance
// run --auto` that git starts after every commit), so the walk can find a dir it just
// emptied not empty again (ENOTEMPTY). So the whole remove starts over, waiting 100 ms,
// 200 ms, … up to 10 times (5.5 s in all) before giving up. rmSync's own maxRetries is
// not enough: on Node 22 it only retries the last rmdir and never empties the dir again.
const RETRY_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "EMFILE", "ENFILE"]);
export function removeTempDir(dir) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!RETRY_CODES.has(error.code) || attempt > 10) throw error;
      // A synchronous sleep: teardown runs in t.after, and the dir must be gone when it returns.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 100);
    }
  }
}

// t: the node:test context (cleans up after the test).
// { home: true }: the two-directory variant. FLOW_PLAYBOOKS is not set and HOME is the
// temp root, so playbooks resolve from <root>/.product-dev-flow/playbooks (where the
// `test` playbook goes, ctx.playbooks) and then the repo's playbooks/.
export function setup(t, { home = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-test-")));
  t.after(() => removeTempDir(root));

  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  gitIn(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "scratch repo\n");
  gitIn(repo, ["add", "-A"]);
  gitIn(repo, ["commit", "-q", "-m", "scratch"]);

  const claudeHome = path.join(root, "claude");
  fs.mkdirSync(path.join(claudeHome, "jobs"), { recursive: true });

  const playbooks = home ? path.join(root, ".product-dev-flow", "playbooks") : path.join(root, "playbooks");
  // The whole fixture playbook (config.json, common.md, one <role>.md per role), so the
  // card snapshots render from fixed text of the test's own, then its repo is the scratch repo.
  fs.mkdirSync(playbooks, { recursive: true });
  fs.cpSync(FIXTURE_PLAYBOOK_DIR, path.join(playbooks, "test"), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(FIXTURE_PLAYBOOK_DIR, "config.json"), "utf8"));
  fs.writeFileSync(path.join(playbooks, "test", "config.json"), JSON.stringify({ ...config, repo }, null, 2));

  // Role briefs for cards; empty until a test writes one (the repo's roles/ is not read).
  const roles = path.join(root, "roles");
  fs.mkdirSync(roles);

  const state = path.join(root, "state");
  const fakeLog = path.join(root, "fake-claude.log");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("FLOW_") || key.startsWith("FAKE_CLAUDE")) delete env[key];
  Object.assign(env, {
    FLOW_STATE: state,
    FLOW_CLAUDE: FAKE_CLAUDE,
    FLOW_CLAUDE_HOME: claudeHome,
    FLOW_PLAYBOOKS: playbooks,
    FLOW_ROLES: roles,
    FLOW_NOW: FIXED_NOW,
    FAKE_CLAUDE_LOG: fakeLog,
  });
  if (home) {
    delete env.FLOW_PLAYBOOKS;
    env.HOME = root;
  }

  const ctx = {
    root,
    repo,
    claudeHome,
    playbooks,
    roles,
    state,
    env,
    run(args, extraEnv = {}) {
      const result = spawnSync(process.execPath, [FLOW, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 120_000 });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    runAsync(args, extraEnv = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [FLOW, ...args], { env: { ...env, ...extraEnv } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
    },
    init() {
      const result = ctx.run(["init", "--playbook", "test"]);
      assert.equal(result.status, 0, result.stderr);
    },
    commits() {
      return gitIn(state, ["log", "--format=%s"]).trim().split("\n").filter(Boolean);
    },
    stateFiles() {
      return gitIn(state, ["ls-files"]).trim().split("\n").filter(Boolean).sort();
    },
    untracked() {
      return gitIn(state, ["status", "--porcelain"]).trim();
    },
    readJson(relative) {
      return JSON.parse(fs.readFileSync(path.join(state, relative), "utf8"));
    },
    // Writes files into the state dir and commits them, as if an earlier command had.
    seed(files, message = "seed") {
      for (const [relative, value] of Object.entries(files)) {
        const file = path.join(state, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
      }
      gitIn(state, ["add", "-A"]);
      gitIn(state, ["commit", "-q", "-m", message]);
    },
    fakeCalls() {
      if (!fs.existsSync(fakeLog)) return [];
      return fs.readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    jobIds() {
      return fs.readdirSync(path.join(claudeHome, "jobs")).filter((name) => fs.existsSync(path.join(claudeHome, "jobs", name, "state.json")));
    },
    worktreeExists(slug) {
      return fs.existsSync(path.join(repo, ".claude", "worktrees", slug));
    },
    branchExists(branch) {
      return spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo }).status === 0;
    },
  };
  return ctx;
}

// d5: a refusal's first stderr line names the operation and the offending value,
// its last line is `fix: …`.
export function assertRefusal(result, { code = 1, first, fix }) {
  assert.equal(result.status, code, `exit ${result.status}, stderr:\n${result.stderr}`);
  const lines = result.stderr.trimEnd().split("\n");
  assert.match(lines[0], first);
  assert.match(lines.at(-1), /^fix: \S/);
  if (fix) assert.match(lines.at(-1), fix);
}

// Archives a record by hand: only the status, without flow archive's claude stop and unpin.
export function archive(ctx, slug) {
  const record = ctx.readJson(`sessions/${slug}/record.json`);
  ctx.seed({ [`sessions/${slug}/record.json`]: { ...record, status: "archived" } }, `archive ${slug}`);
}
