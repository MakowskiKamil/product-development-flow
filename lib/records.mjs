// Session records: sessions/<slug>/record.json in the state dir, one per session
// flow started. Records are never deleted; archived ones keep holding their slug.

export function recordPath(slug) {
  return `sessions/${slug}/record.json`;
}

export function cardPath(slug) {
  return `sessions/${slug}/card.md`;
}

// All records, read through a transact() context.
export function listRecords(ctx) {
  return ctx
    .list("sessions")
    .filter((slug) => ctx.exists(recordPath(slug)))
    .map((slug) => ctx.readJson(recordPath(slug)));
}

export function isLive(record) {
  return record.status !== "archived";
}

// A slug counts as held when any record (any status) has it, or a folder for it
// exists without a record (left by a crash; never reuse it silently).
export function slugHeld(ctx, records, slug) {
  return records.some((record) => record.slug === slug) || ctx.exists(`sessions/${slug}`);
}

// The base slug if free, else the next free suffix 2, 3, …
export function nextSuffix(ctx, records, base) {
  if (!slugHeld(ctx, records, base)) return null;
  for (let n = 2; ; n += 1) {
    if (!slugHeld(ctx, records, `${base}-${n}`)) return n;
  }
}

// The non-archived coordinator record for an initiative, project or hygiene.
export function liveCoordinator(records, role, id) {
  return records.find((record) => {
    if (record.role !== role || !isLive(record)) return false;
    if (role === "initiative") return record.initiative === id;
    if (role === "project") return record.project === id;
    return true; // hygiene: there is only one
  });
}

export function newRecord(fields) {
  return {
    slug: fields.slug,
    jobId: fields.jobId,
    sessionId: fields.sessionId,
    name: fields.name,
    role: fields.role,
    parentSlug: fields.parentSlug ?? null,
    parentName: fields.parentName ?? null,
    initiative: fields.initiative ?? null,
    project: fields.project ?? null,
    issue: fields.issue ?? null,
    model: fields.model,
    effort: fields.effort,
    playbook: fields.playbook,
    worktree: fields.slug,
    branch: null,
    pr: null,
    status: "running",
    orphanAlertedAt: null,
    cleanedAt: null,
    createdAt: fields.createdAt,
  };
}
