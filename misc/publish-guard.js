#!/usr/bin/env node
// Refuse a publish that crosses the release lines. Runs as `prepublishOnly`, so it fires
// for `npm publish` and `npm publish --dry-run` alike, whoever — or whatever agent — runs it.
//
// The lines (also in AGENTS.md § Release lines — keep the two in step):
//   npm tag  →  branch         →  versions
//   latest   →  release/0.17   →  0.17.x   (zeo)
//   team     →  main           →  0.18.x   (santiment)
//
// A 0.17.1 was once built and tagged on `master` and published to `latest` by an agent
// that had not seen the table. Nothing broke, but the branch and the registry disagreed
// for a day. This makes that impossible rather than merely documented.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LINES = {
  latest: { branch: 'release/0.17', minor: '0.17' },
  team: { branch: 'main', minor: '0.18' },
};

const root = path.join(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).version;
const tag = process.env.npm_config_tag || 'latest';
const sh = (c) => { try { return execSync(c, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const branch = sh('git rev-parse --abbrev-ref HEAD');
const atTag = sh(`git describe --tags --exact-match HEAD`);
const dirty = sh('git status --porcelain --untracked-files=no');
const gitFile = path.join(root, '.git');
const isWorktree = fs.existsSync(gitFile) && fs.statSync(gitFile).isFile();

const fail = (why) => { console.error(`\npublish refused: ${why}\n\n  version ${version}   --tag ${tag}   branch ${branch || '?'}   at tag ${atTag || 'none'}\n\n  lines:  latest ↔ release/0.17 ↔ 0.17.x     team ↔ main ↔ 0.18.x   (AGENTS.md § Release lines)\n`); process.exit(1); };

const line = LINES[tag];
if (!line) fail(`'${tag}' is not a release line — use --tag latest (zeo, 0.17.x) or --tag team (santiment, 0.18.x)`);
if (!version.startsWith(`${line.minor}.`)) fail(`${version} is not a ${line.minor}.x version; the '${tag}' tag only ever points at ${line.minor}.x`);
if (branch !== line.branch) fail(`the '${tag}' line is published from ${line.branch}, not from ${branch || 'a detached HEAD'}`);
if (atTag !== `v${version}`) fail(`HEAD is not the tagged release commit v${version} (git describe says '${atTag || 'no tag'}') — tag first, publish from the tag`);
if (dirty) fail('the working tree has uncommitted changes — a publish must equal the tagged commit');
if (isWorktree) console.error('note: publishing from a git worktree drops gitHead from the package metadata; the primary checkout keeps it.');
console.error(`publish guard: ${version} → --tag ${tag} from ${branch} at ${atTag} — lines agree`);
