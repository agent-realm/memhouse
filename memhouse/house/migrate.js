// The migration runner — the machinery `memhouse migrate` drives.
//
// A schema generation change (SCHEMA_VERSION in house.js) is the one kind of change
// ensureSchema's column healer cannot roll out in place: sorting keys, engines, and
// anything else ClickHouse refuses to ALTER. Those are REBUILDS, and a rebuild has a
// middle, an actor, and an outcome — so each one is a registered migration in
// ./migrations/<id>.js, and this module runs whichever of them a house still needs.
//
// The runner is deliberately transport-free: every entry point takes `q`, an object with
// `sql(text, settings) -> string` and `rows(text, settings) -> object[]`, injected by the
// caller (the CLI speaks raw HTTP; a test can speak @clickhouse/client). It never
// constructs a connection and never reads config.
//
// What is a migration and what is not:
//
//   additive change (new column, new table, new index)  -> ensureSchema, NOT a migration
//   rebuild (sorting key, engine, column type)          -> a migration, class 'rebuildRoom'
//   data transform (backfill, rewrite)                  -> a migration, class 'sql'
//
// SCHEMA_VERSION bumps only for the last two.
//
// Invariants every migration inherits from the executors here — these were bought with
// measured losses and are not per-migration choices:
//
//   NOTHING IS DELETED. A replaced object is renamed to `<name>_pre_<suffix>` and left
//   for the pilot to drop. A leftover `__migrating` table from an interrupted run is
//   never cleared automatically — it may hold the only copy of mid-flight rows.
//
//   PROVENANCE IS COPIED, NOT RESTAMPED. `user_id` is MATERIALIZED currentUser(), so a
//   plain INSERT SELECT would stamp every copied row of a shared house with whoever ran
//   the migration. The copy lists columns explicitly under
//   insert_allow_materialized_columns=1, and drops only the derived text_ngram/text_word
//   (recomputed on insert).
//
//   THE SWAP IS ONE STATEMENT. `RENAME TABLE a TO a_pre_x, tmp TO a` is atomic; the
//   table never stops existing.
//
//   WRITES DURING THE COPY SURVIVE. A shipper running through the migration writes into
//   the old table until the rename; a late-writes pass copies anything newer than the
//   snapshot, and ReplacingMergeTree makes that idempotent.
//
//   EVERYTHING IS RECORDED. One house_events pending row before work, applied/failed
//   after, per object; schema_version in house_meta only after a migration completes.

const fs = require('fs');
const path = require('path');
const { ROOM_TYPES, keyProblem, createStatement } = require('./house');

/**
 * Every registered migration, in the order they must run. The id's numeric prefix is the
 * order; the registry refuses duplicates and out-of-order versions at load time rather
 * than at 2am on someone's house.
 *
 * A migration file exports:
 *   id         '0100-epoch-key' — numeric prefix orders it, the rest names it
 *   component  which part of memhouse it migrates ('rooms' today; 'daemon', 'config', …
 *              later). `memhouse migrate` runs all components; `memhouse migrate-rooms`
 *              filters to 'rooms'.
 *   toVersion  the SCHEMA_VERSION a house is at once this has run
 *   detect(q, ctx)        -> what still needs doing (any truthy non-empty value), or
 *                            null/[] when the house is already past this migration.
 *                            THE ROOMS ARE THE TRUTH, never house_meta: a hand-migrated
 *                            house has no record, and a restored backup can carry a
 *                            record newer than its tables.
 *   plan(found)           -> lines of human text for the confirm prompt
 *   steps(found, ctx)     -> [{op: 'rebuildRoom'|'healColumns'|'sql', ...args}]
 */
function listMigrations() {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.js$/.test(f)).sort();
  const out = files.map((f) => require(path.join(dir, f)));
  const seen = new Set();
  let lastVersion = 0;
  for (const m of out) {
    if (seen.has(m.id)) throw new Error(`duplicate migration id '${m.id}'`);
    seen.add(m.id);
    if (!(m.toVersion > lastVersion)) {
      throw new Error(`migration '${m.id}' has toVersion ${m.toVersion}, not above ${lastVersion} — order is the numeric prefix`);
    }
    lastVersion = m.toVersion;
    for (const k of ['component', 'detect', 'plan', 'steps']) {
      if (!m[k]) throw new Error(`migration '${m.id}' is missing '${k}'`);
    }
  }
  return out;
}

