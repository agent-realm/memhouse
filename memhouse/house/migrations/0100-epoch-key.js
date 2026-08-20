// Schema 1 -> 2: `epoch` joins the transcript rooms' sorting keys.
//
// The shipper became insert-only in 0.10.0 — a re-parse that shrinks or diverges is
// written under a new epoch instead of over the stored parse — and ReplacingMergeTree
// collapses on the sorting key, so the epoch must BE in the key or the new parse and the
// old one are the same rows and the old one loses through the merge. ORDER BY cannot be
// altered in place; hence this rebuild.
//
// `sessions` keeps its key (one metadata row per session, deliberately) but gains the
// `epoch` column, so it is healed rather than rebuilt.

const { ROOM_TYPES, keyProblem } = require('../house');

module.exports = {
  id: '0100-epoch-key',
  component: 'rooms',
  toVersion: 2,

  async detect(q, ctx) {
    const found = [];
    for (const t of ROOM_TYPES) {
      const name = ctx.rooms[`${t}_raw`];
      const rows = await q.rows(`SELECT sorting_key AS k FROM system.tables WHERE database = '${ctx.db}' AND name = '${name}'`);
      // A missing room is install's problem, not a migration's — there is nothing to carry.
      if (!rows.length) continue;
      const problem = keyProblem(t, rows[0].k);
      if (problem) { found.push({ t, name, key: rows[0].k, rebuild: true }); continue; }
      // A correct key is not the whole generation: `sessions` keeps its key and gains
      // `epoch` by ALTER. Detect keyed on keys alone went blind to a failed heal — a run
      // that died between the last rebuild and the column heal re-detected as "nothing
      // pending", stamped schema 2, and the missing column stayed missing while the
      // failure text promised that re-running was enough.
      const cols = await q.rows(`SELECT name FROM system.columns WHERE database = '${ctx.db}' AND table = '${name}' AND name = 'epoch'`);
      if (!cols.length) found.push({ t, name, healOnly: true });
    }
    return found;
  },

  plan(found) {
    const rebuilds = found.filter((x) => x.rebuild);
    const heals = found.filter((x) => x.healOnly);
    return [
      ...(rebuilds.length ? [
        `These rooms predate schema ${this.toVersion} and the shipper refuses to write into them:`,
        '',
        ...rebuilds.map((x) => `  ${x.name}  (${x.key})`),
        '',
        'Each is copied into a room with the current key, swapped in atomically, and the',
        'old one kept as <room>_pre_epoch. Nothing is deleted — you drop those when ready.',
      ] : []),
      ...(heals.length ? [
        `These rooms keep their key but are missing this generation's columns (added in place):`,
        ...heals.map((x) => `  ${x.name}`),
      ] : []),
    ];
  },

  steps(found, ctx) {
    const rebuilds = found.filter((x) => x.rebuild);
    return [
      ...rebuilds.map((x) => ({ op: 'rebuildRoom', type: x.t, name: x.name, keepSuffix: 'epoch' })),
      // Heal EVERY room the rebuild does not touch — the detected healOnly ones and the
      // already-correct rest alike; ADD COLUMN IF NOT EXISTS makes the latter free.
      ...ROOM_TYPES.filter((t) => !rebuilds.some((x) => x.t === t))
        .map((t) => ({ op: 'healColumns', type: t, name: ctx.rooms[`${t}_raw`] })),
    ];
  },
};
