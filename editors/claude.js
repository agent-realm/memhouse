const path = require('path');
const fs = require('fs');
const os = require('os');
const adapterErrors = require('./adapter-errors');

const HOME = os.homedir();

// Discover all Claude Code config roots — ports memory-house agent-sync's
// discover_roots("claude-code"). Claude sessions don't live only under ~/.claude:
// every CLAUDE_CONFIG_DIR (e.g. Kommander playbook installs under
// ~/.claude-playbooks/<name>[/playbook]) has its own projects/ dir. A dir qualifies
// as a root if it holds a projects/ subdir or a history.jsonl. Deduped by realpath.
function discoverClaudeRoots() {
  const cands = [path.join(HOME, '.claude')];
  const pbBase = path.join(HOME, '.claude-playbooks');
  try {
    for (const name of fs.readdirSync(pbBase)) {
      if (name.startsWith('.')) continue; // match glob('*') — skip dotfiles/backups (.bak)
      cands.push(path.join(pbBase, name));
      cands.push(path.join(pbBase, name, 'playbook')); // legacy playbook/ layout
    }
  } catch { /* no ~/.claude-playbooks */ }

  const roots = [];
  const seen = new Set();
  for (const d of cands) {
    let isDir = false;
    try { isDir = fs.statSync(d).isDirectory(); } catch { /* missing */ }
    if (!isDir) continue;
    let hasProjects = false;
    try { hasProjects = fs.statSync(path.join(d, 'projects')).isDirectory(); } catch { /* none */ }
    const hasHistory = fs.existsSync(path.join(d, 'history.jsonl'));
    if (!hasProjects && !hasHistory) continue;
    let rp; try { rp = fs.realpathSync(d); } catch { rp = d; }
    if (seen.has(rp)) continue;
    seen.add(rp);
    roots.push(d);
  }
  // MEMHOUSE_CLAUDE_ROOTS replaces discovery with an explicit list — one Claude Code
  // instance out of several on a machine. Each path is checked the same way as above.
  return require('./scope').roots('claude', roots, process.env.MEMHOUSE_CLAUDE_ROOTS);
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'claude';

function getChats() {
  const chats = [];

  for (const root of discoverClaudeRoots()) {
    const PROJECTS_DIR = path.join(root, 'projects');
    if (!fs.existsSync(PROJECTS_DIR)) continue;

    let projDirs;
    try { projDirs = fs.readdirSync(PROJECTS_DIR); } catch { continue; }
    for (const projDir of projDirs) {
      const dir = path.join(PROJECTS_DIR, projDir);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }

    // Decode folder path from dir name (e.g. -Users-fka-Code-foo -> /Users/fka/Code/foo)
    const decodedFolder = projDir.replace(/-/g, '/');

    // Read sessions-index.json for indexed sessions
    const indexPath = path.join(dir, 'sessions-index.json');
    const indexed = new Map();
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      for (const entry of index.entries || []) {
        indexed.set(entry.sessionId, entry);
      }
    } catch { /* no index */ }

    // Scan all .jsonl files on disk (some may not be in the index)
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    const files = names.filter(f => f.endsWith('.jsonl'));
    // A session with subagents also has a directory named for it; one without has none, so
    // this listing is how the mtime check below stays free for the sessions it cannot help.
    const sessionDirs = new Set(names.filter(f => !f.endsWith('.jsonl')));

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const fullPath = path.join(dir, file);
      const entry = indexed.get(sessionId);
      const subTouched = sessionDirs.has(sessionId) ? newestSubagentMtime(path.join(dir, sessionId, 'subagents')) : 0;

      if (entry) {
        // Use index metadata
        chats.push({
          source: 'claude-code',
          composerId: sessionId,
          name: cleanPrompt(entry.firstPrompt),
          createdAt: entry.created ? new Date(entry.created).getTime() : null,
          lastUpdatedAt: latest(entry.modified ? new Date(entry.modified).getTime() : null, subTouched),
          mode: 'claude',
          folder: entry.projectPath || decodedFolder,
          encrypted: false,
          bubbleCount: entry.messageCount || 0,
          _fullPath: fullPath,
          _gitBranch: entry.gitBranch,
        });
      } else {
        // Orphan .jsonl — extract metadata from file content
        try {
          const stat = fs.statSync(fullPath);
          const meta = peekSessionMeta(fullPath);
          chats.push({
            source: 'claude-code',
            composerId: sessionId,
            name: meta.firstPrompt ? cleanPrompt(meta.firstPrompt) : null,
            createdAt: meta.timestamp || stat.birthtime.getTime(),
            lastUpdatedAt: latest(stat.mtime.getTime(), subTouched),
            mode: 'claude',
            folder: meta.cwd || decodedFolder,
            encrypted: false,
            _fullPath: fullPath,
          });
        } catch { /* skip */ }
      }

      // Remove from indexed so we know what's left
      indexed.delete(sessionId);
    }

    // Add indexed sessions whose .jsonl files no longer exist (show as unavailable)
    for (const [sessionId, entry] of indexed) {
      if (!entry.fullPath || !fs.existsSync(entry.fullPath)) continue;
      chats.push({
        source: 'claude-code',
        composerId: sessionId,
        name: cleanPrompt(entry.firstPrompt),
        createdAt: entry.created ? new Date(entry.created).getTime() : null,
        lastUpdatedAt: entry.modified ? new Date(entry.modified).getTime() : null,
        mode: 'claude',
        folder: entry.projectPath || decodedFolder,
        encrypted: false,
        bubbleCount: entry.messageCount || 0,
        _fullPath: entry.fullPath,
      });
    }
    }
  }

  return chats;
}