/**
 * Which migrations this house still needs, in run order.
 * @returns [{ migration, found }] — empty when the house is current.
 */
async function detectPending(q, ctx, { component = null } = {}) {
  const pending = [];
  for (const m of listMigrations()) {
    if (component && m.component !== component) continue;
    const found = await m.detect(q, ctx);
    if (found && (!Array.isArray(found) || found.length)) pending.push({ migration: m, found });
  }
  return pending;
}

/**
 * Refuse when another actor's run is unfinished. An `applied` newer than the last
 * `pending` means done; a dangling `pending` means someone is (or was) mid-copy, and two
 * concurrent rebuilds of one room end with one of them renaming the other's work.
 * Best-effort: a house without house_events cannot answer, and that is not a reason to
 * block the migration that will create it.
 */
async function unfinishedBy(q, ctx, migrationId) {
  try {
    const rows = await q.rows(
      `SELECT argMax(status, event_at) AS status, argMax(actor, event_at) AS actor,
              formatDateTime(max(event_at), '%Y-%m-%d %H:%i') AS at
       FROM house_events WHERE kind = 'migration' AND id = '${migrationId}'`);
    const r = rows[0];
    if (r && r.status === 'pending' && r.actor && r.actor !== ctx.member) return r;
  } catch { /* no events table yet */ }
  return null;
}

// ── executors ─────────────────────────────────────────────────────────────────────

/**
 * Copy a room into one built from the current template, swap atomically, keep the old
 * one as `<name>_pre_<suffix>`. See the invariants at the top of this file.
 */
async function rebuildRoom(q, ctx, { type, name, keepSuffix }, ui) {
  const tmp = `${name}__migrating`;
  const kept = `${name}_pre_${keepSuffix}`;
  for (const clash of [tmp, kept]) {
    const exists = await q.rows(`SELECT name FROM system.tables WHERE database = '${ctx.db}' AND name = '${clash}'`);
    if (exists.length) {
      throw new Error(`${clash} already exists — an earlier migration did not finish.\n`
        + `  inspect it, then rename or drop it yourself: DROP TABLE ${ctx.db}.${clash}`);
    }
  }
  const before = Number((await q.rows(`SELECT count() AS c FROM ${name} FINAL`))[0]?.c || 0);

  const oldCols = (await q.rows(`SELECT name FROM system.columns WHERE database = '${ctx.db}' AND table = '${name}'`)).map((c) => c.name);
  await q.sql(createStatement(ctx.tpl, type, tmp), { allow_experimental_full_text_index: 1 });
  const newCols = (await q.rows(`SELECT name FROM system.columns WHERE database = '${ctx.db}' AND table = '${tmp}'`)).map((c) => c.name);
  const carried = newCols.filter((c) => oldCols.includes(c) && !['text_ngram', 'text_word'].includes(c));
  const list = carried.join(', ');
  const copySettings = { insert_allow_materialized_columns: 1, allow_experimental_full_text_index: 1 };
  const started = (await q.rows("SELECT toString(now64(3, 'UTC')) AS t"))[0].t;

  await q.sql(`INSERT INTO ${tmp} (${list}) SELECT ${list} FROM ${name} FINAL`, copySettings);
  const copied = Number((await q.rows(`SELECT count() AS c FROM ${tmp}`))[0]?.c || 0);
  if (copied < before) throw new Error(`copied ${copied} of ${before} rows — refusing to swap`);

  await q.sql(`RENAME TABLE ${name} TO ${kept}, ${tmp} TO ${name}`);
  let late = false;
  if (carried.includes('ingested_at')) {
    try {
      await q.sql(`INSERT INTO ${name} (${list}) SELECT ${list} FROM ${kept} FINAL WHERE ingested_at >= toDateTime64('${started}', 3, 'UTC')`, copySettings);
      late = true;
    } catch (e) {
      // Best-effort must not mean SILENT. The rows are not lost — they sit in the kept
      // table — but a shipper that wrote during the copy has its newest rows stranded
      // there until someone re-runs this insert, and nobody re-runs what nobody was told
      // about.
      ui.warn(`${name}: the late-writes pass failed (${e.message.split('\n')[0]})`);
      ui.warn(`  rows written during the copy are still in ${kept}; recover them with:`);
      ui.warn(`  INSERT INTO ${name} (${list}) SELECT ${list} FROM ${kept} FINAL WHERE ingested_at >= toDateTime64('${started}', 3, 'UTC')`);
    }
  }
  const after = Number((await q.rows(`SELECT count() AS c FROM ${name} FINAL`))[0]?.c || 0);
  ui.ok(`${name}: ${after} rows, old room kept as ${kept}`);
  return { before, after, kept, late };
}

