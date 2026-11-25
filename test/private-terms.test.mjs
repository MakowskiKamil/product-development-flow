// The private-terms guard (lib/privateTerms.mjs): the live run on this repo, then unit
// tests on temp git repos with made-up terms. No real private term appears here: the
// real list lives outside the repo and only the maintainer writes it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FlowError } from "../lib/fail.mjs";
import { formatHit, parseTerms, scanPrivateTerms } from "../lib/privateTerms.mjs";
import { ROOT, gitIn, removeTempDir } from "./helpers.mjs";

const DEFAULT_LIST = path.join(os.homedir(), ".product-dev-flow", "private-terms.txt");
const THIS_FILE = path.join(ROOT, "test", "private-terms.test.mjs");

// A made-up term, spelled out once in this comment line and nowhere else in the repo:
// guard-canary-q7x. The self-check below builds it from parts, so only this line hits.
const CANARY = ["guard", "canary", "q7x"].join("-");
const CANARY_LINE = fs.readFileSync(THIS_FILE, "utf8").split("\n").findIndex((line) => line.includes(CANARY)) + 1;

// protects: the repo (tracked and untracked-but-not-ignored files) holds no term of the maintainer's list
// fails_when: a file or a path contains a listed term; the failure names file, line and index, never the term
// no_claim: anything on a machine without the list (skipped) or in a binary file (UTF-16 text counts as binary); the index `git commit` takes (the worktree is read, so a term staged then removed from the worktree passes); a term in another Unicode form (no normalization); commit messages, branch names and PR titles
test("the live guard: no private term in the repo", (t) => {
  const termsFile = process.env.FLOW_PRIVATE_TERMS_FILE || DEFAULT_LIST;
  const result = scanPrivateTerms(ROOT, termsFile);
  if (result.skipped) {
    t.skip(`no private term list at ${termsFile} (maintainer's guard; expected on any other machine)`);
    return;
  }
  if (result.hits.length) assert.fail(result.hits.map((hit) => formatHit(hit, termsFile)).join("\n"));
});

// Runs only the live guard in a child `node --test` with the given list path.
function runLiveGuard(termsFile) {
  const env = { ...process.env, FLOW_PRIVATE_TERMS_FILE: termsFile };
  delete env.NODE_TEST_CONTEXT; // a nested runner must report as a top-level one; tap: one output shape on Node 22 and 24
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^the live guard", THIS_FILE], { env, encoding: "utf8" });
}

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-terms-")));
  t.after(() => removeTempDir(dir));
  return dir;
}

// A temp git repo with the given files committed; returns its path.
function tempRepo(t, files) {
  const repo = path.join(tempDir(t), "repo");
  fs.mkdirSync(repo);
  gitIn(repo, ["init", "-q", "-b", "main"]);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content);
  }
  gitIn(repo, ["add", "-A"]);
  gitIn(repo, ["commit", "-q", "--allow-empty", "-m", "fixture"]);
  return repo;
}

function tempList(t, content) {
  const file = path.join(tempDir(t), "terms.txt");
  fs.writeFileSync(file, content);
  return file;
}

// protects: a missing list skips the live guard with the list's path named, so `npm test` shows the skip
// fails_when: a missing list passes silently, fails, or the skip message does not name the path
// no_claim: what CI prints (the PR run is observed on GitHub)
test("without a list the live guard is reported skipped with the path", (t) => {
  const missing = path.join(tempDir(t), "nope", "terms.txt");
  const result = runLiveGuard(missing);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# skipped 1/);
  assert.ok(result.stdout.includes(`no private term list at ${missing} (maintainer's guard; expected on any other machine)`), result.stdout);
});

// protects: a live hit fails `npm test` with `<file>:<line> contains private term #<n>` and the fix line, and the output never carries the term
// fails_when: the run passes, names the wrong line or index, or prints the term anywhere in its output
// no_claim: that GitHub masks the secret (the term never reaches the log, so masking is not needed)
test("a live hit fails naming file, line and index only", (t) => {
  const list = tempList(t, `# made-up list\n\n${CANARY}\n`);
  const result = runLiveGuard(list);
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.ok(output.includes(`test/private-terms.test.mjs:${CANARY_LINE} contains private term #3`), output);
  assert.ok(output.includes(`fix: term #3 is line 3 of the list (${list} locally, the PRIVATE_TERMS secret in CI); edit test/private-terms.test.mjs:${CANARY_LINE}`), output);
  assert.equal(output.toLowerCase().includes(CANARY), false, "the term itself is in the output");
});