function peekSessionMeta(filePath) {
  const meta = { firstPrompt: null, cwd: null, timestamp: null };
  try {
    const buf = fs.readFileSync(filePath, 'utf-8');
    for (const line of buf.split('\n')) {
      if (!line) continue;
      const obj = JSON.parse(line);
      if (!meta.cwd && obj.cwd) meta.cwd = obj.cwd;
      if (!meta.timestamp && obj.timestamp) {
        meta.timestamp = typeof obj.timestamp === 'string'
          ? new Date(obj.timestamp).getTime() : obj.timestamp;
      }
      if (!meta.firstPrompt && obj.type === 'user' && obj.message?.content) {
        const text = typeof obj.message.content === 'string'
          ? obj.message.content
          : obj.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
        meta.firstPrompt = text.substring(0, 200);
      }
      if (meta.cwd && meta.firstPrompt) break;
    }
  } catch {}
  return meta;
}

function cleanPrompt(prompt) {
  if (!prompt || prompt === 'No prompt') return null;
  // Strip envelopes CONTENT AND ALL, before the generic tag strip.
  //
  // <local-command-caveat> was being handled by the tag strip alone, which removes the
  // tags and keeps the text — so 34 of 400 sessions on this machine stored "Caveat: The
  // messages below were generated by the user while running local commands. DO NOT
  // respond to these messages…" as their title and first_prompt. Two costs: it is a
  // 120-character legal blob where a session name belongs, and an agent READING those
  // rows treats it as an instruction aimed at itself. Observed — a Claude Code driving
  // the sessions skill spent two answers warning about "a prompt injection stored as
  // data" instead of listing sessions, and concluded of one row that "the injection
  // worked". Anything whose whole purpose is to instruct a model is not a title.
  let clean = prompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-(?:name|message|args|contents|stdout|stderr)>[\s\S]*?<\/command-\1>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // A prompt that was ONLY an envelope has no title in it. Say so rather than storing a
  // fragment of boilerplate that survived the strip.
  if (/^Caveat: The messages below were generated by the user/i.test(clean)) return null;
  return clean.substring(0, 120) || null;
}

