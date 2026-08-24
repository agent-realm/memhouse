// Consuming a hidden-input chunk, as pure logic so it can be tested without a terminal.
//
// The subtlety this exists for: a raw-mode stdin 'data' event carries a CHUNK, not a
// keystroke. While someone types, each chunk happens to be one character, so a handler
// that compares the whole chunk against '\r' looks correct for as long as anyone tests it
// by hand. The moment a password is PASTED — which is how a credential out of a password
// manager actually arrives — the chunk is 'hunter2\r', equal to no terminator, and the
// prompt hangs forever with the secret sitting in the buffer. Anything piping input hits
// the same wall.
//
// So: walk the chunk. Callers own the terminal; this owns the decision.

const ENTER = ['\r', '\n', '\u0004'];   // CR, LF, EOT
const INTERRUPT = '\u0003';             // ctrl-C
const ERASE = ['\u007f', '\b'];         // DEL, BS

/**
 * Fold one chunk into the accumulated buffer.
 *
 * @param {string} buf      what has been read so far
 * @param {string} chunk    the raw 'data' payload (may hold any number of characters)
 * @returns {{buf: string, done: boolean, interrupted: boolean}}
 *   `done` — a terminator was seen; `buf` is the final value and anything after the
 *   terminator in the same chunk is deliberately discarded (it belongs to whatever
 *   prompt comes next, not this one).
 *   `interrupted` — ctrl-C was seen; the caller decides how to exit.
 */
function consumeSecretChunk(buf, chunk) {
  let out = String(buf == null ? '' : buf);
  for (const ch of String(chunk == null ? '' : chunk)) {
    if (ch === INTERRUPT) return { buf: out, done: false, interrupted: true };
    if (ENTER.includes(ch)) return { buf: out, done: true, interrupted: false };
    if (ERASE.includes(ch)) { out = out.slice(0, -1); continue; }
    out += ch;
  }
  return { buf: out, done: false, interrupted: false };
}

module.exports = { consumeSecretChunk };
