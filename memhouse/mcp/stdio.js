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
//
// stderr is scrubbed too, console.error included. The spec lets a client ignore
// stderr, but this repo's rule is stronger than the spec's: credentials appear
// in NO response, error body, or log — and a driver error carrying the
// connection URL is exactly the kind of line that lands on stderr.

const { handle, newState, scrub } = require('./rpc');

const toErr = (...a) =>
  process.stderr.write(scrub(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')) + '\n');
console.log = toErr;
console.info = toErr;
console.warn = toErr;
console.debug = toErr;
console.error = toErr;

const state = newState();

// The client owning this pipe can die mid-write; an EPIPE from stdout must not
// become an unhandled rejection that takes the process down with a stack trace
// instead of the clean exit the next paragraph owns.
function write(obj) {
  try {
    // Backpressure is deliberately NOT handled with pause/drain: every result
    // is already bounded (10000 rows / 64MB at the query layer), so the worst
    // case Node buffers is one capped frame per in-flight call — and the
    // stream keeps its own order. The caps are the protection; a drain dance
    // here would add a stall path for no bound we don't already have.
    process.stdout.write(scrub(JSON.stringify(obj)) + '\n');
  } catch (e) {
    toErr(`memhouse mcp: stdout write failed: ${e && e.message || e}`);
  }
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
    // A cancelled request gets no further messages, per the spec. The id is
    // then FORGOTTEN: cancellation is one-shot, and JSON-RPC ids only have to
    // be unique among in-flight requests — a client legitimately reusing an
    // old id later must not have its response silently dropped forever.
    if (res) {
      if (msg.id !== undefined && state.cancelled.has(msg.id)) state.cancelled.delete(msg.id);
      else write(res);
    }
  } catch (e) {
    toErr(`memhouse mcp: ${e && e.stack || e}`);
    if (msg.id !== undefined) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
    }
  }
}

// A line has to fit in memory twice (buffer + parsed), and a runaway client
// streaming gigabytes without a newline would OOM this process before any
// query cap could matter. 64MB is far above any legitimate frame (the largest
// thing a client sends is a sql query TEXT, not a result). Past it, the stream
// is garbage by definition and there is no way to resynchronize newline
// framing mid-line — exit, and let the client respawn a clean server.
const MAX_LINE = 64 * 1024 * 1024;

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  if (buf.length > MAX_LINE) {
    toErr(`memhouse mcp: refusing a single frame over ${MAX_LINE} bytes — stream is unrecoverable, exiting`);
    process.exit(1);
  }
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    // dispatch never rejects (its body is fully guarded), but a guard at the
    // call site costs nothing and an unhandled rejection here kills the server.
    if (line.trim()) dispatch(line).catch((e) => toErr(`memhouse mcp: ${e && e.stack || e}`));
  }
});
// stdin EOF is the graceful-shutdown signal — the only portable one. Nothing to
// flush: no session, no queue, no partial write anywhere.
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
