// Its own file: this test really waits 45 s, and node --test runs files in parallel.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertRefusal, setup } from "./helpers.mjs";

// protects: a write against a fresh lock held by a live process gives up after the 45 s budget (d6) with exit 1
// fails_when: it gives up much earlier or later, takes the lock, writes anything, or the refusal lacks its lines
// no_claim: behaviour when the holder releases mid-wait (the concurrency test covers waiting then succeeding)
test("held fresh lock: exit 1 after 45 s, nothing written", (t) => {
  const ctx = setup(t);
  ctx.init();
  const lock = path.join(ctx.state, ".lock");
  const content = JSON.stringify({ pid: process.pid, command: "test holder", startedAt: new Date().toISOString() });
  fs.writeFileSync(lock, content);
  const started = Date.now();
  const result = ctx.run(["spawn", "initiative", "I-1", "--name", "A"]);
  const elapsed = Date.now() - started;
  assertRefusal(result, { first: new RegExp(`^flow spawn: state is locked by pid ${process.pid} \\(test holder, since `), fix: /^fix: retry the same command$/ });
  assert.match(result.stderr, /^side effects: none$/m);
  // gstack-timing-ok: the 45 s budget (gate decision d6) is the behaviour under test
  assert.ok(elapsed >= 45_000 && elapsed < 55_000, `gave up after ${elapsed} ms`);
  assert.equal(fs.readFileSync(lock, "utf8"), content);
  assert.deepEqual(ctx.commits(), ["flow init --playbook test"]);
  assert.deepEqual(ctx.fakeCalls(), []);
});
