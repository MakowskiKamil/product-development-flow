import assert from "node:assert/strict";
import test from "node:test";
import { FlowError } from "../lib/fail.mjs";
import {
  checkId,
  checkProjectOrHygiene,
  cleanTitle,
  coordinatorSlug,
  hygieneName,
  initiativeName,
  isId,
  issueName,
  issueSlug,
  projectName,
  pushPath,
  withSuffix,
} from "../lib/ids.mjs";

// protects: each id kind accepts the spec's example (I-9, P-APP-25, APP-309)
// fails_when: a regex is too strict for the owner's Linear naming
// no_claim: that every real Linear id in the workspace matches
test("id patterns accept the spec examples", () => {
  assert.equal(isId("initiative", "I-9"), true);
  assert.equal(isId("project", "P-APP-25"), true);
  assert.equal(isId("issue", "APP-309"), true);
  assert.equal(checkProjectOrHygiene("H"), "H");
});

// protects: malformed ids are refused before anything is written
// fails_when: I9, p-app-25 or FIN309 passes, or an id passes for the wrong kind
// no_claim: the wording of the refusal beyond its first line naming the value
test("id patterns reject I9, p-app-25, FIN309 and cross-kind ids", () => {
  for (const kind of ["initiative", "project", "issue"]) {
    for (const bad of ["I9", "p-app-25", "FIN309", "", " I-9", "I-9 "]) {
      assert.equal(isId(kind, bad), false, `${kind} accepted ${JSON.stringify(bad)}`);
    }
  }
  assert.equal(isId("initiative", "P-APP-25"), false);
  assert.equal(isId("project", "APP-309"), false);
  assert.equal(isId("issue", "I9"), false);
  assert.throws(() => checkId("project", "p-app-25"), (error) => error instanceof FlowError && error.what.includes('"p-app-25"'));
  assert.throws(() => checkProjectOrHygiene("APP-309"), FlowError);
});

// protects: slugs are the lowercased id plus role; hygiene is "hygiene"; suffixes go on slug and name
// fails_when: a slug keeps upper case, or a suffix lands on only one of slug and name
// no_claim: which suffix is free (records.test covers that through spawn)
test("slugs and suffixes", () => {
  assert.equal(coordinatorSlug("initiative", "I-9"), "i-9");
  assert.equal(coordinatorSlug("project", "P-APP-25"), "p-app-25");
  assert.equal(coordinatorSlug("hygiene", "H"), "hygiene");
  assert.equal(issueSlug("APP-309", "review"), "app-309-review");
  assert.deepEqual(withSuffix("app-309-build", "X APP-309 T", 3), { slug: "app-309-build-3", name: "X APP-309 T 3" });
  assert.deepEqual(withSuffix("i-9", "(I)·A I-9", null), { slug: "i-9", name: "(I)·A I-9" });
});

// protects: display names follow the spec's naming table exactly
// fails_when: a separator, bracket or order differs from the spec's examples
// no_claim: that the Claude app shows the name unchanged (live smoke checks that)
test("names follow the spec patterns", () => {
  assert.equal(initiativeName("I-9", "Imports and feeds"), "(I)·Imports and feeds I-9");
  assert.equal(projectName("P-APP-25", "Catalog import", "I-9"), "(P) I-9·Catalog import P-APP-25");
  assert.equal(projectName("P-APP-30", "Name", null), "(P) Name P-APP-30");
  assert.equal(hygieneName(), "(H)·Hygiene");
  assert.equal(issueName({ initiative: "I-9", project: "P-APP-25", issue: "APP-309", title: "Importer block", role: "build" }), "I-9·P-APP-25·APP-309 Importer block");
  assert.equal(
    issueName({ initiative: "I-9", project: "P-APP-25", issue: "APP-306", title: "Feed reader any format", role: "review" }),
    "I-9·P-APP-25·APP-306 Feed reader any format·review",
  );
  assert.equal(issueName({ initiative: null, project: "P-APP-30", issue: "APP-400", title: "Title", role: "build" }), "P-APP-30·APP-400 Title");
  assert.equal(issueName({ initiative: null, project: "H", issue: "APP-371", title: "Offsite test cleanup", role: "qa" }), "H·APP-371 Offsite test cleanup·qa");
});

// protects: push paths per the spec (I-9, I-9 › P-APP-25, P-APP-25, H)
// fails_when: a project without initiative gets a dangling separator, or hygiene gets a project path
// no_claim: that pushes are actually sent (sessions send them)
test("push paths", () => {
  assert.equal(pushPath({ initiative: "I-9", project: null }), "I-9");
  assert.equal(pushPath({ initiative: "I-9", project: "P-APP-25" }), "I-9 › P-APP-25");
  assert.equal(pushPath({ initiative: null, project: "P-APP-25" }), "P-APP-25");
  assert.equal(pushPath({ initiative: null, project: "H" }), "H");
});

// protects: a title can never break a name or address: no newlines or control characters, at most 80 characters
// fails_when: a newline, tab or escape survives, or a long title is not capped
// no_claim: that the cut falls on a word boundary
test("titles drop control characters and are capped at 80", () => {
  assert.equal(cleanTitle("Importer\nblock\t\u0007 now"), "Importer block now");
  assert.equal(cleanTitle("  spaced  "), "spaced");
  assert.equal(cleanTitle("x".repeat(120)).length, 80);
  assert.equal(cleanTitle("a\u001b[31mred"), "a [31mred");
});

// protects: the 80-character cap counts characters, so it never leaves half an emoji (which argv would turn into U+FFFD)
// fails_when: the cap slices UTF-16 units through a surrogate pair
// no_claim: grapheme clusters (combining marks, ZWJ sequences) may still be split
test("title cap never splits an emoji", () => {
  const title = cleanTitle(`${"x".repeat(79)}\u{1F600}tail`);
  assert.equal(title, `${"x".repeat(79)}\u{1F600}`);
  assert.doesNotMatch(title, /[\uD800-\uDBFF]$/);
});