// Parse one Claude session .jsonl into the adapter's message shape. When
// `isSubagent` is set, each message is tagged `[subagent]` so folded subagent turns
// are clearly attributed in the transcript.
function parseSessionFile(filePath, isSubagent, agent = null, info = null) {
  const messages = [];
  let lines;
  try { lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean); } catch { return messages; }
  const tag = isSubagent ? '[subagent] ' : '';
  // A folded subagent turn used to carry only the `[subagent]` tag: the house held the
  // turns but not WHICH subagent said them, so one fork's transcript could not be isolated,
  // cited, or told apart from a sibling's. An agent looking for the fork as its own session
  // concluded it was never shipped. Every turn now carries the agent's id, the description
  // the parent gave it, and its position within that subagent — in `extra`, which is not
  // part of the line hash. The position is not only a label any more: the shipper numbers
  // a subagent's rows from it (seq = block + turn, see subagentSeq in ship.js), so `turn`
  // must count exactly the turns this parse keeps, in order.
  let turn = 0;
  const stamp = (m) => { if (agent) { m._agent = { ...agent, turn: turn++ }; } return m; };

  for (const line of lines) {
    let obj;
    // A line that will not parse is a message that will not be stored. Dropping it in
    // silence means the transcript is quietly short: not withheld, not truncated, and
    // nothing in ship, discover or doctor says a line was lost. The SQLite adapters
    // report their parse failures through this sink and the shipper withholds the session
    // on them; JSONL line failures bypassed it entirely.
    try { obj = JSON.parse(line); } catch (e) {
      adapterErrors.record('claude-code', new Error(`unparseable JSONL line: ${e.message}`), filePath);
      continue;
    }

    // Claude Code stamps every JSONL line with an ISO timestamp. Carrying it through as
    // _ts lets the shipper store when a message was ACTUALLY sent instead of a position
    // interpolated between the session's first and last times — see messageTs() in
    // memhouse/shipper/ship.js. Optional by contract: adapters that have no per-message
    // time simply omit it.
    const _ts = obj.timestamp ? Date.parse(obj.timestamp) : undefined;
    const at = Number.isFinite(_ts) ? _ts : undefined;
    if (info && info.firstTs === undefined && at !== undefined) info.firstTs = at;

    if (obj.type === 'user' && obj.message) {
      const content = extractContent(obj.message.content);
      if (content) messages.push(stamp({ role: 'user', content: tag + content, _ts: at }));
    } else if (obj.type === 'assistant' && obj.message) {
      const { text, toolCalls } = extractAssistantContent(obj.message.content);
      const usage = obj.message.usage;
      if (text) messages.push(stamp({
        role: 'assistant', content: tag + text, _model: obj.message.model,
        _inputTokens: usage?.input_tokens, _outputTokens: usage?.output_tokens,
        _cacheRead: usage?.cache_read_input_tokens, _cacheWrite: usage?.cache_creation_input_tokens,
        _toolCalls: toolCalls, _ts: at,
      }));
    } else if (obj.type === 'system') {
      const text = typeof obj.message?.content === 'string' ? obj.message.content : '';
      if (text) messages.push(stamp({ role: 'system', content: tag + text, _ts: at }));
    }
  }
  return messages;
}

// How long a subagent transcript without a single timestamped line may hold back its
// session (see getMessages). A real one gets its first line within seconds.
const SUBAGENT_STAMP_GRACE_MS = 10 * 60 * 1000;

