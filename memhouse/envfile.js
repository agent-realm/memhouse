// ~/.memhouse/env — one reader and one writer, shared by everything that touches it.
//
// The file is written in shell form (single-quoted values) because the skills and docs
// source it: `. ~/.memhouse/env`. That makes the quoting part of the format, and a second
// parser that only strips the outer quotes silently mangles any password containing a
// quote — `'ab'\''cd'` becomes `ab'\''cd`, so the daemon authenticates with a different
// credential than the interactive commands, and the only symptom is an auth failure that
// looks like a wrong password. So: one parser, here.

/** Parse shell-style `KEY='value'` lines. Understands the `'\''` escape we emit. */
function parse(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
      v = v.slice(1, -1).replace(/'\\''/g, "'");
    } else if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/** Shell single-quoted, safe to `source`. */
function quoteShell(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/**
 * systemd `Environment=` value. Double-quoted with C escapes, which is what systemd's
 * own parser expects — deliberately NOT the shell form, because systemd does not
 * understand `'\''` and would carry the backslashes into the value.
 */
function quoteSystemd(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** systemd cannot express a newline inside Environment=; refuse rather than truncate. */
function assertSingleLine(env) {
  for (const [k, v] of Object.entries(env)) {
    if (/[\r\n]/.test(String(v))) throw new Error(`${k} contains a newline, which cannot be passed to a service`);
  }
}

/**
 * Which connection values in an env file's text differ from what a process currently holds.
 * A running shipper was spawned with one credential; `install --env` rotates the password
 * and rewrites the file, and a member can `memhouse passwd` under a running daemon. In
 * both cases the FILE is the truth and the process copy is stale. Pure; used by the
 * shipper (adopt on auth failure) and by install (adopt before spawning).
 */
function credentialDrift(text, current = {}) {
  const file = parse(String(text || ''));
  const keys = ['MEMHOUSE_URL', 'MEMHOUSE_USER', 'MEMHOUSE_PASSWORD', 'MEMHOUSE_DB'];
  const changed = keys.filter((k) => file[k] !== undefined && file[k] !== current[k]);
  const values = Object.fromEntries(changed.map((k) => [k, file[k]]));
  return { changed, values };
}

module.exports = { credentialDrift, parse, quoteShell, quoteSystemd, assertSingleLine };
