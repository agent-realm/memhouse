const path = require('path');
const scope = require('./scope');
const fs = require('fs');
const os = require('os');

const GEMINI_DIR = scope.root('gemini-cli', path.join(os.homedir(), '.gemini'));
const TMP_DIR = path.join(GEMINI_DIR, 'tmp');
const PROJECTS_JSON = path.join(GEMINI_DIR, 'projects.json');

// ============================================================
// Adapter interface
// ============================================================

const name = 'gemini-cli';

/**
 * Load project path mapping from ~/.gemini/projects.json
 * Format: { "projects": { "/Users/dev/Code/myapp": "myapp" } }
 * Returns Map<projectName, folderPath>
 */
function loadProjectMap() {
  const map = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    if (data.projects) {
      for (const [folderPath, projName] of Object.entries(data.projects)) {
        map.set(projName, folderPath);
      }
    }
  } catch {}
  return map;
}

/**
 * Load a Gemini session record, handling BOTH on-disk formats:
 *  - legacy single-object JSON: { sessionId, startTime, lastUpdated, messages: [...] }
 *  - newer .jsonl oplog: a header line, then interleaved message objects and
 *    {$set:{messages:[...]}} snapshots. Reconstruct = the latest messages snapshot
 *    (they accumulate) plus any message objects appended after it.
 * Returns { sessionId, startTime, lastUpdated, messages }.
 */
function loadGeminiRecord(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!filePath.endsWith('.jsonl')) {
    const rec = JSON.parse(raw);
    return { sessionId: rec.sessionId, startTime: rec.startTime, lastUpdated: rec.lastUpdated, messages: rec.messages || [] };
  }
  let header = {}, messages = null, tail = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.$set) {
      if (Array.isArray(o.$set.messages)) { messages = o.$set.messages; tail = []; }
      if (o.$set.lastUpdated) header.lastUpdated = o.$set.lastUpdated;
    } else if (o.type && o.content !== undefined) {
      tail.push(o); // message appended after the last snapshot
    } else if (o.sessionId || o.startTime) {
      header = { ...header, ...o }; // header/meta line
    }
  }
  return {
    sessionId: header.sessionId,
    startTime: header.startTime,
    lastUpdated: header.lastUpdated,
    messages: (messages || []).concat(tail),
  };
}

function getChats() {
  const chats = [];
  if (!fs.existsSync(TMP_DIR)) return chats;

  const projectMap = loadProjectMap();

  // Each subdirectory under tmp/ is a project name (e.g. "codename-share")
  let projectDirs;
  try { projectDirs = fs.readdirSync(TMP_DIR); } catch { return chats; }

  for (const projName of projectDirs) {
    const projDir = path.join(TMP_DIR, projName);
    try { if (!fs.statSync(projDir).isDirectory()) continue; } catch { continue; }

    // Sessions are in <projDir>/chats/session-*.json
    const chatsDir = path.join(projDir, 'chats');
    if (!fs.existsSync(chatsDir)) continue;

    let files;
    try {
      // Both formats: legacy session-*.json + newer session-*.jsonl (oplog).
      // The chats/<uuid>/ checkpoint subdirs are skipped (not session- prefixed).
      files = fs.readdirSync(chatsDir).filter(f => f.startsWith('session-') && (f.endsWith('.json') || f.endsWith('.jsonl')));
    } catch { continue; }

    // Resolve folder from projects.json mapping
    const folder = projectMap.get(projName) || null;

    for (const file of files) {
      const fullPath = path.join(chatsDir, file);
      try {
        const record = loadGeminiRecord(fullPath);
        if (!record || !record.messages || record.messages.length === 0) continue;

        const sessionId = record.sessionId || file.replace(/\.jsonl?$/, '');
        const messages = record.messages;

        // Extract first user prompt for title
        const firstUser = messages.find(m => m.type === 'user');
        const firstPrompt = extractTextContent(firstUser?.content);

        chats.push({
          source: 'gemini-cli',
          composerId: sessionId,
          name: firstPrompt ? cleanPrompt(firstPrompt) : null,
          createdAt: record.startTime ? new Date(record.startTime).getTime() : null,
          lastUpdatedAt: record.lastUpdated ? new Date(record.lastUpdated).getTime() : null,
          mode: 'gemini',
          folder,
          encrypted: false,
          bubbleCount: messages.length,
          _fullPath: fullPath,
        });
      } catch { /* skip malformed files */ }
    }
  }

  return chats;
}

function cleanPrompt(text) {
  if (!text) return null;
  return text.replace(/\s+/g, ' ').trim().substring(0, 120) || null;
}

function extractTextContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  // Array of { text } parts (user messages)
  if (Array.isArray(content)) {
    return content
      .filter(p => p.text)
      .map(p => p.text)
      .join('\n') || '';
  }
  if (content.text) return content.text;
  return '';
}

function getMessages(chat) {
  const filePath = chat._fullPath;
  if (!filePath || !fs.existsSync(filePath)) return [];

  let record;
  try {
    record = loadGeminiRecord(filePath);
  } catch { return []; }

  if (!record || !record.messages) return [];

  const result = [];
  for (const msg of record.messages) {
    const type = msg.type;
    const text = extractTextContent(msg.content || msg.displayContent);

    if (type === 'user') {
      if (text) result.push({ role: 'user', content: text });
    } else if (type === 'gemini') {
      const parts = [];
      const toolCalls = [];

      // Thoughts have { subject, description, timestamp }
      if (msg.thoughts && Array.isArray(msg.thoughts)) {
        for (const t of msg.thoughts) {
          const thought = t.description || t.subject || '';
          if (thought) parts.push(`[thinking] ${thought}`);
        }
      }

      // Main text content (string for gemini messages)
      if (text) parts.push(text);

      // Tool calls
      if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          const args = tc.args || {};
          const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
          parts.push(`[tool-call: ${tc.name || 'unknown'}(${argKeys})]`);
          toolCalls.push({ name: tc.name || 'unknown', args });
        }
      }

      if (parts.length > 0) {
        const tokens = msg.tokens || {};
        result.push({
          role: 'assistant',
          content: parts.join('\n'),
          _model: msg.model,
          _inputTokens: tokens.input,
          _outputTokens: tokens.output,
          _cacheRead: tokens.cached,
          _toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      }
    } else if (type === 'info' || type === 'error' || type === 'warning') {
      if (text) result.push({ role: 'system', content: `[${type}] ${text}` });
    }
  }

  return result;
}

const labels = { 'gemini-cli': 'Gemini CLI' };

function getArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  return scanArtifacts(folder, {
    editor: 'gemini-cli',
    label: 'Gemini CLI',
    files: ['GEMINI.md'],
    dirs: [],
  });
}

function getMCPServers() {
  const { parseMcpConfigFile } = require('./base');
  // Global: ~/.gemini/settings.json (mcpServers key)
  const globalSettings = path.join(os.homedir(), '.gemini', 'settings.json');
  return [
    ...parseMcpConfigFile(globalSettings, { editor: 'gemini-cli', label: 'Gemini CLI', scope: 'global' }),
  ];
}

module.exports = { name, labels, getChats, getMessages, getArtifacts, getMCPServers };
