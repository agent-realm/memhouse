// rpc.js — the only file in memhouse that knows MCP exists.
//
// Targets the 2026-07-28 revision (the stateless one): no handshake, no session,
// version and capabilities in _meta on every request, `server/discover` mandatory,
// CacheableResult on tools/list, resultType on every result. See
// memhouse/mcp/SPEC-2026-07-28.md for the ground truth this was written against.
//
// It is deliberately DUAL-ERA. Most MCP clients in the field still open with the
// legacy `initialize` handshake (2025-06-18 / 2025-11-25), and the spec blesses a
// server that answers both: a request carrying modern per-request _meta is served
// statelessly, an `initialize` selects legacy semantics for this process. Our
// tools surface is identical under both eras, so "legacy mode" is only a result
// shape, not a behavior.
//
// Transport-agnostic: handle() maps one parsed JSON-RPC message to one response
// object (or null for notifications). stdio.js owns framing; a future HTTP mount
// calls the same function.

const path = require('path');
const PKG = require(path.join(__dirname, '..', '..', 'package.json'));
const { TOOLS, RefusalError } = require('./tools');

const MODERN = '2026-07-28';
const META = 'io.modelcontextprotocol/';
const SERVER_INFO = { name: 'memhouse', version: PKG.version };

// The paragraph every client puts in front of its model — written like a tool
// description, not a README.
const INSTRUCTIONS =
  'This server is a read-only archive of agent conversation memory across 17 editors ' +
  '(Claude Code, Codex, Cursor, and the rest), for every member of this house. ' +
  'Call search first: it returns an ID index where each hit carries est_expand_tokens, ' +
  'the cost of fetching that whole session. Fetch full text with get_session only for ' +
  'the ids you chose, slicing large sessions with seq_from/seq_to. timeline gives ' +
  'chronological context around a hit; resume_command turns a hit into the shell ' +
  'command that reopens it in its own editor; sql is for aggregations the other tools ' +
  'cannot express.';

function newState() {
  return { era: null, cancelled: new Set() };
}

function err(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// Modern results carry resultType and the server's identity; legacy clients get
// the bare legacy shape (extra fields would be harmless, but a clean legacy shape
// is what their SDK validators were written against).
function result(id, body, modern) {
  const r = modern
    ? { resultType: 'complete', ...body, _meta: { [`${META}serverInfo`]: SERVER_INFO } }
    : body;
  return { jsonrpc: '2.0', id, result: r };
}

function toolList() {
  // Deterministic order: the array in tools.js IS the order, every time.
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

async function callTool(params) {
  const tool = TOOLS.find((t) => t.name === (params && params.name));
  if (!tool) return { notFound: true };
  try {
    const out = await tool.handler((params && params.arguments) || {});
    return { body: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } };
  } catch (e) {
    // A refusal (no house) and a server refusal (readonly mode, not enough
    // privileges) are answers, not protocol failures: the model should read them.
    const text = e instanceof RefusalError ? e.message : `${e.message || e}`;
    return { body: { content: [{ type: 'text', text }], isError: true } };
  }
}

async function handle(msg, state) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return 'id' in (msg || {}) ? err(msg.id, -32600, 'Invalid Request') : null;
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  // Cancellation (stdio): remember the id so an in-flight response is dropped.
  // The transport deletes an id once it suppresses that response (one-shot);
  // the clamp below covers cancellations for ids that never answer at all —
  // without it a client spamming cancels for made-up ids grows the set forever.
  if (method === 'notifications/cancelled') {
    if (params && params.requestId !== undefined) {
      if (state.cancelled.size >= 1000) state.cancelled.delete(state.cancelled.values().next().value);
      state.cancelled.add(params.requestId);
    }
    return null;
  }
  if (isNotification) return null; // notifications/initialized and anything else: accepted, no reply

  // ── era selection ────────────────────────────────────────────────────────────
  if (method === 'initialize') {
    state.era = 'legacy';
    const requested = (params && params.protocolVersion) || '2025-06-18';
    // Tools-only surface: identical across the legacy revisions, so serve the
    // client's own version rather than forcing a downgrade dance.
    return result(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    }, false);
  }

  const requestedVersion = params && params._meta && params._meta[`${META}protocolVersion`];
  if (requestedVersion && requestedVersion !== MODERN) {
    return err(id, -32022, 'Unsupported protocol version', { supported: [MODERN], requested: requestedVersion });
  }
  // Modern when the request says so; legacy when this process saw initialize;
  // lenient modern otherwise (a version-less request from a modern client is
  // sloppy, not hostile).
  const modern = Boolean(requestedVersion) || state.era !== 'legacy';

  switch (method) {
    case 'server/discover':
      return result(id, {
        supportedVersions: [MODERN],
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        // A release changes this answer; data never does.
        ttlMs: 3600000,
        cacheScope: 'private',
      }, true);

    case 'ping': // legacy liveness; removed in 2026-07-28 but harmless to answer
      return result(id, {}, false);

    case 'tools/list':
      return result(id, {
        tools: toolList(),
        ...(modern ? { ttlMs: 86400000, cacheScope: 'private' } : {}),
      }, modern);

    case 'tools/call': {
      const r = await callTool(params);
      if (r.notFound) return err(id, -32602, `unknown tool: ${params && params.name}`);
      return result(id, r.body, modern);
    }

    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

// Credentials never appear in any response, error body, or log. Every transport
// passes its outgoing frames through this one choke point — a driver error that
// embeds the connection URL cannot leak the password. Read per call, not at
// load: the HTTP mount and the stdio entry stamp the env at different moments.
function scrub(s) {
  const secret = process.env.MEMHOUSE_PASSWORD;
  return secret ? s.split(secret).join('[redacted]') : s;
}

module.exports = { handle, newState, toolList, scrub, SERVER_INFO, MODERN, INSTRUCTIONS };
