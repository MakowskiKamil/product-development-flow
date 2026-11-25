import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeTempDir } from "./helpers.mjs";

// A second process that keeps adding files to <dir>/sub for 1.5 s after its first
// file, or until sub is gone. It says "ready" after that first file, so it is writing
// when the test acts. It stands in for whatever a test left running at teardown:
// busy for a while, then done.
const WRITER = `
const fs = require("node:fs"), path = require("node:path");
const sub = process.argv[1];
let end = Infinity;
for (let i = 0; Date.now() < end; i++) {
  try { fs.writeFileSync(path.join(sub, "w" + i), ""); } catch { break; }
  if (i === 0) { end = Date.now() + 1500; process.stdout.write("ready\\n"); }
}
`;

// Starts the writer on a fresh dir and resolves once it is writing. The 200 files
// already in sub make a plain remove slow enough that the writer lands a new file
// between the walk emptying sub and removing it.
async function busyDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-busy-")));
  const sub = path.join(dir, "sub");
  fs.mkdirSync(sub);
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(sub, `p${i}`), "");
  const writer = spawn(process.execPath, ["-e", WRITER, sub]);
  const closed = new Promise((resolve) => writer.once("close", resolve));
  t.after(async () => {
    writer.kill();
    await closed;
    removeTempDir(dir);
  });
  // A writer that dies before its first file would otherwise leave the test waiting forever.
  const ready = await Promise.race([new Promise((resolve) => writer.stdout.once("data", () => resolve(true))), closed.then(() => false)]);
  assert.ok(ready, "the writer exited before writing its first file");
  return { dir, closed };
}

// protects: removeTempDir removes a temp dir while another process is still writing into it (PRO-11: teardown ENOTEMPTY under load)
// fails_when: removeTempDir throws ENOTEMPTY or leaves the dir behind, e.g. because its retries were dropped (with a plain recursive rmSync in its place this test failed in 10 of 10 runs on a loaded Mac, 2026-10-28)
// no_claim: that the race fires on every run (the writer can be descheduled for the whole remove, then this passes without exercising a retry); that 5.5 s of retries outlasts every writer (this one stops after 1.5 s)
test("removeTempDir survives a process still writing into the dir", async (t) => {
  for (let round = 0; round < 2; round++) {
    const busy = await busyDir(t);
    removeTempDir(busy.dir);
    assert.equal(fs.existsSync(busy.dir), false);
    await busy.closed;
    assert.equal(fs.existsSync(busy.dir), false, "the writer recreated nothing");
  }
});
