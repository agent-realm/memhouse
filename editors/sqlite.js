// SQLite for the five adapters that read an editor's store directly — cursor, zed,
// opencode, goose, antigravity — plus windsurf's Devin API-key lookup.
//
// This was `better-sqlite3`, a native module whose prebuilt binary arrives through an
// npm install script — and npm >= 12 blocks install scripts by default, so a plain
// `npm i -g memhouse` left no binding at all. Those five adapters then read ZERO
// sessions and looked exactly like editors the pilot does not have. The fix was a flag
// (`--allow-scripts=better-sqlite3`) that had to be typed on every install and every
// upgrade, was never remembered by npm, and produced no error when omitted.
//
// `node:sqlite` is part of Node itself — stable in 24, no build step, no binary to
// misplace, nothing to allow. The whole "adapter silently skipped for a missing native
// binding" failure class is gone, and install is one command with no flags.
//
// Still required lazily, but for a different reason than before. On a Node older than
// the engines floor `require('node:sqlite')` throws, and editors/index.js imports every
// adapter at load time — a top-level require here would take the eleven adapters that
// need no SQLite at all down with the five that do, and `discover` would report zero
// editors. Lazy, that throw lands inside each adapter's own try/catch and is reported
// through adapter-errors like any other unreadable store.
let DatabaseSync = null;

/**
 * Open an editor's store read-only.
 *
 * Every call site in this repo is a read, so there is no write mode to get wrong.
 * better-sqlite3 spelled the option `readonly` and needed `fileMustExist` beside it to
 * stop a typo'd path from quietly creating an empty database; node:sqlite spells it
 * `readOnly` and refuses on its own — measured, a missing file throws ERR_SQLITE_ERROR
 * "unable to open database file" rather than creating one. Callers that check
 * fs.existsSync() first keep working unchanged; callers that do not still cannot
 * conjure a store that is not there.
 */
function openReadOnly(file) {
  if (!DatabaseSync) ({ DatabaseSync } = require('node:sqlite'));
  return new DatabaseSync(file, { readOnly: true });
}

/**
 * A column's value as text, whether SQLite handed back TEXT or BLOB.
 *
 * SQLite types values, not columns, and these stores are not consistent about it: the
 * VS Code family declares `ItemTable.value` as BLOB but stores strings in it, while
 * Cursor's agent store keeps real bytes in the same shape of table. better-sqlite3
 * returned a Buffer for the byte case and every `JSON.parse(row.value)` in these
 * adapters worked by accident, because Buffer.toString() decodes utf-8.
 *
 * node:sqlite returns a plain Uint8Array, whose toString() renders "40,181,47,253,…" —
 * a comma-joined list of byte values. That is not utf-8, not JSON, and not empty, so it
 * does not fail loudly; it fails four frames deeper as a parse error against a store
 * that is perfectly healthy. Every read that may be either type goes through here.
 */
function textOf(v) {
  if (v == null) return v;
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf-8');
  return String(v);
}

/**
 * A column's value as a Buffer, for readers that slice it, hex-encode it, or hand it to
 * zlib. Buffer IS a Uint8Array, so this is a no-op on anything better-sqlite3 would have
 * returned — it exists so the byte-walking code below never has to ask which it got.
 */
function bytesOf(v) {
  if (v == null) return v;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf-8');
  // A view over the same memory, not a copy — these blobs run to megabytes and every
  // consumer here only reads.
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

module.exports = { openReadOnly, textOf, bytesOf };
