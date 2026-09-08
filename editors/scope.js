// Which of this machine's sessions ship — the scope.
//
// By default every adapter runs and the Claude adapter reads every config directory it
// can find (~/.claude and each ~/.claude-playbooks/<name>). A machine that keeps several
// Claude Code instances, or an operator who wants one instance's memory in a team house
// and the rest of their work elsewhere, needs to say which. Two knobs, both plain text in
// the env file so a person can read what a house will receive:
//
//   MEMHOUSE_EDITORS          comma-separated adapter names: `claude`, `codex`, …  Empty = all.
//   MEMHOUSE_<EDITOR>_ROOTS   the directory that adapter reads instead of its default —
//                             MEMHOUSE_CODEX_ROOTS='~/work/.codex'. The name is the adapter's,
//                             upper-cased, dashes to underscores: MEMHOUSE_GEMINI_CLI_ROOTS.
//                             Claude is the one adapter with MANY roots (each Claude Code
//                             config dir); every other adapter has one store, so one path.
//
// `memhouse discover` prints, per adapter, what it is watching and the variable that
// changes it. Adapters register here at load, so the list is what actually ran.
//
// Both FAIL LOUDLY on a name or path that does not exist. A typo that silently shipped
// nothing would look like a working install with an empty house; one that silently
// shipped everything would defeat the point of setting it.

const fs = require('fs');
const os = require('os');
const path = require('path');

function parseList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** The adapters that should run, in the order given. */
function selectEditors(editors, value) {
  const wanted = parseList(value);
  if (!wanted.length) return editors;
  const byName = new Map(editors.map((e) => [e.name, e]));
  const unknown = wanted.filter((n) => !byName.has(n));
  if (unknown.length) {
    throw new Error(`MEMHOUSE_EDITORS names an adapter that does not exist: ${unknown.join(', ')}. `
      + `Known: ${editors.map((e) => e.name).join(', ')}`);
  }
  return wanted.map((n) => byName.get(n));
}

function expandHome(p) {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * The Claude roots to read. With nothing set, the discovered list as-is. With a list set,
 * exactly those directories — each must exist and hold a `projects/` dir or a
 * `history.jsonl`, the same test discovery applies, so a path that is real but not a
 * Claude config dir is refused rather than silently contributing nothing.
 */
function selectClaudeRoots(discovered, value, { exists = fs.existsSync, isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } } } = {}) {
  const wanted = parseList(value).map(expandHome);
  if (!wanted.length) return discovered;
  const bad = [];
  for (const r of wanted) {
    if (!isDir(r)) { bad.push(`${r} (not a directory)`); continue; }
    if (!isDir(path.join(r, 'projects')) && !exists(path.join(r, 'history.jsonl'))) bad.push(`${r} (no projects/ and no history.jsonl — not a Claude Code config dir)`);
  }
  if (bad.length) throw new Error(`MEMHOUSE_CLAUDE_ROOTS: ${bad.join('; ')}`);
  return wanted;
}

/** One line for status/discover: what this install ships, or 'everything'. */
function describe(env = process.env) {
  const parts = [];
  if (parseList(env.MEMHOUSE_EDITORS).length) parts.push(`editors: ${parseList(env.MEMHOUSE_EDITORS).join(', ')}`);
  for (const k of Object.keys(env).filter((k) => /^MEMHOUSE_[A-Z_]+_ROOTS$/.test(k)).sort()) {
    if (parseList(env[k]).length) parts.push(`${k.slice(9, -6).toLowerCase().replace(/_/g, '-')} roots: ${parseList(env[k]).join(', ')}`);
  }
  return parts.length ? parts.join('; ') : 'everything this machine has';
}

/** The env variable that overrides an adapter's root(s). */
function keyFor(name) { return `MEMHOUSE_${String(name).toUpperCase().replace(/-/g, '_')}_ROOTS`; }

const isDirFs = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * Pure core for a single-store adapter: the override if one is set, else the default.
 * An override must be exactly one existing directory. Errors are RETURNED, not thrown, so
 * a bad value for one adapter skips that adapter with its reason and never takes the other
 * sixteen down with it at module load.
 */
function selectRoot(dflt, value, { isDir = isDirFs } = {}) {
  const wanted = parseList(value).map(expandHome);
  if (!wanted.length) return { root: dflt, error: null };
  if (wanted.length > 1) return { root: null, error: `reads one directory, ${wanted.length} given` };
  if (!isDir(wanted[0])) return { root: null, error: `${wanted[0]} is not a directory` };
  return { root: wanted[0], error: null };
}

// What each adapter is watching, recorded as adapters load. `key` is null for an adapter
// whose location is not overridable yet; `error` is why an override was refused.
const watched = new Map();
const NOWHERE = path.join(os.tmpdir(), 'memhouse-scope-refused-' + process.pid);

function root(name, dflt, env = process.env) {
  const key = keyFor(name);
  const { root: r, error } = selectRoot(dflt, env[key]);
  watched.set(name, { roots: [error ? null : r].filter(Boolean), key, error: error ? `${key}: ${error}` : null });
  return error ? NOWHERE : r;
}

function roots(name, defaults, value, opts) {
  const key = keyFor(name);
  try {
    const r = selectClaudeRoots(defaults, value, opts);
    watched.set(name, { roots: r, key, error: null });
    return r;
  } catch (e) {
    watched.set(name, { roots: [], key, error: String(e.message || e) });
    throw e;
  }
}

/** Register an adapter whose location is built in and not (yet) overridable. */
function fixed(name, dirs) { watched.set(name, { roots: dirs.filter(Boolean), key: null, error: null }); }

function watching() {
  return [...watched.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, w]) => ({ name, ...w }));
}

module.exports = { parseList, selectEditors, selectClaudeRoots, selectRoot, expandHome, describe, keyFor, root, roots, fixed, watching };
