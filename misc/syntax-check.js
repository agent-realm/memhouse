#!/usr/bin/env node
// Repo-wide JS syntax gate (`npm test`). Walks every .js file outside
// node_modules / public / ui (the UI has its own lint + build gates and uses
// JSX, which `node --check` cannot parse) and fails on the first parse error.
// A deliberately thin gate: it catches the "broken require tree / stray token"
// class of regression across the two storage implementations and 17 adapters
// until a real test suite exists.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', 'public', 'ui', '.git']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (e.name.endsWith('.js')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const files = walk(ROOT, []);
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`SYNTAX ERROR: ${path.relative(ROOT, f)}\n${e.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files parse clean`);
process.exit(failed ? 1 : 0);