function getMessages(chat) {
  const filePath = chat._fullPath;
  if (!filePath || !fs.existsSync(filePath)) return [];

  const messages = parseSessionFile(filePath, false);

  // Fold in subagent transcripts — projects/<enc>/<uuid>/subagents/agent-*.jsonl.
  // Their turns + token/tool usage belong to THIS parent session; appended (marked)
  // after the parent's turns, so nothing is lost and subagents are never
  // double-counted as standalone sessions.
  const subagentsDir = path.join(filePath.replace(/\.jsonl$/, ''), 'subagents');
  const subFiles = subagentFiles(subagentsDir);
  const named = subFiles.length ? subagentNames(filePath) : new Map();
  const folded = [];
  let unstamped = null;
  for (const { file, workflow } of subFiles) {
    const id = path.basename(file).replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const meta = named.get(id) || {};
    const agent = { id, description: meta.description || '', type: meta.type || (workflow ? 'workflow-subagent' : ''), file: path.basename(file) };
    if (workflow) agent.workflow = workflow;
    const info = {};
    const turns = parseSessionFile(file, true, agent, info);
    // A fork the parent never named (a Workflow-run agent, or a parent from before the
    // ids were reported) is described by its own first prompt — what it was told to do.
    if (!agent.description) {
      const first = turns.find((m) => m.role === 'user');
      if (first) { const d = String(first.content).replace(/^\[subagent\] /, '').replace(/\s+/g, ' ').trim().slice(0, 160); for (const m of turns) m._agent.description = d; }
    }
    folded.push({ key: path.relative(subagentsDir, file), firstTs: info.firstTs, turns });
    // A subagent caught before its first line is written has no start time, so it ranks
    // last — and when its first line lands with an EARLIER timestamp than a sibling's, it
    // moves, renumbers every sibling after it, and the session forks and re-ships whole
    // (GLM-F1). So a fresh one defers the whole session to the next pass, when it has a
    // time. Bounded by age: a file that never gets a timestamped line stops deferring after
    // SUBAGENT_STAMP_GRACE_MS and ranks last, as before.
    if (info.firstTs === undefined && !unstamped) {
      let age = Infinity;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* gone: nothing to wait for */ }
      if (age < SUBAGENT_STAMP_GRACE_MS) unstamped = path.relative(subagentsDir, file);
    }
  }
  // Each subagent gets a SLOT, and the shipper numbers its rows from that slot rather than
  // from where they happen to land in this array (see subagentSeq in ship.js). The slot is
  // the subagent's rank by when it started — the timestamp on its transcript's first line —
  // because that is the one order a new subagent cannot disturb: it started after every
  // subagent already on disk, so it ranks last. The file-name order this used to fold in
  // does not have that property: agent ids are random, so a new fork sorted into the middle
  // and pushed every later subagent's rows down, and a session with subagents re-shipped
  // whole on every pass (one 6,120-line session was stored 60 times in a day). A file with
  // no timestamp yet ranks after every one that has one; the path breaks ties.
  folded.sort((a, b) => (a.firstTs === undefined) - (b.firstTs === undefined)
    || (a.firstTs || 0) - (b.firstTs || 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  folded.forEach(({ turns }, slot) => { for (const m of turns) m._agent.slot = slot; messages.push(...turns); });
  if (unstamped) {
    Object.defineProperty(messages, '_defer', { value: `subagent ${unstamped} has no timestamped line yet`, enumerable: false });
  }

  return messages;
}

/**
 * When a session was last written, counting its subagents. The shipper's incremental skip
 * compares `lastUpdatedAt` with what the house recorded, and a subagent writes only its own
 * file: a background agent that runs on after its parent goes quiet left the parent's mtime
 * (and the index's `modified`) where they were, so its turns shipped at the parent's next
 * write, or never. Stat calls only, and only for a session that has a directory.
 */
function newestSubagentMtime(subagentsDir) {
  let newest = 0;
  for (const { file } of subagentFiles(subagentsDir)) {
    try { newest = Math.max(newest, fs.statSync(file).mtimeMs); } catch { /* vanished mid-pass */ }
  }
  return Math.floor(newest);
}
function latest(a, b) { return b && (!a || b > a) ? b : a; }

/**
 * Every subagent transcript under a session, wherever Claude Code put it:
 *   <session>/subagents/agent-<id>.jsonl                       — Agent tool forks
 *   <session>/subagents/workflows/wf_<id>/agent-<id>.jsonl     — Workflow-run agents
 * journal.jsonl and *.meta.json are bookkeeping, not transcripts. Sorted so the listing is
 * deterministic; the fold ORDER is set by start time in getMessages, not by this.
 * On real data the workflow layer held 100 of 165 forks and shipped none.
 */
function subagentFiles(subagentsDir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(subagentsDir); } catch { return out; }
  for (const f of names.sort()) if (f.startsWith('agent-') && f.endsWith('.jsonl')) out.push({ file: path.join(subagentsDir, f), workflow: null });
  const wfDir = path.join(subagentsDir, 'workflows');
  let wfs = [];
  try { wfs = fs.readdirSync(wfDir).filter((d) => d.startsWith('wf_')).sort(); } catch { return out; }
  for (const wf of wfs) {
    let files = [];
    try { files = fs.readdirSync(path.join(wfDir, wf)); } catch { continue; }
    for (const f of files.sort()) if (f.startsWith('agent-') && f.endsWith('.jsonl')) out.push({ file: path.join(wfDir, wf, f), workflow: wf });
  }
  return out;
}

