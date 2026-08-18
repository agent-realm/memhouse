// stdio.js — the stdio transport: newline-delimited JSON-RPC on stdin/stdout.
//
// Entered via `memhouse mcp` (bin/memhouse.js resolves the house and stamps
// MEMHOUSE_* into the environment first — order matters, queries.js snapshots env
// at require time). Framing per the spec: one message per line, no embedded
// newlines, and the server MUST NOT write anything to stdout that is not a valid
// MCP message.
//
// That last rule is enforced structurally, not by discipline: console.* is
// rebound to stderr BEFORE anything else loads, so a stray log from any
// dependency — including the ClickHouse driver when MEMHOUSE_DEBUG=1 un-silences
// it — cannot corrupt the protocol stream. Protocol frames go through
// process.stdout.write directly.

const toErr = (...a) => process.stderr.write(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') + '\n');
console.log = toErr;
console.info = toErr;
console.warn = toErr;
console.debug = toErr;

const { handle, newState, scrub } = require('./rpc');

const state = newState();

function write(obj) {
  process.stdout.write(scrub(JSON.stringify(obj)) + '\n');
}

async function dispatch(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  try {
    const res = await handle(msg, state);
    // A cancelled request gets no further messages, per the spec.
    if (res && !(msg.id !== undefined && state.cancelled.has(msg.id))) write(res);
  } catch (e) {
    toErr(`memhouse mcp: ${e && e.stack || e}`);
    if (msg.id !== undefined) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
    }
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) dispatch(line);
  }
});
// stdin EOF is the graceful-shutdown signal — the only portable one. Nothing to
// flush: no session, no queue, no partial write anywhere.
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
