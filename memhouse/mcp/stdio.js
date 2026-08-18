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

// ── flow control ────────────────────────────────────────────────────────────────
// Three bounds, together: MAX_LINE bounds what one frame may cost to buffer,
// MAX_INFLIGHT bounds how many requests run at once, and the stdout drain gate
// stops NEW work while a client is not reading its answers. Any one of them
// alone leaves an OOM open — capped results times unbounded concurrency is
// still unbounded, which the review round two pointed out after round one had
// waved it off with "the results are capped".
const MAX_LINE = 64 * 1024 * 1024;
const MAX_INFLIGHT = 32;

let buf = '';
let inFlight = 0;
let stdoutBusy = false;

// The client owning this pipe can die mid-write. A sync throw is caught here;
// the ASYNC 'error' the stream emits later (EPIPE arrives on a later tick) is
// handled at the bottom of this file — a try/catch cannot reach it.
function write(obj) {
  try {
    if (!process.stdout.write(scrub(JSON.stringify(obj)) + '\n') && !stdoutBusy) {
      // One listener per congestion episode: in-flight responses finishing
      // while the pipe is already full would otherwise stack a 'drain'
      // listener each, and Node warns about the pile-up on stderr.
      stdoutBusy = true;
      process.stdout.once('drain', () => { stdoutBusy = false; flow(); });
    }
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

// Drain complete frames from the buffer while every gate is open, then set the
// stdin valve to match the pressure. Runs on data, on every request completion,
// and on stdout drain — each one can reopen a gate.
function flow() {
  let i;
  while (!stdoutBusy && inFlight < MAX_INFLIGHT && (i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    inFlight++;
    // dispatch never rejects (its body is fully guarded), but a terminal catch
    // costs nothing and an unhandled rejection here kills the server.
    dispatch(line)
      .catch((e) => toErr(`memhouse mcp: ${e && e.stack || e}`))
      .finally(() => { inFlight--; flow(); });
  }
  // Fatal ONLY when a single frame can never complete: over the cap with no
  // newline in sight. A large buffer that still contains newlines is a backlog
  // (the in-flight or stdout gate is closed), not a poison frame — the first
  // version of this check killed the server for a valid 63MB frame with a
  // second frame queued behind it.
  if (buf.length > MAX_LINE && buf.indexOf('\n') < 0) {
    toErr(`memhouse mcp: refusing a single frame over ${MAX_LINE} bytes — stream is unrecoverable, exiting`);
    process.exit(1);
  }
  if (stdoutBusy || inFlight >= MAX_INFLIGHT || buf.length > MAX_LINE) process.stdin.pause();
  else process.stdin.resume();
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { buf += chunk; flow(); });
// stdin EOF is the graceful-shutdown signal — the only portable one. In-flight
// requests are dropped with the process: the protocol is stateless and the
// client's contract is to re-issue, not to wait.
process.stdin.on('end', () => process.exit(0));
// EPIPE from a client that died is delivered as an async stream 'error' no
// try/catch reaches. stdout gone means nobody is listening — exit like EOF.
// stderr gone just means nobody wants logs.
process.stdout.on('error', () => process.exit(0));
process.stderr.on('error', () => {});
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
