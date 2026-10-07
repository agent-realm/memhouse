#!/usr/bin/env node
// Write a few made-up Claude Code sessions for one person, so an example can ship real
// transcripts without shipping YOURS.
//
//   node make-sessions.js <claude-root> <person> [project ...]
//
// <claude-root> is laid out the way Claude Code lays out ~/.claude: projects/<encoded
// folder>/<session-id>.jsonl. Point memhouse at it with
//
//   MEMHOUSE_EDITORS=claude MEMHOUSE_CLAUDE_ROOTS=<claude-root> memhouse ship
//
// and nothing else on the machine is read. Each project gets one session: a question, a
// tool call, an answer. The project memhouse records is the folder's last segment, so
// `--only project=alpha` in a scoped share matches the session written for `alpha`.
//
// Prints one line per session: <project> <session-id>.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [root, person, ...rest] = process.argv.slice(2);
if (!root || !person || !/^[A-Za-z][A-Za-z0-9_]*$/.test(person)) {
  console.error('usage: make-sessions.js <claude-root> <person> [project ...]');
  process.exit(2);
}
const projects = rest.length ? rest : ['alpha', 'beta'];

// What each made-up session is about — distinct words, so a search can tell them apart.
const TOPICS = {
  alpha: { ask: 'The deploy fails with ClickHouse error ACCESS_DENIED on INSERT. Why?',
    answer: 'The member holds INSERT on its own rooms only. The deploy wrote to a table outside the mem.<member>_* pattern; write to the member rooms instead.' },
  beta: { ask: 'How do I rotate the shipper password without losing data?',
    answer: 'Run memhouse passwd. It rotates the credential and rewrites the env file; the rows in the house are not touched.' },
};
const topic = (p) => TOPICS[p] || { ask: `What is the state of project ${p}?`, answer: `Project ${p} is a made-up example.` };

const now = Date.now();
for (const [i, project] of projects.entries()) {
  const folder = `/home/${person}/work/${project}`;
  const dir = path.join(root, 'projects', folder.replace(/\//g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const sid = crypto.randomUUID();
  // An hour apart per project, a few seconds apart per turn, all in the recent past.
  const t = (s) => new Date(now - (projects.length - i) * 3600e3 + s * 1000).toISOString();
  const { ask, answer } = topic(project);
  const base = { sessionId: sid, cwd: folder, gitBranch: 'main', version: '2.1.0' };
  const lines = [
    { ...base, type: 'user', uuid: 'u1', timestamp: t(0), message: { role: 'user', content: ask } },
    { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: t(4),
      message: { role: 'assistant', model: 'claude-example', content: [
        { type: 'text', text: 'Let me look at the grants first.' },
        { type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: 'memhouse whoami' } },
      ], usage: { input_tokens: 120, output_tokens: 30 } } },
    { ...base, type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: t(6),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: `member ${person}` }] } },
    { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: t(10),
      message: { role: 'assistant', model: 'claude-example', content: [{ type: 'text', text: answer }],
        usage: { input_tokens: 180, output_tokens: 60 } } },
  ];
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  console.log(`${project} ${sid}`);
}