// protects: a planted term is found by file, line and list index; matching ignores case; the clean tree passes
// fails_when: the hit is missed, has the wrong line or index, matching is case-sensitive, or a clean file hits
// no_claim: matches across a line break (the scan is per line)
test("a planted term is found by file, line and index; the clean tree passes", (t) => {
  const list = tempList(t, "# comment\n\nzebra-quartz\n");
  const repo = tempRepo(t, { "notes.txt": "hello\nthe Zebra-QUARTZ is here\n", "clean.md": "nothing to see\n" });
  assert.deepEqual(scanPrivateTerms(repo, list), { hits: [{ file: "notes.txt", line: 2, term: 3 }] });
  const message = formatHit({ file: "notes.txt", line: 2, term: 3 }, list);
  assert.equal(message, `notes.txt:2 contains private term #3\nfix: term #3 is line 3 of the list (${list} locally, the PRIVATE_TERMS secret in CI); edit notes.txt:2`);

  fs.writeFileSync(path.join(repo, "notes.txt"), "hello\n");
  assert.deepEqual(scanPrivateTerms(repo, list), { hits: [] });
});

// protects: the list parses as one trimmed term per line, CRLF and BOM tolerated, blanks and # comments ignored, index = line in the file
// fails_when: a comment or blank becomes a term, a BOM or \r sticks to a term, or the index skips comments
// no_claim: inline comments (a # after a term is part of the term)
test("the list ignores comments and blanks and tolerates CRLF and a BOM", (t) => {
  const text = "\uFEFF# first line comment\r\n\r\n   Alpha-Term  \r\n#beta-term\r\n  # indented comment\r\ngamma\r\n";
  assert.deepEqual(parseTerms(text), [
    { index: 3, text: "alpha-term" },
    { index: 6, text: "gamma" },
  ]);
  const list = tempList(t, text);
  const repo = tempRepo(t, { "a.txt": "beta-term and first line comment\nALPHA-TERM\n" });
  assert.deepEqual(scanPrivateTerms(repo, list), { hits: [{ file: "a.txt", line: 2, term: 3 }] });
});

// protects: only a missing list skips; a list that exists but cannot be read fails in the `fail` shape
// fails_when: an unreadable list is taken as "no list" and the guard silently skips
// no_claim: the EACCES case when tests run as root (root reads any file); the directory case covers it there
test("an unreadable list fails, a missing one skips", (t) => {
  const repo = tempRepo(t, { "a.txt": "x\n" });
  const missing = path.join(tempDir(t), "missing.txt");
  assert.deepEqual(scanPrivateTerms(repo, missing), { skipped: true });

  const dirList = tempDir(t);
  assert.throws(
    () => scanPrivateTerms(repo, dirList),
    (error) => error instanceof FlowError && error.what === `cannot read private term list ${dirList} (EISDIR)` && error.fix === `fix its permissions or point FLOW_PRIVATE_TERMS_FILE at a readable file: ${dirList}`,
  );

  if (process.getuid?.() === 0) return;
  const locked = tempList(t, "x\n");
  fs.chmodSync(locked, 0o000);
  assert.throws(() => scanPrivateTerms(repo, locked), (error) => error instanceof FlowError && error.what === `cannot read private term list ${locked} (EACCES)`);
});

// protects: a path that contains a term is never printed, neither for the path hit nor for line hits inside it
// fails_when: the file name (and so the term) appears in a hit or its message
// no_claim: that the k in `tracked path #k` survives files being added between two runs
test("a path with a term in it is masked", (t) => {
  const list = tempList(t, "zebra-quartz\n");
  const repo = tempRepo(t, { "a.txt": "x\n", "docs/Zebra-Quartz.md": "one\nzebra-quartz again\n" });
  const { hits } = scanPrivateTerms(repo, list);
  const file = "tracked path #2 (git ls-files order)";
  assert.deepEqual(hits, [
    { file, line: null, term: 1, pathIndex: 2 },
    { file, line: 2, term: 1, pathIndex: 2 },
  ]);
  const messages = hits.map((hit) => formatHit(hit, list));
  assert.equal(messages[0].split("\n")[0], `${file} contains private term #1`);
  assert.equal(messages[1].split("\n")[0], `${file}:2 contains private term #1`);
  for (const message of messages) {
    assert.equal(message.toLowerCase().includes("zebra"), false, message);
    assert.match(message, /sed -n 2p/);
  }
});

// protects: untracked files that are not ignored are scanned (about to be committed); ignored files are not
// fails_when: a new file written before `git add -A` is missed, or an ignored file (local junk) fails the guard
// no_claim: files ignored through a global excludes file on another machine
test("untracked files are scanned, ignored files are not", (t) => {
  const list = tempList(t, "zebra-quartz\n");
  const repo = tempRepo(t, { ".gitignore": "ignored.txt\n" });
  fs.writeFileSync(path.join(repo, "new.txt"), "zebra-quartz\n");
  fs.writeFileSync(path.join(repo, "ignored.txt"), "zebra-quartz\n");
  assert.deepEqual(scanPrivateTerms(repo, list), { hits: [{ file: "new.txt", line: 1, term: 1 }] });
});

// protects: a tracked file deleted in the worktree is skipped, not an error
// fails_when: the guard crashes on a file `git rm` has not caught up with yet
// no_claim: that the deleted file's committed content is clean (history is not scanned)
test("a tracked file deleted in the worktree is skipped", (t) => {
  const list = tempList(t, "zebra-quartz\n");
  const repo = tempRepo(t, { "gone.txt": "zebra-quartz\n", "kept.txt": "fine\n" });
  fs.rmSync(path.join(repo, "gone.txt"));
  assert.deepEqual(scanPrivateTerms(repo, list), { hits: [] });
});

