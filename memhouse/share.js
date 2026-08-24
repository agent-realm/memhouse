/**
 * `memhouse share <user> [--only <scope>] [--revoke]` / `memhouse share --list`
 *
 * Full share is one statement: GRANT SELECT on the house. Partial share adds a ROW
 * POLICY per room, so the grantee reads only the rows the scope allows.
 *
 * Why no permissive catch-all policy for everyone else, which is the obvious design:
 * row policies are OR'd, so a `USING 1 TO ALL EXCEPT alice` policy silently overrides
 * the NEXT scoped grantee's filter — measured, bob saw all 22,500 rows instead of his
 * 1,860. It fails OPEN and it fails quietly. ClickHouse already answers this correctly
 * through `users_without_row_policies_can_read_rows`: a reader with no policy on a table
 * still sees every row. Verified against a non-superuser member owning its own house —
 * owner and full-share grantees were both unaffected while a third user was scoped.
 *
 * That setting is server config, not a query setting, and its default has moved between
 * versions. So `probePermissive()` measures the behaviour before the first policy is
 * created rather than assuming it, and refuses when the server would blindfold everyone.
 */

/** Columns a scope may filter on, and the column each room spells time with. */
const SCOPE_COLUMNS = {
  session: { column: () => 'session_id', quote: true },
  project: { column: () => 'project', quote: true },
  folder: { column: () => 'folder', quote: true },
  host: { column: () => 'host', quote: true },
  source: { column: () => 'source', quote: true },
  // `sessions` has no `ts`; its clock is `created_at`. One literal predicate cannot span
  // the rooms, so time scopes render per room.
  since: { column: (room) => (room === 'sessions' ? 'created_at' : 'ts'), op: '>=' },
  until: { column: (room) => (room === 'sessions' ? 'created_at' : 'ts'), op: '<' },
};

/** `project=memhouse,since=2026-01-01` -> [{key, value}], rejecting anything unknown. */
function parseScope(raw) {
  const out = [];
  for (const part of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z_]+)\s*=\s*(.+)$/.exec(part);
    if (!m) throw new Error(`scope "${part}" is not <key>=<value>`);
    const key = m[1].toLowerCase();
    if (!SCOPE_COLUMNS[key]) {
      throw new Error(`unknown scope key "${key}" — try: ${Object.keys(SCOPE_COLUMNS).join(', ')}`);
    }
    out.push({ key, value: m[2].trim() });
  }
  if (!out.length) throw new Error('--only was given nothing to scope on');
  return out;
}

/** The WHERE-shaped predicate for one room. Values are escaped, never interpolated raw. */
function scopePredicate(scope, room, sqlStr) {
  return scope.map(({ key, value }) => {
    const spec = SCOPE_COLUMNS[key];
    const col = spec.column(room);
    if (spec.op) return `${col} ${spec.op} parseDateTimeBestEffort(${sqlStr(value)})`;
    return `${col} = ${sqlStr(value)}`;
  }).join(' AND ');
}

/** Policy name for a grantee's room — predictable, so revoke can find every one. */
function policyName(user, room) {
  return `mh_share_${user}_${room}`;
}

module.exports = { SCOPE_COLUMNS, parseScope, scopePredicate, policyName };
