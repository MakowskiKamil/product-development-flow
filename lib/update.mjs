// flow set and flow archive: the two commands that change an existing session record.

import { rebuildCards } from "./cards.mjs";
import { stopJob, updatePins } from "./claudeJobs.mjs";
import { FlowError, fail } from "./fail.mjs";
import { isLive, listRecords, recordPath } from "./records.mjs";
import { transact } from "./state.mjs";

function findRecord(ctx, slug) {
  // The slug format first: a slug with "/" or ".." could name a file outside sessions/.
  if (typeof slug !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || !ctx.exists(recordPath(slug))) {
    fail(`no session with slug ${JSON.stringify(slug ?? "")}`, "flow tree --all lists every slug");
  }
  return ctx.readJson(recordPath(slug));
}

// What flow set may change, and how each value is checked. Everything else in a
// record belongs to spawn, archive or the keeper.
const SETTABLE = {
  // A GitHub PR number; "#12" is accepted too, since that is how PRs are written.
  pr: (value) => {
    const match = /^#?([1-9]\d*)$/.exec(value);
    if (!match) fail(`pr=${JSON.stringify(value)} is not a PR number`, "flow set <slug> pr=<n>, e.g. pr=12");
    return Number(match[1]);
  },
  // A branch name as git would take it: no spaces, no leading "-", none of ~^:?*[\ .
  // WHY not git check-ref-format: flow set must not depend on a repo; this catches
  // the typing mistakes that matter (a pasted sentence, a flag).
  branch: (value) => {
    if (!/^[^\s~^:?*[\\-][^\s~^:?*[\\]*$/.test(value) || value.includes("..") || value.endsWith("/") || value.endsWith(".lock")) {
      fail(`branch=${JSON.stringify(value)} is not a branch name`, "flow set <slug> branch=<branch>, e.g. branch=dev/pro-6-flow-tree");
    }
    return value;
  },
  // Only done: running is where a session starts, archived is flow archive's.
  status: (value) => {
    if (value !== "done") fail(`status=${JSON.stringify(value)} is not allowed`, "flow set <slug> status=done (to archive, flow archive <slug>)");
    return value;
  },
};

// Pairs "key=value" → { key: value }, checked. Refuses unknown and repeated keys.
export function parsePairs(pairs) {
  if (!pairs.length) fail("nothing to set", "flow set <slug> pr=<n> | branch=<b> | status=done");
  const fields = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const key = at === -1 ? pair : pair.slice(0, at);
    if (!Object.hasOwn(SETTABLE, key)) fail(`unknown key ${JSON.stringify(key)} in ${JSON.stringify(pair)}`, `use one of ${Object.keys(SETTABLE).join(", ")} (key=value)`);
    if (at === -1) fail(`${key} has no value`, `flow set <slug> ${key}=<value>`);
    if (Object.hasOwn(fields, key)) fail(`${key} given twice`, `give each key once`);
    fields[key] = SETTABLE[key](pair.slice(at + 1));
  }
  return fields;
}

// Returns { record, changed }.
export function setFields(slug, pairs) {
  const fields = parsePairs(pairs);
  return transact(`flow set ${slug}`, (ctx) => {
    const record = findRecord(ctx, slug);
    if (!isLive(record)) fail(`session ${slug} is archived; its record no longer changes`, `start a new session instead (flow spawn … --again)`);
    const changed = Object.keys(fields).filter((key) => record[key] !== fields[key]);
    if (!changed.length) return { record, changed };
    const updated = { ...record, ...fields };
    ctx.writeJson(recordPath(slug), updated);
    // The card's links show the PR; keep it in step with the record.
    rebuildCards(ctx, [updated]);
    ctx.commit(`set ${slug}: ${changed.map((key) => `${key}=${fields[key]}`).join(" ")}`);
    return { record: updated, changed };
  });
}

// status archived (committed first, so it holds whatever happens next), then claude
// stop on the session's job, then unpin. Cleanup (claude rm, worktree, branches) is
// the keeper's. Idempotent: an archived record gets stop and unpin again, so a run
// that failed halfway is finished by running it again.
// Returns { record, wasArchived, openChildren, stop, unpin } where unpin.warning is set
// when the pin could not be removed. A failed claude stop throws (exit 2) after unpinning.
export function archive(slug) {
  const { record, wasArchived, openChildren } = transact(`flow archive ${slug}`, (ctx) => {
    const current = findRecord(ctx, slug);
    const was = !isLive(current);
    const archived = was ? current : { ...current, status: "archived" };
    if (!was) {
      ctx.writeJson(recordPath(slug), archived);
      ctx.commit(`archive ${slug}: ${current.name}`);
    }
    const children = listRecords(ctx).filter((child) => child.parentSlug === slug && isLive(child));
    return { record: archived, wasArchived: was, openChildren: children };
  });

  const stop = stopJob(record.jobId, record.sessionId);
  const ids = new Set(stop.unpinIds);
  let unpin;
  try {
    unpin = ids.size ? updatePins((pins) => pins.filter((id) => !ids.has(id))) : { written: false };
  } catch (error) {
    // A pins.json flow cannot read must not hide what happened to the record and the job.
    unpin = { written: false, warning: `${error.message}; pins left unchanged` };
  }

  if (stop.mismatch) {
    // Not a claude failure (claude never ran), so exit 1; the record stays archived.
    const detail = [`record: ${slug} is archived`];
    if (unpin.warning) detail.push(`warning: ${unpin.warning}`);
    throw new FlowError(stop.message, `find session ${record.sessionId} in claude agents and stop it by hand if it still runs`, { code: 1, detail });
  }
  if (!stop.ok) {
    const detail = [`record: ${slug} is archived`];
    if (unpin.warning) detail.push(`warning: ${unpin.warning}`);
    throw new FlowError(stop.message, `check the job (claude agents), then run flow archive ${slug} again`, { code: 2, detail });
  }
  return { record, wasArchived, openChildren, stop, unpin };
}
