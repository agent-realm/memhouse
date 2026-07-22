const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const crypto = require('crypto');

/**
 * Creates an MCP server instance wired to the relay database.
 * Returns { mcpServer, transports } — caller wires SSE endpoints into Express.
 */
function createMcpServer(getDb) {
  const mcpServer = new McpServer({
    name: 'agentlytics-relay',
    version: '1.0.0',
  });

  // ── Tool: list_users ──
  mcpServer.tool(
    'list_users',
    'List all connected users and their shared projects',
    {},
    async () => {
      const db = getDb();
      if (!db) return { content: [{ type: 'text', text: 'Relay database not initialized' }] };
      const users = db.prepare('SELECT username, last_seen, projects FROM users ORDER BY last_seen DESC').all();
      const result = users.map(u => ({
        username: u.username,
        lastSeen: new Date(u.last_seen).toISOString(),
        projects: JSON.parse(u.projects || '[]'),
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ── Tool: search_sessions ──
  mcpServer.tool(
    'search_sessions',
    'Search across all users\' chat messages by keyword. Use this to find what someone worked on, or find discussions about a specific file or topic.',
    {
      query: z.string().describe('Search query — keyword, file name, or topic'),
      username: z.string().optional().describe('Filter by specific username'),
      project: z.string().optional().describe('Filter by project folder path (partial match)'),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
    async ({ query, username, project, limit }) => {
      const db = getDb();
      if (!db) return { content: [{ type: 'text', text: 'Relay database not initialized' }] };

      let sql = `
        SELECT rm.chat_id, rm.username, rm.role, rm.content, rm.model, rm.seq,
               rc.name as chat_name, rc.source, rc.folder, rc.last_updated_at
        FROM relay_messages rm
        JOIN relay_chats rc ON rm.chat_id = rc.id AND rm.username = rc.username
        WHERE rm.content LIKE ?`;
      const params = [`%${query}%`];

      if (username) { sql += ' AND rm.username = ?'; params.push(username); }
      if (project) { sql += ' AND rc.folder LIKE ?'; params.push(`%${project}%`); }
      sql += ' ORDER BY rc.last_updated_at DESC LIMIT ?';
      params.push(limit || 20);

      const rows = db.prepare(sql).all(...params);

      if (rows.length === 0) {
        return { content: [{ type: 'text', text: `No results found for "${query}"` }] };
      }

      const results = rows.map(r => ({
        chatId: r.chat_id,
        chatName: r.chat_name,
        username: r.username,
        role: r.role,
        source: r.source,
        folder: r.folder,
        lastUpdated: r.last_updated_at ? new Date(r.last_updated_at).toISOString() : null,
        model: r.model,
        content: r.content.length > 300 ? r.content.substring(0, 300) + '...' : r.content,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  // ── Tool: get_user_activity ──
  mcpServer.tool(
    'get_user_activity',
    'Get recent activity for a specific user — their recent sessions, what they worked on, which editors and models they used.',
    {
      username: z.string().describe('Username to look up'),
      project: z.string().optional().describe('Filter by project folder (partial match)'),
      file_path: z.string().optional().describe('Filter by file path mentioned in messages'),
      limit: z.number().optional().describe('Max sessions to return (default 20)'),
    },
    async ({ username, project, file_path, limit }) => {
      const db = getDb();
      if (!db) return { content: [{ type: 'text', text: 'Relay database not initialized' }] };

      // First get sessions
      let sql = `
        SELECT rc.*, rcs.total_messages, rcs.models, rcs.tool_calls,
               rcs.total_input_tokens, rcs.total_output_tokens
        FROM relay_chats rc
        LEFT JOIN relay_chat_stats rcs ON rc.id = rcs.chat_id AND rc.username = rcs.username
        WHERE rc.username = ?`;
      const params = [username];

      if (project) { sql += ' AND rc.folder LIKE ?'; params.push(`%${project}%`); }
      sql += ' ORDER BY rc.last_updated_at DESC LIMIT ?';
      params.push(limit || 20);

      let sessions = db.prepare(sql).all(...params);

      // If file_path filter, narrow down to sessions mentioning that file
      if (file_path && sessions.length > 0) {
        const chatIds = sessions.map(s => s.id);
        const placeholders = chatIds.map(() => '?').join(',');
        const fileMatches = db.prepare(`
          SELECT DISTINCT chat_id FROM relay_messages
          WHERE chat_id IN (${placeholders}) AND username = ? AND content LIKE ?
        `).all(...chatIds, username, `%${file_path}%`);
        const matchingIds = new Set(fileMatches.map(m => m.chat_id));
        sessions = sessions.filter(s => matchingIds.has(s.id));
      }

      if (sessions.length === 0) {
        return { content: [{ type: 'text', text: `No activity found for user "${username}"` }] };
      }

      const result = sessions.map(s => ({
        id: s.id,
        name: s.name,
        source: s.source,
        mode: s.mode,
        folder: s.folder,
        lastUpdated: s.last_updated_at ? new Date(s.last_updated_at).toISOString() : null,
        totalMessages: s.total_messages,
        models: s.models ? [...new Set(JSON.parse(s.models))].slice(0, 5) : [],
        toolCalls: s.tool_calls ? JSON.parse(s.tool_calls).length : 0,
        totalInputTokens: s.total_input_tokens,
        totalOutputTokens: s.total_output_tokens,
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ── Tool: get_session_detail ──
  mcpServer.tool(
    'get_session_detail',
    'Get the full conversation messages for a specific session. Use the session ID from search_sessions or get_user_activity results.',
    {
      session_id: z.string().describe('The chat/session ID'),
      username: z.string().optional().describe('Username who owns the session (optional, auto-detected if unique)'),
    },
    async ({ session_id, username }) => {
      const db = getDb();
      if (!db) return { content: [{ type: 'text', text: 'Relay database not initialized' }] };

      let chatSql = 'SELECT * FROM relay_chats WHERE id = ?';
      const chatParams = [session_id];
      if (username) { chatSql += ' AND username = ?'; chatParams.push(username); }
      chatSql += ' LIMIT 1';

      const chat = db.prepare(chatSql).get(...chatParams);
      if (!chat) {
        return { content: [{ type: 'text', text: `Session "${session_id}" not found` }] };
      }

      const messages = db.prepare(
        'SELECT seq, role, content, model FROM relay_messages WHERE chat_id = ? AND username = ? ORDER BY seq'
      ).all(chat.id, chat.username);

      const formatted = messages.map(m => {
        const label = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
        const modelTag = m.model ? ` (${m.model})` : '';
        const content = m.content.length > 2000 ? m.content.substring(0, 2000) + '\n... [truncated]' : m.content;
        return `## ${label}${modelTag}\n\n${content}`;
      }).join('\n\n---\n\n');

      const header = `# ${chat.name || 'Untitled Session'}\n**User:** ${chat.username} | **Editor:** ${chat.source} | **Project:** ${chat.folder || 'N/A'}\n\n---\n\n`;

      return {
        content: [{ type: 'text', text: header + formatted }],
      };
    }
  );

  return mcpServer;
}

/**
 * Wire MCP SSE transport into an Express app.
 * GET /mcp → establishes SSE connection
 * POST /mcp → receives messages from MCP client
 */
function wireMcpToExpress(app, getDb) {
  const sseTransports = {};
  const httpTransports = {};

  // Same auth gate as the relay's /relay/* routes (same token derivation as
  // createRelayApp): when RELAY_PASSWORD is set, /mcp must not expose
  // search_sessions / get_session_detail to unauthenticated clients.
  const RELAY_PASSWORD = process.env.RELAY_PASSWORD || null;
  const AUTH_TOKEN = RELAY_PASSWORD
    ? require('crypto').createHmac('sha256', 'agentlytics-relay').update(RELAY_PASSWORD).digest('hex')
    : null;
  function requireAuth(req, res, next) {
    if (!AUTH_TOKEN) return next();
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token === AUTH_TOKEN) return next();
    res.status(401).json({ error: 'Unauthorized' });
  }

  // SSE: GET /mcp establishes SSE stream
  app.get('/mcp', requireAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    // Streamable HTTP GET for SSE stream resumption
    if (sessionId && httpTransports[sessionId]) {
      const transport = httpTransports[sessionId];
      await transport.handleRequest(req, res);
      return;
    }

    // Legacy SSE transport
    const transport = new SSEServerTransport('/mcp', res);
    sseTransports[transport.sessionId] = transport;

    const mcpServer = createMcpServer(getDb);

    res.on('close', () => {
      delete sseTransports[transport.sessionId];
      mcpServer.close().catch(() => {});
    });

    await mcpServer.connect(transport);
  });

  // POST /mcp handles both SSE messages and Streamable HTTP
  app.post('/mcp', requireAuth, async (req, res) => {
    // Check for SSE session first
    const sseSessionId = req.query.sessionId;
    if (sseSessionId && sseTransports[sseSessionId]) {
      await sseTransports[sseSessionId].handlePostMessage(req, res);
      return;
    }

    // Streamable HTTP: check for existing session
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && httpTransports[sessionId]) {
      await httpTransports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    // New Streamable HTTP session (initialization request)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        httpTransports[id] = transport;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete httpTransports[transport.sessionId];
      }
    };

    const mcpServer = createMcpServer(getDb);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // DELETE /mcp for session cleanup
  app.delete('/mcp', requireAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && httpTransports[sessionId]) {
      await httpTransports[sessionId].handleRequest(req, res);
      return;
    }
    res.status(404).end();
  });

  return { sseTransports, httpTransports };
}

module.exports = { createMcpServer, wireMcpToExpress };