/**
 * ADD COLUMN anything the template declares that the live table lacks — for objects a
 * migration does NOT rebuild. `sessions` keeps its key across schema 2 but still gains
 * `epoch`; without this, the very next ship opens with a "fields are being DISCARDED"
 * warning and sends the pilot to a second command.
 */
async function healColumns(q, ctx, { type, name }, ui) {
  const { templateColumns } = require('../shipper/ship');
  const want = templateColumns(ctx.tpl);
  const have = new Set((await q.rows(`SELECT name FROM system.columns WHERE database = '${ctx.db}' AND table = '${name}'`)).map((c) => c.name));
  if (!have.size) return;
  for (const col of (want[type] || [])) {
    if (have.has(col.name)) continue;
    await q.sql(`ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`,
      { allow_experimental_full_text_index: 1 });
    ui.ok(`${name}: added missing column ${col.name}`);
  }
}

const EXECUTORS = { rebuildRoom, healColumns, sql: async (q, ctx, { statement }, ui) => { await q.sql(statement); } };

/**
 * Run one pending migration: ledger pending -> steps -> ledger applied (or failed and
 * rethrow). `ledger` is injected ({ event(fields), meta(key, value) }, both best-effort)
 * because the record must never be the reason a rebuild fails.
 */
async function runMigration(q, ctx, { migration, found }, { ledger, ui }) {
  // One migration-level pending marker FIRST, before any step. The per-step pair below
  // records progress; this one exists for the OTHER migrator — unfinishedBy() reads it,
  // and without it two `memhouse update`s sitting at their confirm prompts both saw a
  // clean ledger and both proceeded on yes. (The room-level clash checks still make the
  // race non-destructive — the loser fails on __migrating/CREATE — but failing cleanly
  // beats failing confusingly.)
  await ledger.event({
    kind: 'migration', id: migration.id, status: 'pending', host: ctx.host,
    to_version: String(migration.toVersion), detail: 'migration started',
  });
  const steps = migration.steps(found, ctx);
  for (const step of steps) {
    const exec = EXECUTORS[step.op];
    if (!exec) throw new Error(`migration '${migration.id}' names unknown op '${step.op}'`);
    const label = step.name || step.op;
    // One event pair per step that MOVES data; heal/sql steps ride on the migration's own.
    const record = step.op === 'rebuildRoom';
    if (record) {
      await ledger.event({
        kind: 'migration', id: migration.id, status: 'pending', host: ctx.host,
        to_version: String(migration.toVersion), detail: `${label}`,
      });
    }
    try {
      const r = await exec(q, ctx, step, ui);
      if (record) {
        await ledger.event({
          kind: 'migration', id: migration.id, status: 'applied', host: ctx.host,
          to_version: String(migration.toVersion),
          rows_before: r?.before || 0, rows_after: r?.after || 0,
          detail: `${label}: old room kept as ${r?.kept}${r?.late ? '; late writes copied' : ''}`,
        });
      }
    } catch (e) {
      if (record) {
        await ledger.event({
          kind: 'migration', id: migration.id, status: 'failed', host: ctx.host,
          to_version: String(migration.toVersion), detail: `${label}: ${e.message}`,
        });
      }
      throw e;
    }
  }
  await ledger.event({
    kind: 'migration', id: migration.id, status: 'applied', host: ctx.host,
    to_version: String(migration.toVersion), detail: 'migration completed',
  });
  await ledger.meta('schema_version', String(migration.toVersion));
}

module.exports = { listMigrations, detectPending, unfinishedBy, runMigration, EXECUTORS };