/**
 * What the parent called each subagent. The parent's `Agent` tool_use carries the
 * description and subagent_type; the tool_result that answers it names the agentId
 * ("agentId: <id>"). Join the two through tool_use_id → a map agentId → {description, type}.
 * Best effort: a parent that predates the ids, or a truncated line, just yields no name.
 */
function subagentNames(parentFile) {
  const byToolUse = new Map(); const out = new Map();
  let lines = [];
  try { lines = fs.readFileSync(parentFile, 'utf-8').split('\n').filter(Boolean); } catch { return out; }
  for (const line of lines) {
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const content = obj.message && Array.isArray(obj.message.content) ? obj.message.content : [];
    for (const c of content) {
      if (c && c.type === 'tool_use' && c.name === 'Agent' && c.id) {
        byToolUse.set(c.id, { description: String((c.input && c.input.description) || ''), type: String((c.input && c.input.subagent_type) || '') });
      } else if (c && c.type === 'tool_result' && c.tool_use_id && byToolUse.has(c.tool_use_id)) {
        const text = typeof c.content === 'string' ? c.content : (Array.isArray(c.content) ? c.content.map((x) => (x && x.text) || '').join('\n') : '');
        const m = /agentId:\s*([0-9a-f]{6,})/i.exec(text);
        if (m) out.set(m[1], byToolUse.get(c.tool_use_id));
      }
    }
    // A background subagent reports through a task notification instead — a user-role
    // line whose text carries <task-id>agentId</task-id> and <tool-use-id>toolu_…</tool-use-id>.
    // On real data 30 of 65 forks were named only this way.
    const flat = typeof (obj.message && obj.message.content) === 'string' ? obj.message.content
      : content.map((x) => (x && typeof x.text === 'string') ? x.text : '').join('\n');
    if (flat.includes('<task-notification>')) {
      for (const block of flat.split('<task-notification>').slice(1)) {
        const t = /<task-id>([0-9a-f]{6,})<\/task-id>/i.exec(block); const u = /<tool-use-id>(toolu_[A-Za-z0-9]+)<\/tool-use-id>/.exec(block);
        if (t && u && byToolUse.has(u[1]) && !out.has(t[1])) out.set(t[1], byToolUse.get(u[1]));
      }
    }
  }
  return out;
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n') || '';
}

function extractAssistantContent(content) {
  if (typeof content === 'string') return { text: content, toolCalls: [] };
  if (!Array.isArray(content)) return { text: '', toolCalls: [] };
  const parts = [];
  const toolCalls = [];
  for (const block of content) {
    if (block.type === 'thinking' && block.thinking) {
      parts.push(`[thinking] ${block.thinking}`);
    } else if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      const args = block.input || {};
      const argKeys = Object.keys(args).join(', ');
      parts.push(`[tool-call: ${block.name || 'unknown'}(${argKeys})]`);
      toolCalls.push({ name: block.name || 'unknown', args });
    } else if (block.type === 'tool_result') {
      const text = typeof block.content === 'string' ? block.content : '';
      parts.push(`[tool-result: ${block.name || 'tool'}] ${text.substring(0, 500)}`);
    }
  }
  return { text: parts.join('\n') || '', toolCalls };
}

