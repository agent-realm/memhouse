// Which of this machine's sessions ship — the scope.
//
// By default every adapter runs and the Claude adapter reads every config directory it
// can find (~/.claude and each ~/.claude-playbooks/<name>). A machine that keeps several
// Claude Code instances, or an operator who wants one instance's memory in a team house
// and the rest of their work elsewhere, needs to say which. Two knobs, both plain text in
// the env file so a person can read what a house will receive:
//
//   MEMHOUSE_EDITORS       comma-separated adapter names: `claude`, `codex`, …  Empty = all.
//   MEMHOUSE_CLAUDE_ROOTS  comma-separated directories the Claude adapter reads instead of
//                          discovering — `~/.claude-playbooks/kommander-chaos`. Empty = all.
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
  if (parseList(env.MEMHOUSE_CLAUDE_ROOTS).length) parts.push(`claude roots: ${parseList(env.MEMHOUSE_CLAUDE_ROOTS).join(', ')}`);
  return parts.length ? parts.join('; ') : 'everything this machine has';
}

module.exports = { parseList, selectEditors, selectClaudeRoots, expandHome, describe };
