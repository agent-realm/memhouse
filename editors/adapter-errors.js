// A place for adapters to report failures they otherwise swallow.
//
// Every SQLite-backed adapter wraps its database access in `try { … } catch { return [] }`
// so that one unreadable store cannot take down a whole scan. That is the right
// behaviour, but it makes a broken store indistinguishable from an editor the user
// does not have: both contribute zero sessions and neither says anything. Sessions
// then go missing from the house silently, forever.
//
// Adapters call record() from those catch blocks. index.js drains it per scan and
// reports through discover, doctor, and the shipper.
//
// This lives in its own module rather than in index.js because the adapters are
// required *by* index.js — importing it back would be circular.

let errors = [];

/** Report a failure that would otherwise be swallowed. `source` is the adapter name. */
function record(source, err, detail) {
  const message = ((err && err.message) || String(err)).split('\n')[0];
  errors.push({ source, message, detail: detail || null });
}

/** All failures recorded since the last reset. */
function recorded() {
  return errors.slice();
}

function reset() {
  errors = [];
}

module.exports = { record, recorded, reset };
