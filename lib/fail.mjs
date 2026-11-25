// One shape for every refusal and failure (gate decision d5): the first stderr line
// names the operation and the offending value, the last line says what to do next.
// bin/flow.mjs adds the operation ("flow spawn: ") and prints the lines.

export class FlowError extends Error {
  constructor(what, fix, { code = 1, detail = [] } = {}) {
    super(what);
    this.what = what;
    this.fix = fix;
    this.code = code; // 1 refused or invalid, 2 claude failed
    this.detail = detail; // middle lines, e.g. claude's output
  }
}

export function fail(what, fix, options) {
  throw new FlowError(what, fix, options);
}

// The stderr text for an error. Errors that are not FlowError are bugs or broken
// surroundings (disk full, git missing); they still get the two-line shape.
export function formatError(operation, error) {
  if (error instanceof FlowError) {
    return [`${operation}: ${error.what}`, ...error.detail, `fix: ${error.fix}`].join("\n");
  }
  return [`${operation}: unexpected error: ${error.message}`, `fix: report this with the command you ran`].join("\n");
}

// An env override (FLOW_STATE, FLOW_CLAUDE, FLOW_CLAUDE_HOME). Inside `node --test` a
// missing one is refused, so no test can fall through to the real state dir, the real
// claude or the real ~/.claude, whether it runs the CLI or imports lib/ directly.
export function envOverride(key) {
  const value = process.env[key];
  if (!value && process.env.NODE_TEST_CONTEXT) {
    fail(`running under node --test without ${key}`, "set it to a temp path (see test/helpers.mjs)");
  }
  return value || undefined;
}

// Rollback tests need failures at points that have no natural trigger (record write,
// commit). FLOW_TEST_FAIL=<point> fires only inside `node --test`, never in real use.
export function testFault(point) {
  if (process.env.NODE_TEST_CONTEXT && process.env.FLOW_TEST_FAIL === point) {
    throw new Error(`test fault at ${point}`);
  }
}