// protects: a file with a NUL byte in its first 8 KiB is skipped as binary; a NUL later does not hide a text file
// fails_when: binary files are scanned as text, or a late NUL makes a text file skip
// no_claim: that a binary file holds no term (binary files are not checked at all)
test("binary files are skipped by their first 8 KiB", (t) => {
  const list = tempList(t, "zebra-quartz\n");
  const early = Buffer.from("\0zebra-quartz\n");
  const late = Buffer.concat([Buffer.from("zebra-quartz\n"), Buffer.alloc(9000, 0x61), Buffer.from([0])]);
  const repo = tempRepo(t, { "image.bin": early, "late.txt": late });
  assert.deepEqual(scanPrivateTerms(repo, list), { hits: [{ file: "late.txt", line: 1, term: 1 }] });
});

// protects: a symlink is checked by its target string (what git stores), not by following it
// fails_when: a link whose target names a term passes, or a link to a directory crashes the scan
// no_claim: the content of the file the link points at (that file is scanned on its own if tracked)
test("a symlink is scanned as its target", (t) => {
  const list = tempList(t, "zebra-quartz\n");
  const repo = tempRepo(t, {});
  fs.mkdirSync(path.join(repo, "dir"));
  fs.writeFileSync(path.join(repo, "dir", "keep"), "fine\n");
  fs.symlinkSync("/opt/zebra-quartz/data", path.join(repo, "link"));
  fs.symlinkSync("dir", path.join(repo, "dirlink"));
  assert.deepEqual(scanPrivateTerms(repo, list), { hits: [{ file: "link", line: 1, term: 1 }] });
});

// protects: a root that is not a git checkout fails in the `fail` shape instead of scanning nothing
// fails_when: a wrong root (or no git) makes the guard pass with zero files
// no_claim: that rootDir is the top of the checkout (a subdirectory scans only itself)
test("a root that is not a git checkout fails", (t) => {
  const list = tempList(t, "zebra-quartz\n");
  const dir = tempDir(t);
  assert.throws(
    () => scanPrivateTerms(dir, list),
    (error) => error instanceof FlowError && error.what === `not a git checkout: ${dir}` && error.fix === `run inside a clone of the repo: ${dir}`,
  );
});

// protects: a file that cannot be read fails with its path masked (the path may be what leaks)
// fails_when: the read error is swallowed, or its message prints the path
// no_claim: the root case (root reads any file; the test returns early there)
test("an unreadable repo file fails with the path masked", (t) => {
  if (process.getuid?.() === 0) return;
  const list = tempList(t, "zebra-quartz\n");
  const repo = tempRepo(t, { "a.txt": "x\n", "secret-name.txt": "y\n" });
  fs.chmodSync(path.join(repo, "secret-name.txt"), 0o000);
  assert.throws(
    () => scanPrivateTerms(repo, list),
    (error) => error instanceof FlowError && error.what === "cannot read tracked path #2 (EACCES)" && !`${error.what}${error.fix}`.includes("secret-name"),
  );
});

// protects: a list that exists but holds no terms (comments and blank lines only) fails instead of passing
// fails_when: a comment-only list or PRIVATE_TERMS secret makes the guard green while it checks nothing
// no_claim: that the terms in a non-empty list are the right ones
test("a list with no terms fails", (t) => {
  const repo = tempRepo(t, { "a.txt": "x\n" });
  const list = tempList(t, "# only a comment\n\n   \n");
  assert.throws(
    () => scanPrivateTerms(repo, list),
    (error) => error instanceof FlowError && error.what === `private term list ${list} has no terms` && error.fix === "add one term per line, or remove the file to skip the guard",
  );
});

// protects: a directory in the git listing (an untracked nested repo, a submodule) is skipped, not a read error
// fails_when: a scratch clone inside the checkout turns `npm test` red with EISDIR and a "fix its permissions" hint
// no_claim: the nested repo's own files (they belong to that repo); its path is still checked
test("a nested git repo in the checkout is skipped, its path still checked", (t) => {
  const list = tempList(t, "zebra-quartz\n");
  const repo = tempRepo(t, { "a.txt": "x\n" });
  for (const name of ["inner", "zebra-quartz-clone"]) {
    const inner = path.join(repo, name);
    fs.mkdirSync(inner);
    gitIn(inner, ["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(inner, "f.txt"), "zebra-quartz\n");
    gitIn(inner, ["add", "-A"]);
    gitIn(inner, ["commit", "-q", "-m", "inner"]);
  }
  const file = "tracked path #2 (git ls-files order)"; // git lists untracked entries first
  assert.deepEqual(scanPrivateTerms(repo, list), { hits: [{ file, line: null, term: 1, pathIndex: 2 }] });
});
