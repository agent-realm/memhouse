// An instance's plugin is bound to the instance that installed it.
//
// A memhouse INSTANCE is a home: an env file naming a house, the daemons that ship to it,
// and the playbooks (Claude Code config dirs) whose sessions it ships. Its /mem:* skills
// belong in exactly those playbooks, and inside them they must read THAT house and run
// THAT binary — a machine can carry two instances on two channels, and a bare `memhouse`
// with a session-inherited MEMHOUSE_HOME would pick whichever the shell happened to have.
//
// Claude Code applies a settings.json `env` block to every session under a config dir.
// So `plugins install` stamps two variables there, beside the skills it copies:
//
//   MEMHOUSE_HOME  the instance's home  — which house the skills read
//   MEMHOUSE_BIN   the instance's binary — which memhouse the skills run
//
// Nothing else in the file is touched; other env keys survive; `plugins remove` takes the
// two back out. Pure functions here, file I/O below them, both unit-tested.

const fs = require('fs');
const path = require('path');

const KEYS = ['MEMHOUSE_HOME', 'MEMHOUSE_BIN'];

function bindSettings(json, { home, bin }) {
  const out = { ...(json || {}) };
  out.env = { ...(out.env || {}), MEMHOUSE_HOME: home, MEMHOUSE_BIN: bin };
  return out;
}

function unbindSettings(json) {
  const out = { ...(json || {}) };
  if (out.env) {
    out.env = { ...out.env };
    for (const k of KEYS) delete out.env[k];
    if (!Object.keys(out.env).length) delete out.env;
  }
  return out;
}

function boundTo(json) {
  const env = (json && json.env) || {};
  return env.MEMHOUSE_HOME ? { home: env.MEMHOUSE_HOME, bin: env.MEMHOUSE_BIN || null } : null;
}

function settingsPath(dir) { return path.join(dir, 'settings.json'); }

function readSettings(dir) {
  try { return JSON.parse(fs.readFileSync(settingsPath(dir), 'utf-8')); } catch { return null; }
}

function writeSettings(dir, json) {
  fs.writeFileSync(settingsPath(dir), `${JSON.stringify(json, null, 2)}\n`);
}

/** Stamp the binding into a config dir's settings.json; returns what was written. */
function bind(dir, { home, bin }) {
  const cur = readSettings(dir);
  if (cur === null && fs.existsSync(settingsPath(dir))) throw new Error(`${settingsPath(dir)} is not valid JSON — not touching it`);
  writeSettings(dir, bindSettings(cur || {}, { home, bin }));
  return { home, bin };
}

function unbind(dir) {
  const cur = readSettings(dir);
  if (!cur || !boundTo(cur)) return false;
  writeSettings(dir, unbindSettings(cur));
  return true;
}

/**
 * What an instance is called: MEMHOUSE_NAME if the env file sets one, else its home
 * directory with the conventional `.memhouse-` prefix removed — `~/.memhouse-stage` is
 * "stage", `~/.memhouse` is "default", `~/alice-sandbox/memhouse` is "memhouse".
 */
function instanceName(home, envName = '') {
  if (envName) return envName;
  const base = path.basename(String(home || '').replace(/[\/]+$/, ''));
  if (base === '.memhouse') return 'default';
  return base.replace(/^\.memhouse-/, '') || 'default';
}

module.exports = { bindSettings, unbindSettings, boundTo, bind, unbind, readSettings, KEYS, instanceName };
