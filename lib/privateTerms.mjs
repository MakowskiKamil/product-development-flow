// The private-terms guard: fails when a term from the maintainer's private list shows
// up in a file (or a file's path) of the repo. The list lives outside the repo, because
// the list is itself private; the caller passes its path (test/private-terms.test.mjs
// uses FLOW_PRIVATE_TERMS_FILE, default ~/.product-dev-flow/private-terms.txt; CI writes
// the PRIVATE_TERMS secret to a file and points FLOW_PRIVATE_TERMS_FILE at it).
// WHY hits carry the term's index and never its text: CI logs of a public repo are
// public, so printing the term would leak it in the very report that catches it.
// What it is: a net, not a lock. Locally it runs inside `npm test` before a commit; in
// CI it is a second net for the maintainer's branches and main; fork PRs get no secret.

import fs from "node:fs";
import path from "node:path";
import { fail } from "./fail.mjs";
import { git } from "./state.mjs";

// git looks at the first 8000 bytes for a NUL to call a file binary; 8 KiB is close.
const BINARY_SNIFF_BYTES = 8192;
const LS_FILES = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];

// One term per line, trimmed, CRLF and a leading BOM tolerated, blank lines and
// `#` comments ignored. `index` is the 1-based line number in the list as written
// (comments and blanks counted), so `sed -n <index>p <list>` shows the term.
export function parseTerms(text) {
  const terms = [];
  text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (line && !line.startsWith("#")) terms.push({ index: i + 1, text: line.toLowerCase() });
    });
  return terms;
}

// Returns { skipped: true } when the list does not exist (any machine but the
// maintainer's), otherwise { hits } with hits as { file, line, term: <index> }.
// `file` is the path, or `tracked path #<k> (git ls-files order)` when the path itself
// contains a term; then `pathIndex` is k. `line` is null for a hit in the path itself.
export function scanPrivateTerms(rootDir, termsFile) {
  let listText;
  try {
    listText = fs.readFileSync(termsFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { skipped: true };
    fail(`cannot read private term list ${termsFile} (${error.code})`, `fix its permissions or point FLOW_PRIVATE_TERMS_FILE at a readable file: ${termsFile}`);
  }
  const terms = parseTerms(listText);
  // An existing list with no terms would make the guard green while it checks nothing.
  if (!terms.length) fail(`private term list ${termsFile} has no terms`, "add one term per line, or remove the file to skip the guard");

  // Tracked and untracked-but-not-ignored files: a file written a minute before
  // `git add -A` is seen too. -z so no path is quoted or split on a newline.
  const listing = git(rootDir, LS_FILES, { allowFail: true });
  if (listing === null) fail(`not a git checkout: ${rootDir}`, `run inside a clone of the repo: ${rootDir}`);
  const paths = listing.split("\0").filter(Boolean);

  const hits = [];
  const termsIn = (text) => {
    const lower = text.toLowerCase();
    return terms.filter((term) => lower.includes(term.text));
  };

  paths.forEach((relPath, i) => {
    const pathIndex = i + 1;
    const pathTerms = termsIn(relPath);
    // A path with a term in it is never printed, not even next to a line number.
    const file = pathTerms.length ? `tracked path #${pathIndex} (git ls-files order)` : relPath;
    const masked = pathTerms.length ? { pathIndex } : {};
    for (const term of pathTerms) hits.push({ file, line: null, term: term.index, ...masked });

    const content = readForScan(rootDir, relPath, pathIndex);
    if (content === null) return;
    content.split("\n").forEach((text, lineIndex) => {
      for (const term of termsIn(text)) hits.push({ file, line: lineIndex + 1, term: term.index, ...masked });
    });
  });
  return { hits };
}

// The text to scan, or null for a file that is not there to scan: a tracked file
// deleted in the worktree (ENOENT), a binary file, or a directory (git lists an
// untracked nested repo or a submodule as one entry; its files belong to that repo).
// A symlink is scanned as its target string, which is what git stores for it.
function readForScan(rootDir, relPath, pathIndex) {
  const full = path.join(rootDir, relPath);
  try {
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return fs.readlinkSync(full);
    if (stat.isDirectory()) return null;
    const bytes = fs.readFileSync(full);
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
    return bytes.toString("utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // The path is masked here too: it may be the very thing that leaks.
    fail(`cannot read tracked path #${pathIndex} (${error.code})`, `see it with \`git ls-files ${LS_FILES.slice(2).join(" ")} | sed -n ${pathIndex}p\` and fix its permissions`);
  }
}

// The two lines for one hit, in the `fail` shape: what, then what to do next.
// `termsFile` is the list that was used (a local path, or the file CI wrote).
export function formatHit(hit, termsFile) {
  const where = hit.line === null ? hit.file : `${hit.file}:${hit.line}`;
  const list = `term #${hit.term} is line ${hit.term} of the list (${termsFile} locally, the PRIVATE_TERMS secret in CI)`;
  const action =
    hit.line === null
      ? `rename it; \`git ls-files ${LS_FILES.slice(2).join(" ")} | sed -n ${hit.pathIndex}p\` shows it`
      : hit.pathIndex
        ? `edit line ${hit.line} of it and rename it; \`git ls-files ${LS_FILES.slice(2).join(" ")} | sed -n ${hit.pathIndex}p\` shows it`
        : `edit ${where}`;
  return `${where} contains private term #${hit.term}\nfix: ${list}; ${action}`;
}
