import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { formatError } from "../lib/fail.mjs";
import { FLOW, ROOT, assertRefusal, setup } from "./helpers.mjs";

// protects: bin/flow.mjs runs directly (shebang + executable bit), as the ~/.local/bin/flow symlink needs
// fails_when: the shebang is missing or the file is not executable
// no_claim: that ~/.local/bin is on PATH in sessions
test("bin/flow.mjs has a node shebang and the executable bit", () => {
  assert.equal(fs.readFileSync(FLOW, "utf8").split("\n")[0], "#!/usr/bin/env node");
  assert.ok(fs.statSync(FLOW).mode & 0o111, "not executable");
});

// protects: no args exits 1, --help exits 0, an unknown command exits 1; each prints every command with one usage line
// fails_when: an exit code differs, or a command is missing from the list
// no_claim: that the usage text is complete documentation (README is)
test("no args, --help and unknown command print the command list", (t) => {
  const ctx = setup(t);
  const help = ctx.run(["--help"]);
  assert.equal(help.status, 0);
  const lines = help.stdout.trim().split("\n");
  assert.equal(lines[0], "usage:");
  assert.deepEqual(lines.slice(1).map((line) => line.trim().split(" ")[1]), ["init", "spawn", "plan", "phase", "note", "refresh", "tree", "set", "archive"]);

  const none = ctx.run([]);
  assertRefusal(none, { first: /^flow: no command given$/, fix: /commands above/ });
  assert.match(none.stderr, /flow init/);
  assert.match(none.stderr, /flow spawn/);

  const unknown = ctx.run(["frobnicate"]);
  assertRefusal(unknown, { first: /^flow: unknown command "frobnicate"$/ });
  assert.match(unknown.stderr, /flow spawn/);

  for (const inherited of ["constructor", "toString", "__proto__"]) {
    assertRefusal(ctx.run([inherited]), { first: new RegExp(`^flow: unknown command "${inherited}"$`) });
  }
});

// protects: an unexpected error (not a refusal) keeps the d5 shape: operation on the first line, fix on the last
// fails_when: the generic branch drops the operation or the fix line
// no_claim: which real failures reach this branch
test("unexpected errors keep the refusal shape", () => {
  const lines = formatError("flow spawn", new Error("disk full")).split("\n");
  assert.equal(lines[0], "flow spawn: unexpected error: disk full");
  assert.match(lines.at(-1), /^fix: \S/);
});

// protects: under node --test, flow refuses to run unless FLOW_STATE, FLOW_CLAUDE and FLOW_CLAUDE_HOME are set
// fails_when: a test without the helper could reach the real state dir, claude or ~/.claude
// no_claim: protection outside node --test
test("flow refuses to run under node --test without the test env", (t) => {
  const ctx = setup(t);
  for (const key of ["FLOW_STATE", "FLOW_CLAUDE", "FLOW_CLAUDE_HOME"]) {
    const env = { ...ctx.env };
    delete env[key];
    const result = spawnSync(process.execPath, [FLOW, "init"], { env, encoding: "utf8" });
    assertRefusal({ status: result.status, stderr: result.stderr }, { first: new RegExp(`node --test without ${key}`) });
  }
  assert.equal(fs.existsSync(ctx.state), false);
});

// protects: FLOW_TEST_FAIL has no effect outside node --test
// fails_when: a stray FLOW_TEST_FAIL in a real shell makes a real command fail
// no_claim: anything about other env vars
test("FLOW_TEST_FAIL is ignored outside the test context", (t) => {
  const ctx = setup(t);
  ctx.init();
  const env = { ...ctx.env, FLOW_TEST_FAIL: "commit" };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [FLOW, "spawn", "initiative", "I-1", "--name", "Real"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ctx.commits()[0], "spawn i-1: (I)·Real I-1");
});

// protects: package.json matches the spec: bin flow, ES modules, no dependencies, node >= 22
// fails_when: a dependency is added or the bin entry moves
// no_claim: that npm link/install works (README install uses a symlink)
test("package.json has no dependencies and the flow bin", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.bin, { flow: "bin/flow.mjs" });
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.engines.node, ">=22");
});

// protects: every test in test/ carries its protects / fails_when / no_claim card directly above it
// fails_when: a test is added without the three comment lines right above it
// no_claim: that the cards are true (review judges that)
test("every test has its card", () => {
  const dir = path.join(ROOT, "test");
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".test.mjs"))) {
    const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!/^test\(/.test(line)) return;
      const card = lines.slice(index - 3, index);
      assert.match(card[0] ?? "", /^\/\/ protects: \S/, `${file}:${index + 1} has no protects line`);
      assert.match(card[1] ?? "", /^\/\/ fails_when: \S/, `${file}:${index + 1} has no fails_when line`);
      assert.match(card[2] ?? "", /^\/\/ no_claim: \S/, `${file}:${index + 1} has no no_claim line`);
    });
  }
});
