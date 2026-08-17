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
      if (problem) found.push({ t, name, key: rows[0].k });
    }
    return found;
  },

  plan(found) {
    return [
      `These rooms predate schema ${this.toVersion} and the shipper refuses to write into them:`,
      '',
      ...found.map((x) => `  ${x.name}  (${x.key})`),
      '',
      'Each is copied into a room with the current key, swapped in atomically, and the',
      'old one kept as <room>_pre_epoch. Nothing is deleted — you drop those when ready.',
    ];
  },

  steps(found, ctx) {
    return [
      ...found.map((x) => ({ op: 'rebuildRoom', type: x.t, name: x.name, keepSuffix: 'epoch' })),
      // The rooms the rebuild does not touch still gain this generation's columns.
      ...ROOM_TYPES.filter((t) => !found.some((x) => x.t === t))
        .map((t) => ({ op: 'healColumns', type: t, name: ctx.rooms[`${t}_raw`] })),
    ];
  },
};
