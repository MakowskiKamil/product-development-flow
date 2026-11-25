#!/usr/bin/env node
// Fake `claude` for the b913f36 compatibility test only. It answers
// `agents --json --all` with the sessions in <FLOW_CLAUDE_HOME>/agents.json (the test
// fills in the pids) and refuses every other call: a keeper --dry-run must call nothing
// else, so any other call fails the run instead of passing silently.
// Kept apart from test/fixtures/fake-claude.mjs so later changes there cannot shift
// what this frozen fixture sees.

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.join(" ") === "agents --json --all") {
  process.stdout.write(fs.readFileSync(path.join(process.env.FLOW_CLAUDE_HOME, "agents.json"), "utf8"));
} else {
  console.error(`compat fake claude: unsupported call ${argv.join(" ")}`);
  process.exit(1);
}
