// Pure helpers for `memhouse relocate` — the host-to-host copy that moves a whole house
// to a new ClickHouse and repoints the shipper, WITHOUT the shipper re-ingesting from
// local session files. The orchestration lives in bin/memhouse.js (cmdRelocate); the
// transport-free, side-effect-free decisions live here so they can be unit-tested.
//
// See docs/design/host-repoint-reconciliation.md for the wider design this is one piece
// of. Relocate is the "data does follow the pointer, on purpose" path.

// The two room columns that are MATERIALIZED and DERIVED from `text` — the lowercased,
// text-indexed copies. They are recomputed by the destination table's own expression on
// INSERT, so they are never carried across; carrying them would also fail, since they are
// not insertable even with insert_allow_materialized_columns.
const DERIVED = ['text_ngram', 'text_word'];

// meta keys that are DURABLE facts of the house — worth carrying to the new host.
// Everything else in meta is a per-host heartbeat (client_version, client_schema,
// last_ship:<writer>) that the new shipper rewrites for itself on its first run; carrying
// a stale one would misreport which machine last shipped until that run lands.
function isDurableMetaKey(key) {
  return key === 'schema_version'
    || key === 'min_writer_schema'
    || key === 'house_id'            // forward-compat: harmless if absent today
    || /^share:/.test(key);
}

/**
 * The columns to carry when copying `srcTable` into `destTable`, given both sides' column
 * lists. The intersection (a column the destination lacks cannot be written; one the
 * source lacks cannot be read) minus the derived pair. Order follows the destination, so
 * the SELECT and INSERT lists line up positionally.
 */
function copyColumns(destCols, srcCols) {
  const src = new Set(srcCols);
  return destCols.filter((c) => src.has(c) && !DERIVED.includes(c));
}

/**
 * Resolve the ClickHouse NATIVE endpoint to read the source house from, given its HTTP(S)
 * URL. remoteSecure()/remote() speak the native TCP protocol, NOT HTTP — a different port
 * from the one in MEMHOUSE_URL. Secure (TLS) native defaults to 9440; plain to 9000.
 *
 * @param url        the source MEMHOUSE_URL (http(s)://host:8123)
 * @param opts.host  override the host — the DESTINATION's route to the source may differ
 *                   from the pilot's URL (NAT, split-horizon DNS, a private peering name)
 * @param opts.port  override the native port
 * @param opts.insecure  use remote() + plain 9000 instead of remoteSecure() + 9440
 * @returns { fn: 'remoteSecure'|'remote', host, port, addr: 'host:port' }
 */
function nativeEndpoint(url, { host = null, port = null, insecure = false } = {}) {
  if (!host) {
    try { host = new URL(url).hostname; } catch { throw new Error(`source URL is not a URL: ${url}`); }
  }
  if (!host) throw new Error(`source URL has no host: ${url}`);
  const fn = insecure ? 'remote' : 'remoteSecure';
  const p = String(port || (insecure ? 9000 : 9440));
  return { fn, host, port: p, addr: `${host}:${p}` };
}

module.exports = { DERIVED, isDurableMetaKey, copyColumns, nativeEndpoint };