// ============================================================
// Usage / quota data from Anthropic OAuth API
// ============================================================

function getClaudeCredentials() {
  // macOS: Keychain; Linux: secret-tool; Windows: not yet supported
  // Requires explicit user permission (allowSubscriptionAccess in config)
  const { isSubscriptionAccessAllowed } = require('./base');
  if (!isSubscriptionAccessAllowed()) return null;
  try {
    const { execSync } = require('child_process');
    let raw;
    if (process.platform === 'darwin') {
      raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf-8', timeout: 5000 }).trim();
    } else if (process.platform === 'linux') {
      raw = execSync('secret-tool lookup service "Claude Code-credentials"', { encoding: 'utf-8', timeout: 5000 }).trim();
    } else {
      return null;
    }
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth;
    if (!oauth || !oauth.accessToken) return null;
    return oauth;
  } catch { return null; }
}

function claudeApiFetch(token) {
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.get('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'agentlytics/1.0',
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function getUsage() {
  const creds = getClaudeCredentials();
  if (!creds) return null;

  const usage = await claudeApiFetch(creds.accessToken);
  if (!usage) return null;

  const result = {
    source: 'claude-code',
    plan: {
      name: creds.subscriptionType || null,
    },
    usage: {},
    extraUsage: null,
  };

  if (usage.five_hour) {
    result.usage.fiveHour = {
      utilization: usage.five_hour.utilization,
      resetsAt: usage.five_hour.resets_at || null,
    };
  }
  if (usage.seven_day) {
    result.usage.sevenDay = {
      utilization: usage.seven_day.utilization,
      resetsAt: usage.seven_day.resets_at || null,
    };
  }
  if (usage.seven_day_sonnet) {
    result.usage.sevenDaySonnet = {
      utilization: usage.seven_day_sonnet.utilization,
      resetsAt: usage.seven_day_sonnet.resets_at || null,
    };
  }
  if (usage.seven_day_opus) {
    result.usage.sevenDayOpus = {
      utilization: usage.seven_day_opus.utilization,
      resetsAt: usage.seven_day_opus.resets_at || null,
    };
  }
  if (usage.extra_usage) {
    result.extraUsage = {
      isEnabled: usage.extra_usage.is_enabled || false,
      monthlyLimit: usage.extra_usage.monthly_limit || null,
      usedCredits: usage.extra_usage.used_credits || null,
      utilization: usage.extra_usage.utilization || null,
    };
  }

  return result;
}

const labels = { 'claude-code': 'Claude Code' };

function getArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  return scanArtifacts(folder, {
    editor: 'claude-code',
    label: 'Claude Code',
    files: ['CLAUDE.md', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json'],
    dirs: ['.claude/commands'],
  });
}

function getMCPServers() {
  const { parseMcpConfigFile } = require('./base');
  const results = [];
  // Global: ~/.claude.json (has mcpServers key)
  const globalFile = path.join(os.homedir(), '.claude.json');
  results.push(...parseMcpConfigFile(globalFile, { editor: 'claude-code', label: 'Claude Code', scope: 'global' }));
  // Project-level: .mcp.json (scanned per-project later via getAllMCPServers)
  return results;
}

// discoverClaudeRoots is exported for the CLI's plugin installer, which needs the same
// answer to a different question: where this pilot's Claude Code instances live. Two
// implementations of "find every CLAUDE_CONFIG_DIR" would drift the first time a playbook
// layout changes, and this is the copy exercised on every single ship.
module.exports = { name, labels, getChats, getMessages, getUsage, getArtifacts, getMCPServers, discoverClaudeRoots, subagentNames, subagentFiles };
