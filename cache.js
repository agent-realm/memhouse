// cache.js — ClickHouse-backed analytics cache.
//
// HARD REPLACEMENT for the former better-sqlite3 implementation. Same public API
// (same exported function names + return shapes) so server.js is unchanged except
// that every getter is now async (ClickHouse's client is Promise-based) and must be
// awaited. Ingest/scan lives in ch-ingest.js; schema in ch-schema.js; this file is
// the read/query layer that server.js calls.
//
// SQL dialect notes (SQLite → ClickHouse):
//   - `?` positional params → named `{name:Type}` params via query_params.
//   - `date(ts/1000,'unixepoch','localtime')` → formatDateTime(toDateTime(intDiv(ts,1000)), fmt, tz).
//     Local-time buckets pass the machine tz; UTC month buckets pass 'UTC' (matches
//     SQLite's plain 'unixepoch').
//   - `strftime('%H'…)` → toHour(…, tz); `strftime('%w'…)` (Sun=0..Sat=6) → toDayOfWeek(…,0,tz) % 7.
//   - JSON columns (models, tool_calls, args_json) stay strings, parsed in JS exactly
//     as before. The client returns 64-bit ints as numbers (see clickhouse.js).

const { getClient } = require('./clickhouse');
const chIngest = require('./ch-ingest');
const { calculateCost, normalizeModelName } = require('./pricing');

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const DATA_TABLES = ['chats', 'chat_stats', 'messages', 'tool_calls', 'meta', 'gsd_projects', 'gsd_phases'];

async function q(query, params = {}) {
  const rs = await getClient().query({ query, query_params: params, format: 'JSONEachRow' });
  return rs.json();
}
async function q1(query, params = {}) { return (await q(query, params))[0]; }
function safeParseJson(s) { try { return JSON.parse(s); } catch { return {}; } }

// Most-frequent model in a chat_stats.models JSON array (null if none).
function dominantOfModels(modelsJson) {
  let models; try { models = JSON.parse(modelsJson || '[]'); } catch { return null; }
  if (!models.length) return null;
  const freq = {};
  for (const m of models) freq[m] = (freq[m] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
}

// ── init / scan (delegate to the ingest layer) ──────────────────────────────────
const initDb = chIngest.initDb;
const scanAllAsync = chIngest.scanAllAsync;
const cacheGSDProjects = chIngest.cacheGSDProjects;
async function scanAll(onProgress, opts) { return chIngest.scanAllAsync(onProgress, opts); }

async function resetAndRescanAsync(onProgress) {
  const client = getClient();
  for (const t of DATA_TABLES) await client.command({ query: `TRUNCATE TABLE IF EXISTS ${t}` });
  await initDb();
  return scanAllAsync(onProgress);
}

// Empty the data tables (keeps the schema + meta.schema_version). Replaces the
// SQLite `--no-cache` file wipe. Callers should await initDb() first.
async function clearAll() {
  const client = getClient();
  for (const t of ['chats', 'chat_stats', 'messages', 'tool_calls', 'gsd_projects', 'gsd_phases']) {
    await client.command({ query: `TRUNCATE TABLE IF EXISTS ${t}` });
  }
}

// ── shared filter builder (named params) ────────────────────────────────────────
// col: table alias holding source/folder/timestamps (always 'c').
// editorLike/folderLike toggle LIKE-substring vs exact-equality, matching each
// getter's original SQLite behavior.
function filters(opts, col, { editorLike = false, folderLike = false } = {}) {
  const parts = [];
  const params = {};
  if (opts.hiddenFolders && opts.hiddenFolders.length) {
    parts.push(`(${col}.folder IS NULL OR ${col}.folder NOT IN {hidden:Array(String)})`);
    params.hidden = opts.hiddenFolders;
  }
  if (opts.editor) {
    if (editorLike) { parts.push(`${col}.source LIKE {editor:String}`); params.editor = `%${opts.editor}%`; }
    else { parts.push(`${col}.source = {editor:String}`); params.editor = opts.editor; }
  }
  if (opts.folder) {
    if (folderLike) { parts.push(`${col}.folder LIKE {folder:String}`); params.folder = `%${opts.folder}%`; }
    else { parts.push(`${col}.folder = {folder:String}`); params.folder = opts.folder; }
  }
  if (opts.dateFrom != null) { parts.push(`COALESCE(${col}.last_updated_at, ${col}.created_at) >= {dateFrom:Int64}`); params.dateFrom = opts.dateFrom; }
  if (opts.dateTo != null) { parts.push(`COALESCE(${col}.last_updated_at, ${col}.created_at) <= {dateTo:Int64}`); params.dateTo = opts.dateTo; }
  return {
    and: parts.length ? ' AND ' + parts.join(' AND ') : '',
    where: parts.length ? ' WHERE ' + parts.join(' AND ') : '',
    params,
  };
}

// SQL fragment: epoch-ms column → seconds DateTime
const dt = (ms) => `toDateTime(intDiv(${ms}, 1000))`;

// ── chats list ──────────────────────────────────────────────────────────────────
async function getCachedChats(opts = {}) {
  const f = filters(opts, 'c', { editorLike: true, folderLike: true });
  let sql = `SELECT c.*,
    cs.models AS _models,
    cs.total_input_tokens AS _inTok, cs.total_output_tokens AS _outTok,
    cs.total_cache_read AS _cacheR, cs.total_cache_write AS _cacheW,
    cs.total_user_chars AS _uChars, cs.total_assistant_chars AS _aChars
    FROM chats AS c LEFT JOIN chat_stats AS cs ON cs.chat_id = c.id WHERE 1=1${f.and}`;
  const params = { ...f.params };
  if (opts.named !== false) sql += ' AND (c.name IS NOT NULL OR c.bubble_count > 0)';
  sql += ' ORDER BY c.last_updated_at DESC';
  if (opts.limit) { sql += ' LIMIT {limit:UInt64}'; params.limit = opts.limit; }
  if (opts.offset) { sql += ' OFFSET {offset:UInt64}'; params.offset = opts.offset; }

  const rows = await q(sql, params);
  for (const r of rows) {
    r.top_model = null;
    try {
      const models = JSON.parse(r._models || '[]');
      if (models.length > 0) {
        const freq = {};
        for (const m of models) freq[m] = (freq[m] || 0) + 1;
        r.top_model = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
      }
    } catch { /* no models */ }
    let inTok = r._inTok || 0, outTok = r._outTok || 0;
    if (inTok === 0 && outTok === 0 && ((r._uChars || 0) > 0 || (r._aChars || 0) > 0)) {
      inTok = Math.round((r._uChars || 0) / 4);
      outTok = Math.round((r._aChars || 0) / 4);
    }
    r.cost = r.top_model ? (calculateCost(r.top_model, inTok, outTok, r._cacheR || 0, r._cacheW || 0) || 0) : 0;
    delete r._models; delete r._inTok; delete r._outTok; delete r._cacheR; delete r._cacheW; delete r._uChars; delete r._aChars;
  }
  return rows;
}

async function countCachedChats(opts = {}) {
  const f = filters(opts, 'c', { editorLike: true, folderLike: true });
  let sql = `SELECT count() AS cnt FROM chats AS c WHERE 1=1${f.and}`;
  if (opts.named !== false) sql += ' AND (c.name IS NOT NULL OR c.bubble_count > 0)';
  return Number((await q1(sql, f.params)).cnt);
}

// ── overview ──────────────────────────────────────────────────────────────────
async function getCachedOverview(opts = {}) {
  const f = filters(opts, 'c');
  const totalChats = Number((await q1(`SELECT count() AS cnt FROM chats AS c${f.where}`, f.params)).cnt);

  const editors = opts.folder
    ? await q(`SELECT source, count() AS count FROM chats AS c${f.where} GROUP BY source ORDER BY count DESC`, f.params)
    : await q('SELECT source, count() AS count FROM chats GROUP BY source ORDER BY count DESC');

  const modes = await q(`SELECT mode, count() AS count FROM chats AS c WHERE mode IS NOT NULL${f.and} GROUP BY mode`, f.params);
  const byMode = {};
  for (const m of modes) byMode[m.mode] = Number(m.count);

  const rows = await q(`
    SELECT formatDateTime(${dt('last_updated_at')}, '%Y-%m', 'UTC') AS month, source, count() AS count
    FROM chats AS c WHERE last_updated_at IS NOT NULL${f.and}
    GROUP BY month, source ORDER BY month`, f.params);
  const monthMap = {};
  for (const r of rows) {
    if (!monthMap[r.month]) monthMap[r.month] = { count: 0, editors: {} };
    monthMap[r.month].count += Number(r.count);
    monthMap[r.month].editors[r.source] = Number(r.count);
  }
  const byMonth = Object.keys(monthMap).sort().map(m => ({ month: m, ...monthMap[m] }));

  const projects = await q(`
    SELECT folder, count() AS count FROM chats AS c
    WHERE folder IS NOT NULL${f.and} GROUP BY folder ORDER BY count DESC LIMIT 20`, f.params);
  const topProjects = projects.map(p => ({
    name: p.folder.split(/[/\\]/).slice(-2).join('/'),
    fullPath: p.folder,
    count: Number(p.count),
  }));

  const oldest = (await q1(`SELECT min(COALESCE(c.last_updated_at, c.created_at)) AS ts FROM chats AS c${f.where}`, f.params)).ts;
  const newest = (await q1(`SELECT max(COALESCE(c.last_updated_at, c.created_at)) AS ts FROM chats AS c${f.where}`, f.params)).ts;

  return {
    totalChats,
    editors: editors.map(e => ({ id: e.source, count: Number(e.count) })),
    byMode, byMonth, topProjects,
    oldestChat: oldest, newestChat: newest,
  };
}

// ── daily activity ──────────────────────────────────────────────────────────────
async function getCachedDailyActivity(opts = {}) {
  const f = filters(opts, 'c');
  const params = { ...f.params, tz: TZ };
  const rows = await q(`
    SELECT formatDateTime(${dt('COALESCE(last_updated_at, created_at)')}, '%Y-%m-%d', {tz:String}) AS day,
           source,
           toHour(${dt('COALESCE(last_updated_at, created_at)')}, {tz:String}) AS hour,
           count() AS count
    FROM chats AS c
    WHERE (last_updated_at IS NOT NULL OR created_at IS NOT NULL)${f.and}
    GROUP BY day, source, hour ORDER BY day`, params);

  const daily = {};
  for (const r of rows) {
    if (!daily[r.day]) daily[r.day] = { total: 0, editors: {}, hours: {} };
    const cnt = Number(r.count);
    daily[r.day].total += cnt;
    daily[r.day].editors[r.source] = (daily[r.day].editors[r.source] || 0) + cnt;
    if (!daily[r.day].hours[r.source]) daily[r.day].hours[r.source] = new Array(24).fill(0);
    daily[r.day].hours[r.source][Number(r.hour)] += cnt;
  }
  return Object.keys(daily).sort().map(day => ({ day, ...daily[day] }));
}

// ── deep analytics ──────────────────────────────────────────────────────────────
async function getCachedDeepAnalytics(opts = {}) {
  const f = filters(opts, 'c', { editorLike: true });
  let sql = `SELECT cs.* FROM chat_stats AS cs JOIN chats AS c ON cs.chat_id = c.id WHERE 1=1${f.and} ORDER BY cs.analyzed_at DESC`;
  const params = { ...f.params };
  if (opts.limit) { sql += ' LIMIT {limit:UInt64}'; params.limit = opts.limit; }
  const rows = await q(sql, params);

  const toolFreq = {}, modelFreq = {};
  let totalMessages = 0, totalUserChars = 0, totalAssistantChars = 0;
  let totalToolCalls = 0, totalInputTokens = 0, totalOutputTokens = 0, totalCacheRead = 0, totalCacheWrite = 0;

  for (const r of rows) {
    totalMessages += r.total_messages;
    totalUserChars += r.total_user_chars;
    totalAssistantChars += r.total_assistant_chars;
    totalInputTokens += r.total_input_tokens;
    totalOutputTokens += r.total_output_tokens;
    totalCacheRead += r.total_cache_read;
    totalCacheWrite += r.total_cache_write;
    try { for (const t of JSON.parse(r.tool_calls)) { toolFreq[t] = (toolFreq[t] || 0) + 1; totalToolCalls++; } } catch { /* skip */ }
    try { for (const m of JSON.parse(r.models)) { const k = normalizeModelName(m) || m; modelFreq[k] = (modelFreq[k] || 0) + 1; } } catch { /* skip */ }
  }

  let tokensEstimated = false;
  if (totalInputTokens === 0 && totalOutputTokens === 0 && (totalUserChars > 0 || totalAssistantChars > 0)) {
    totalInputTokens = Math.round(totalUserChars / 4);
    totalOutputTokens = Math.round(totalAssistantChars / 4);
    tokensEstimated = true;
  }

  return {
    analyzedChats: rows.length,
    totalMessages, totalToolCalls, totalUserChars, totalAssistantChars,
    totalInputTokens, totalOutputTokens, tokensEstimated, totalCacheRead, totalCacheWrite,
    topTools: Object.entries(toolFreq).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count })),
    topModels: Object.entries(modelFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count })),
  };
}

// ── single chat ─────────────────────────────────────────────────────────────────
async function getCachedChat(id) {
  const chat = await q1('SELECT * FROM chats AS c WHERE id LIKE {idp:String} LIMIT 1', { idp: id + '%' });
  if (!chat) return null;

  const stats = await q1('SELECT * FROM chat_stats WHERE chat_id = {cid:String} LIMIT 1', { cid: chat.id });
  const msgSql = 'SELECT role, content, model, input_tokens, output_tokens, cache_read, cache_write FROM messages WHERE chat_id = {cid:String} ORDER BY seq';
  let messages = await q(msgSql, { cid: chat.id });

  // No cached messages → try a live fetch from the editor adapter (display only).
  if (messages.length === 0 && !chat.encrypted) {
    try {
      const meta = safeParseJson(chat._meta || '{}');
      const { getMessages } = require('./editors');
      const live = getMessages({
        composerId: chat.id, source: chat.source, name: chat.name, mode: chat.mode,
        folder: chat.folder, createdAt: chat.created_at, lastUpdatedAt: chat.last_updated_at,
        encrypted: !!chat.encrypted, bubbleCount: chat.bubble_count, ...meta,
      });
      if (live && live.length) {
        messages = live.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          model: m._model || null, input_tokens: m._inputTokens || null, output_tokens: m._outputTokens || null,
        }));
      }
    } catch { /* live fetch failed */ }
  }

  let parsedStats = null;
  if (stats) {
    parsedStats = {
      totalMessages: stats.total_messages, userMessages: stats.user_messages,
      assistantMessages: stats.assistant_messages, toolMessages: stats.tool_messages,
      systemMessages: stats.system_messages,
      toolCalls: JSON.parse(stats.tool_calls || '[]'), models: JSON.parse(stats.models || '[]'),
      totalUserChars: stats.total_user_chars, totalAssistantChars: stats.total_assistant_chars,
      totalInputTokens: stats.total_input_tokens, totalOutputTokens: stats.total_output_tokens,
      totalCacheRead: stats.total_cache_read, totalCacheWrite: stats.total_cache_write,
    };
  }

  const toolCalls = await q('SELECT tool_name, args_json FROM tool_calls WHERE chat_id = {cid:String} ORDER BY idx', { cid: chat.id });
  const toolCallDetails = toolCalls.map(tc => ({ name: tc.tool_name, args: safeParseJson(tc.args_json) }));

  return {
    id: chat.id, source: chat.source, name: chat.name, mode: chat.mode, folder: chat.folder,
    createdAt: chat.created_at, lastUpdatedAt: chat.last_updated_at, encrypted: !!chat.encrypted,
    messages: messages.map(m => ({ role: m.role, content: m.content, model: m.model, inputTokens: m.input_tokens || 0, outputTokens: m.output_tokens || 0 })),
    stats: parsedStats, toolCallDetails,
  };
}

// ── projects ──────────────────────────────────────────────────────────────────
async function getCachedProjects(opts = {}) {
  const df = filters({
    hiddenFolders: opts.includeHidden ? [] : opts.hiddenFolders,
    dateFrom: opts.dateFrom, dateTo: opts.dateTo,
  }, 'c');

  const projects = await q(`
    SELECT folder, source, count() AS count,
      min(COALESCE(c.last_updated_at, c.created_at)) AS first_seen,
      max(COALESCE(c.last_updated_at, c.created_at)) AS last_seen
    FROM chats AS c WHERE folder IS NOT NULL${df.and}
    GROUP BY folder, source ORDER BY folder, count DESC`, df.params);

  const map = {};
  for (const r of projects) {
    if (!map[r.folder]) map[r.folder] = { folder: r.folder, totalSessions: 0, editors: {}, firstSeen: r.first_seen, lastSeen: r.last_seen };
    map[r.folder].totalSessions += Number(r.count);
    map[r.folder].editors[r.source] = Number(r.count);
    if (r.first_seen && r.first_seen < map[r.folder].firstSeen) map[r.folder].firstSeen = r.first_seen;
    if (r.last_seen && r.last_seen > map[r.folder].lastSeen) map[r.folder].lastSeen = r.last_seen;
  }

  const result = [];
  for (const [folder, proj] of Object.entries(map)) {
    const stats = await q(`
      SELECT cs.models, cs.tool_calls, cs.total_messages, cs.total_input_tokens, cs.total_output_tokens,
             cs.total_user_chars, cs.total_assistant_chars, cs.total_cache_read, cs.total_cache_write
      FROM chat_stats AS cs JOIN chats AS c ON cs.chat_id = c.id
      WHERE c.folder = {folder:String}${df.and}`, { ...df.params, folder });

    const modelFreq = {}, toolFreq = {};
    let totalMessages = 0, totalInputTokens = 0, totalOutputTokens = 0;
    let totalUserChars = 0, totalAssistantChars = 0, totalToolCalls = 0, totalCacheRead = 0, totalCacheWrite = 0;
    for (const s of stats) {
      totalMessages += s.total_messages;
      totalInputTokens += s.total_input_tokens;
      totalOutputTokens += s.total_output_tokens;
      totalUserChars += s.total_user_chars;
      totalAssistantChars += s.total_assistant_chars;
      totalCacheRead += s.total_cache_read;
      totalCacheWrite += s.total_cache_write;
      try { for (const m of JSON.parse(s.models)) { const k = normalizeModelName(m) || m; modelFreq[k] = (modelFreq[k] || 0) + 1; } } catch { /* skip */ }
      try { for (const t of JSON.parse(s.tool_calls)) { toolFreq[t] = (toolFreq[t] || 0) + 1; totalToolCalls++; } } catch { /* skip */ }
    }

    let tokensEstimated = false;
    if (totalInputTokens === 0 && totalOutputTokens === 0 && (totalUserChars > 0 || totalAssistantChars > 0)) {
      totalInputTokens = Math.round(totalUserChars / 4);
      totalOutputTokens = Math.round(totalAssistantChars / 4);
      tokensEstimated = true;
    }

    result.push({
      folder: proj.folder, name: proj.folder.split(/[/\\]/).pop(),
      totalSessions: proj.totalSessions, editors: proj.editors,
      firstSeen: proj.firstSeen, lastSeen: proj.lastSeen,
      totalMessages, totalInputTokens, totalOutputTokens, tokensEstimated,
      totalUserChars, totalAssistantChars, totalToolCalls, totalCacheRead, totalCacheWrite,
      topModels: Object.entries(modelFreq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
      topTools: Object.entries(toolFreq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
    });
  }
  return result.sort((a, b) => b.totalSessions - a.totalSessions);
}

// ── tool calls ──────────────────────────────────────────────────────────────────
async function getCachedToolCalls(toolName, opts = {}) {
  const limit = opts.limit || 200;
  let sql = `SELECT tc.tool_name, tc.args_json, tc.source, tc.folder, tc.timestamp,
             c.name AS chat_name, tc.chat_id
             FROM tool_calls AS tc JOIN chats AS c ON tc.chat_id = c.id
             WHERE tc.tool_name = {name:String}`;
  const params = { name: toolName, limit };
  if (opts.folder) { sql += ' AND tc.folder = {folder:String}'; params.folder = opts.folder; }
  // Drill-downs honor the same filters as the analytics they are opened from.
  if (opts.hiddenFolders && opts.hiddenFolders.length) {
    sql += ' AND (tc.folder IS NULL OR tc.folder NOT IN {hidden:Array(String)})';
    params.hidden = opts.hiddenFolders;
  }
  if (opts.editor) { sql += ' AND tc.source LIKE {editor:String}'; params.editor = `%${opts.editor}%`; }
  if (opts.dateFrom != null) { sql += ' AND tc.timestamp >= {dateFrom:Int64}'; params.dateFrom = opts.dateFrom; }
  if (opts.dateTo != null) { sql += ' AND tc.timestamp <= {dateTo:Int64}'; params.dateTo = opts.dateTo; }
  sql += ' ORDER BY tc.timestamp DESC LIMIT {limit:UInt64}';
  const rows = await q(sql, params);
  return rows.map(r => ({
    toolName: r.tool_name, args: safeParseJson(r.args_json), source: r.source, folder: r.folder,
    timestamp: r.timestamp, chatName: r.chat_name, chatId: r.chat_id,
  }));
}

// ── dashboard stats ─────────────────────────────────────────────────────────────
async function getCachedDashboardStats(opts = {}) {
  const f = filters(opts, 'c');
  const p = { ...f.params, tz: TZ };

  const hourlyRows = await q(`
    SELECT toHour(${dt('COALESCE(last_updated_at, created_at)')}, {tz:String}) AS hour, count() AS count
    FROM chats AS c WHERE (last_updated_at IS NOT NULL OR created_at IS NOT NULL)${f.and}
    GROUP BY hour ORDER BY hour`, p);
  const hourly = new Array(24).fill(0);
  for (const r of hourlyRows) hourly[Number(r.hour)] = Number(r.count);

  const weekdayRows = await q(`
    SELECT toDayOfWeek(${dt('COALESCE(last_updated_at, created_at)')}, 0, {tz:String}) % 7 AS dow, count() AS count
    FROM chats AS c WHERE (last_updated_at IS NOT NULL OR created_at IS NOT NULL)${f.and}
    GROUP BY dow ORDER BY dow`, p);
  const weekdays = new Array(7).fill(0);
  for (const r of weekdayRows) weekdays[Number(r.dow)] = Number(r.count);

  const depthRows = await q(`
    SELECT cs.total_messages AS msgs FROM chat_stats AS cs JOIN chats AS c ON cs.chat_id = c.id
    WHERE cs.total_messages > 0${f.and}`, f.params);
  const depthBuckets = { '1': 0, '2-5': 0, '6-10': 0, '11-20': 0, '21-50': 0, '51-100': 0, '100+': 0 };
  for (const r of depthRows) {
    const m = r.msgs;
    if (m <= 1) depthBuckets['1']++;
    else if (m <= 5) depthBuckets['2-5']++;
    else if (m <= 10) depthBuckets['6-10']++;
    else if (m <= 20) depthBuckets['11-20']++;
    else if (m <= 50) depthBuckets['21-50']++;
    else if (m <= 100) depthBuckets['51-100']++;
    else depthBuckets['100+']++;
  }

  const tokenRow = await q1(`
    SELECT COALESCE(sum(cs.total_input_tokens), 0) AS input, COALESCE(sum(cs.total_output_tokens), 0) AS output,
           COALESCE(sum(cs.total_cache_read), 0) AS cacheRead, COALESCE(sum(cs.total_cache_write), 0) AS cacheWrite,
           COALESCE(sum(cs.total_user_chars), 0) AS userChars, COALESCE(sum(cs.total_assistant_chars), 0) AS assistantChars,
           count() AS sessions
    FROM chat_stats AS cs JOIN chats AS c ON cs.chat_id = c.id WHERE 1=1${f.and}`, f.params);

  const streakRows = await q(`
    SELECT DISTINCT formatDateTime(${dt('COALESCE(last_updated_at, created_at)')}, '%Y-%m-%d', {tz:String}) AS day
    FROM chats AS c WHERE (last_updated_at IS NOT NULL OR created_at IS NOT NULL)${f.and}
    ORDER BY day`, p);
  let currentStreak = 0, longestStreak = 0, tempStreak = 1;
  const today = new Date().toISOString().split('T')[0];
  for (let i = 1; i < streakRows.length; i++) {
    const diff = (new Date(streakRows[i].day) - new Date(streakRows[i - 1].day)) / 86400000;
    if (diff === 1) tempStreak++;
    else { if (tempStreak > longestStreak) longestStreak = tempStreak; tempStreak = 1; }
  }
  if (tempStreak > longestStreak) longestStreak = tempStreak;
  if (streakRows.length > 0) {
    const daysDiff = (new Date(today) - new Date(streakRows[streakRows.length - 1].day)) / 86400000;
    if (daysDiff <= 1) {
      currentStreak = 1;
      for (let i = streakRows.length - 2; i >= 0; i--) {
        if ((new Date(streakRows[i + 1].day) - new Date(streakRows[i].day)) / 86400000 === 1) currentStreak++;
        else break;
      }
    }
  }

  const monthEditorRows = await q(`
    SELECT formatDateTime(${dt('COALESCE(last_updated_at, created_at)')}, '%Y-%m', 'UTC') AS month, source, count() AS count
    FROM chats AS c WHERE (last_updated_at IS NOT NULL OR created_at IS NOT NULL)${f.and}
    GROUP BY month, source ORDER BY month`, f.params);
  const monthEditors = {};
  const allSources = new Set();
  for (const r of monthEditorRows) {
    if (!monthEditors[r.month]) monthEditors[r.month] = {};
    monthEditors[r.month][r.source] = Number(r.count);
    allSources.add(r.source);
  }

  const velocityRows = await q(`
    SELECT formatDateTime(${dt('c.last_updated_at')}, '%Y-%m', 'UTC') AS month,
           avg(cs.total_messages) AS avgMsgs, avg(cs.total_input_tokens + cs.total_output_tokens) AS avgTokens
    FROM chat_stats AS cs JOIN chats AS c ON cs.chat_id = c.id
    WHERE c.last_updated_at IS NOT NULL${f.and} GROUP BY month ORDER BY month`, f.params);

  const modelRows = await q(`SELECT cs.models FROM chat_stats AS cs JOIN chats AS c ON cs.chat_id = c.id WHERE 1=1${f.and}`, f.params);
  const modelFreq = {};
  for (const r of modelRows) { try { for (const m of JSON.parse(r.models)) { const k = normalizeModelName(m) || m; modelFreq[k] = (modelFreq[k] || 0) + 1; } } catch { /* skip */ } }
  const topModels = Object.entries(modelFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const toolRows = await q(`SELECT cs.tool_calls FROM chat_stats AS cs JOIN chats AS c ON cs.chat_id = c.id WHERE 1=1${f.and}`, f.params);
  const toolFreq = {};
  let totalToolCalls = 0;
  for (const r of toolRows) { try { for (const t of JSON.parse(r.tool_calls)) { toolFreq[t] = (toolFreq[t] || 0) + 1; totalToolCalls++; } } catch { /* skip */ } }
  const topTools = Object.entries(toolFreq).sort((a, b) => b[1] - a[1]).slice(0, 8);

  let inputTokens = Number(tokenRow.input), outputTokens = Number(tokenRow.output);
  let tokensEstimated = false;
  if (inputTokens === 0 && outputTokens === 0 && (tokenRow.userChars > 0 || tokenRow.assistantChars > 0)) {
    inputTokens = Math.round(tokenRow.userChars / 4);
    outputTokens = Math.round(tokenRow.assistantChars / 4);
    tokensEstimated = true;
  }

  return {
    hourly, weekdays, depthBuckets,
    tokens: {
      input: inputTokens, output: outputTokens, cacheRead: Number(tokenRow.cacheRead), cacheWrite: Number(tokenRow.cacheWrite),
      userChars: Number(tokenRow.userChars), assistantChars: Number(tokenRow.assistantChars),
      sessions: Number(tokenRow.sessions), estimated: tokensEstimated,
    },
    streaks: { current: currentStreak, longest: longestStreak, totalDays: streakRows.length },
    monthlyTrend: { months: Object.keys(monthEditors).sort(), sources: [...allSources], data: monthEditors },
    velocity: velocityRows.map(r => ({ month: r.month, avgMsgs: Math.round(r.avgMsgs * 10) / 10, avgTokens: Math.round(r.avgTokens) })),
    topModels: topModels.map(([name, count]) => ({ name, count })),
    topTools: topTools.map(([name, count]) => ({ name, count })),
    totalToolCalls,
  };
}

// ── cost estimation ─────────────────────────────────────────────────────────────
async function estimateCosts(filterSql = '', params = {}) {
  const modelTokens = await q(`
    SELECT m.model AS model, sum(m.input_tokens) AS input, sum(m.output_tokens) AS output,
           sum(m.cache_read) AS cacheRead, sum(m.cache_write) AS cacheWrite
    FROM messages AS m JOIN chats AS c ON m.chat_id = c.id
    WHERE m.model IS NOT NULL AND (m.input_tokens > 0 OR m.output_tokens > 0 OR m.cache_read > 0 OR m.cache_write > 0)${filterSql}
    GROUP BY m.model`, params);

  const orphanRows = await q(`
    SELECT m.chat_id AS chat_id, sum(m.input_tokens) AS input, sum(m.output_tokens) AS output,
           sum(m.cache_read) AS cacheRead, sum(m.cache_write) AS cacheWrite
    FROM messages AS m JOIN chats AS c ON m.chat_id = c.id
    WHERE m.model IS NULL AND (m.input_tokens > 0 OR m.output_tokens > 0 OR m.cache_read > 0 OR m.cache_write > 0)${filterSql}
    GROUP BY m.chat_id`, params);

  // Preload chat_id → models once (replaces per-chat lookups).
  const statsModels = {};
  for (const r of await q('SELECT chat_id, models FROM chat_stats')) statsModels[r.chat_id] = r.models;

  const orphanByModel = {};
  const addOrphan = (dominant, input, output, cacheRead, cacheWrite) => {
    if (!orphanByModel[dominant]) orphanByModel[dominant] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    orphanByModel[dominant].input += input || 0;
    orphanByModel[dominant].output += output || 0;
    orphanByModel[dominant].cacheRead += cacheRead || 0;
    orphanByModel[dominant].cacheWrite += cacheWrite || 0;
  };
  const dominantOf = (modelsJson) => {
    let models; try { models = JSON.parse(modelsJson || '[]'); } catch { return null; }
    if (!models.length) return null;
    const freq = {};
    for (const m of models) freq[m] = (freq[m] || 0) + 1;
    return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
  };

  for (const r of orphanRows) {
    const dominant = dominantOf(statsModels[r.chat_id]);
    if (dominant) addOrphan(dominant, r.input, r.output, r.cacheRead, r.cacheWrite);
  }

  const CHARS_PER_TOKEN = 4;
  const charRows = await q(`
    SELECT cs.models AS models, cs.total_user_chars AS userChars, cs.total_assistant_chars AS asstChars
    FROM chat_stats AS cs JOIN chats AS c ON cs.chat_id = c.id
    WHERE cs.models != '[]' AND cs.total_input_tokens = 0 AND cs.total_output_tokens = 0
      AND (cs.total_user_chars > 0 OR cs.total_assistant_chars > 0)${filterSql}`, params);
  for (const r of charRows) {
    const dominant = dominantOf(r.models);
    if (dominant) addOrphan(dominant, Math.round((r.userChars || 0) / CHARS_PER_TOKEN), Math.round((r.asstChars || 0) / CHARS_PER_TOKEN), 0, 0);
  }

  const unmodeledRows = await q(`
    SELECT c.source AS source, cs.total_input_tokens AS input, cs.total_output_tokens AS output,
           cs.total_cache_read AS cacheRead, cs.total_cache_write AS cacheWrite
    FROM chat_stats AS cs JOIN chats AS c ON cs.chat_id = c.id
    WHERE cs.models = '[]' AND (cs.total_input_tokens > 0 OR cs.total_output_tokens > 0)${filterSql}`, params);
  if (unmodeledRows.length > 0) {
    const allSessions = await q(`
      SELECT c.source AS source, cs.models AS models FROM chat_stats AS cs JOIN chats AS c ON cs.chat_id = c.id
      WHERE cs.models != '[]'${filterSql}`, params);
    const sourceModelFreq = {};
    for (const s of allSessions) {
      let models; try { models = JSON.parse(s.models || '[]'); } catch { continue; }
      if (!sourceModelFreq[s.source]) sourceModelFreq[s.source] = {};
      for (const m of models) sourceModelFreq[s.source][m] = (sourceModelFreq[s.source][m] || 0) + 1;
    }
    const globalFreq = {};
    for (const sf of Object.values(sourceModelFreq)) for (const [m, c] of Object.entries(sf)) globalFreq[m] = (globalFreq[m] || 0) + c;
    const globalDominant = Object.entries(globalFreq).sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const r of unmodeledRows) {
      const sf = sourceModelFreq[r.source];
      const dominant = sf ? Object.entries(sf).sort((a, b) => b[1] - a[1])[0]?.[0] : globalDominant;
      if (dominant) addOrphan(dominant, r.input, r.output, r.cacheRead, r.cacheWrite);
    }
  }

  const tokenMap = {};
  const addTokens = (rawModel, input, output, cacheRead, cacheWrite) => {
    const key = normalizeModelName(rawModel) || rawModel;
    if (!tokenMap[key]) tokenMap[key] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    tokenMap[key].input += input || 0;
    tokenMap[key].output += output || 0;
    tokenMap[key].cacheRead += cacheRead || 0;
    tokenMap[key].cacheWrite += cacheWrite || 0;
  };
  for (const row of modelTokens) addTokens(row.model, row.input, row.output, row.cacheRead, row.cacheWrite);
  for (const [model, tok] of Object.entries(orphanByModel)) addTokens(model, tok.input, tok.output, tok.cacheRead, tok.cacheWrite);

  let totalCost = 0;
  let unknownModels = [];
  const byModel = [];
  for (const [model, tok] of Object.entries(tokenMap)) {
    const cost = calculateCost(model, tok.input, tok.output, tok.cacheRead, tok.cacheWrite);
    if (cost !== null) {
      totalCost += cost;
      byModel.push({ model, inputTokens: tok.input, outputTokens: tok.output, cacheRead: tok.cacheRead, cacheWrite: tok.cacheWrite, cost });
    } else unknownModels.push(model);
  }
  byModel.sort((a, b) => b.cost - a.cost);
  unknownModels = [...new Set(unknownModels)];
  return { totalCost, byModel, unknownModels };
}

async function getCostBreakdown(opts = {}) {
  const f = filters(opts, 'c', { editorLike: true });
  const params = { ...f.params };
  let sql = f.and;
  if (opts.chatId) { sql += ' AND c.id = {chatId:String}'; params.chatId = opts.chatId; }
  return estimateCosts(sql, params);
}

// Per-chat cost attribution for a filter, in a FIXED number of bulk queries
// (3) instead of the former N+1 (~5 per session). Mirrors estimateCosts' logic
// but keyed per chat; because calculateCost is linear in tokens, the per-chat
// costs sum to the same overall total as estimateCosts.
async function computePerChatCosts(filterSql, params) {
  const aRows = await q(`
    SELECT m.chat_id AS chat_id, m.model AS model, sum(m.input_tokens) AS i, sum(m.output_tokens) AS o,
           sum(m.cache_read) AS cr, sum(m.cache_write) AS cw
    FROM messages AS m JOIN chats AS c ON m.chat_id = c.id
    WHERE m.model IS NOT NULL AND (m.input_tokens > 0 OR m.output_tokens > 0 OR m.cache_read > 0 OR m.cache_write > 0)${filterSql}
    GROUP BY chat_id, model`, params);
  const byChatModel = {};
  for (const r of aRows) (byChatModel[r.chat_id] = byChatModel[r.chat_id] || []).push(r);

  const bRows = await q(`
    SELECT m.chat_id AS chat_id, sum(m.input_tokens) AS i, sum(m.output_tokens) AS o,
           sum(m.cache_read) AS cr, sum(m.cache_write) AS cw
    FROM messages AS m JOIN chats AS c ON m.chat_id = c.id
    WHERE m.model IS NULL AND (m.input_tokens > 0 OR m.output_tokens > 0 OR m.cache_read > 0 OR m.cache_write > 0)${filterSql}
    GROUP BY chat_id`, params);
  const orphanByChat = {};
  for (const r of bRows) orphanByChat[r.chat_id] = r;

  const cRows = await q(`
    SELECT c.id AS id, c.source AS source, c.name AS name, c.folder AS folder,
           c.last_updated_at AS last_updated_at, c.created_at AS created_at,
           cs.total_messages AS msgs, cs.models AS models,
           cs.total_user_chars AS uc, cs.total_assistant_chars AS ac,
           cs.total_input_tokens AS ti, cs.total_output_tokens AS to_,
           cs.total_cache_read AS cr, cs.total_cache_write AS cw,
           formatDateTime(${dt('COALESCE(c.last_updated_at, c.created_at)')}, '%Y-%m', 'UTC') AS month
    FROM chat_stats AS cs JOIN chats AS c ON cs.chat_id = c.id WHERE 1=1${filterSql}`, params);

  // source → dominant model (over chats that name a model) + global fallback.
  const sourceModelFreq = {};
  for (const r of cRows) {
    if (r.models === '[]') continue;
    let models; try { models = JSON.parse(r.models || '[]'); } catch { continue; }
    if (!sourceModelFreq[r.source]) sourceModelFreq[r.source] = {};
    for (const m of models) sourceModelFreq[r.source][m] = (sourceModelFreq[r.source][m] || 0) + 1;
  }
  const globalFreq = {};
  for (const sf of Object.values(sourceModelFreq)) for (const [m, c] of Object.entries(sf)) globalFreq[m] = (globalFreq[m] || 0) + c;
  const globalDominant = Object.entries(globalFreq).sort((a, b) => b[1] - a[1])[0]?.[0];
  const sourceDominant = {};
  for (const [src, fr] of Object.entries(sourceModelFreq)) sourceDominant[src] = Object.entries(fr).sort((a, b) => b[1] - a[1])[0]?.[0];

  const CHARS_PER_TOKEN = 4;
  const out = [];
  for (const c of cRows) {
    const hasModels = c.models !== '[]';
    const dominant = dominantOfModels(c.models);
    const tokenMap = {};
    const add = (rawModel, i, o, cr, cw) => {
      if (!rawModel) return;
      const key = normalizeModelName(rawModel) || rawModel;
      if (!tokenMap[key]) tokenMap[key] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      tokenMap[key].input += i || 0; tokenMap[key].output += o || 0; tokenMap[key].cacheRead += cr || 0; tokenMap[key].cacheWrite += cw || 0;
    };
    for (const r of (byChatModel[c.id] || [])) add(r.model, r.i, r.o, r.cr, r.cw);
    const orphan = orphanByChat[c.id];
    if (orphan && dominant) add(dominant, orphan.i, orphan.o, orphan.cr, orphan.cw);
    if (hasModels && c.ti === 0 && c.to_ === 0 && (c.uc > 0 || c.ac > 0) && dominant)
      add(dominant, Math.round((c.uc || 0) / CHARS_PER_TOKEN), Math.round((c.ac || 0) / CHARS_PER_TOKEN), 0, 0);
    if (!hasModels && (c.ti > 0 || c.to_ > 0)) {
      const srcDom = sourceDominant[c.source] || globalDominant;
      if (srcDom) add(srcDom, c.ti, c.to_, c.cr, c.cw);
    }
    let totalCost = 0; const byModel = [];
    for (const [model, tok] of Object.entries(tokenMap)) {
      const cost = calculateCost(model, tok.input, tok.output, tok.cacheRead, tok.cacheWrite);
      if (cost !== null) { totalCost += cost; byModel.push({ model, cost }); }
    }
    byModel.sort((a, b) => b.cost - a.cost);
    out.push({ id: c.id, source: c.source, name: c.name, folder: c.folder, last_updated_at: c.last_updated_at, created_at: c.created_at, msgs: c.msgs, month: c.month, totalCost, byModel });
  }
  return out;
}

async function getCostAnalytics(opts = {}) {
  const f = filters(opts, 'c', { editorLike: true });
  const overall = await getCostBreakdown(opts);
  const perChat = await computePerChatCosts(f.and, f.params);

  const editorAgg = {}, projectAgg = {}, monthCosts = {};
  const sessionCosts = [];
  for (const r of perChat) {
    // monthly counts every measured session (cost may be 0)
    if (r.month) {
      if (!monthCosts[r.month]) monthCosts[r.month] = { cost: 0, sessions: 0 };
      monthCosts[r.month].cost += r.totalCost;
      monthCosts[r.month].sessions++;
    }
    if (r.totalCost <= 0) continue;
    if (!editorAgg[r.source]) editorAgg[r.source] = { cost: 0, models: new Set() };
    editorAgg[r.source].cost += r.totalCost;
    for (const m of r.byModel) editorAgg[r.source].models.add(m.model);
    if (r.folder) projectAgg[r.folder] = (projectAgg[r.folder] || 0) + r.totalCost;
    sessionCosts.push({
      id: r.id, source: r.source, name: r.name, folder: r.folder,
      model: r.byModel[0]?.model || null,
      cost: r.totalCost, messages: r.msgs || 0, lastUpdatedAt: r.last_updated_at || r.created_at,
    });
  }
  const byEditor = Object.entries(editorAgg).map(([editor, d]) => ({ editor, cost: d.cost, models: d.models.size })).sort((a, b) => b.cost - a.cost);
  const byProject = Object.entries(projectAgg).map(([folder, cost]) => ({ folder, name: folder.split('/').pop(), cost })).sort((a, b) => b.cost - a.cost).slice(0, 20);
  const monthly = Object.entries(monthCosts).sort((a, b) => a[0].localeCompare(b[0])).map(([month, d]) => ({ month, cost: Math.round(d.cost * 100) / 100, sessions: d.sessions }));
  sessionCosts.sort((a, b) => b.cost - a.cost);

  const totalSessions = sessionCosts.length;
  const avgPerSession = totalSessions > 0 ? overall.totalCost / totalSessions : 0;
  const totalDays = monthly.length > 0 ? (() => {
    const first = new Date(monthly[0].month + '-01');
    const last = new Date(monthly[monthly.length - 1].month + '-01');
    return Math.max(1, Math.ceil((last - first) / 86400000) + 30);
  })() : 1;
  const avgPerDay = overall.totalCost / totalDays;

  return {
    totalCost: overall.totalCost, byModel: overall.byModel, unknownModels: overall.unknownModels,
    byEditor, byProject, monthly, topSessions: sessionCosts.slice(0, 50),
    summary: { totalSessions, avgPerSession: Math.round(avgPerSession * 100) / 100, avgPerDay: Math.round(avgPerDay * 100) / 100, totalDays },
  };
}

// ── raw SQL / schema (for the SqlViewer + /api/query, /api/schema) ───────────────
async function rawQuery(sql) {
  const rows = await q(sql);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows, count: rows.length };
}

async function schema() {
  const tbls = await q(`SELECT name FROM system.tables WHERE database = currentDatabase() AND name IN {t:Array(String)} ORDER BY name`, { t: DATA_TABLES });
  const out = {};
  for (const { name } of tbls) {
    out[name] = await q(`SELECT name, type FROM system.columns WHERE database = currentDatabase() AND table = {tbl:String} ORDER BY position`, { tbl: name });
  }
  return { tables: tbls.map(t => t.name), schema: out };
}

// Tool-call rows joined to chat name (for /api/mcps).
async function getAllToolCallRows() {
  return q(`
    SELECT tc.tool_name AS tool_name, tc.source AS source, tc.chat_id AS chat_id, tc.folder AS folder,
           tc.timestamp AS timestamp, c.name AS chat_name
    FROM tool_calls AS tc JOIN chats AS c ON tc.chat_id = c.id
    ORDER BY tc.timestamp DESC`);
}

// ── GSD ─────────────────────────────────────────────────────────────────────────
async function getCachedGSDProjects() {
  const projects = await q('SELECT * FROM gsd_projects ORDER BY last_modified DESC');
  for (const p of projects) {
    try { p.total_cost = (await getGSDPhaseTokens(p.folder)).reduce((s, r) => s + (r.cost || 0), 0); }
    catch { p.total_cost = 0; }
  }
  return projects;
}

async function getCachedGSDPhases(folder) {
  return q('SELECT * FROM gsd_phases WHERE folder = {folder:String} ORDER BY phase_number ASC', { folder });
}

async function getGSDPhaseTokens(folder) {
  const phases = await q('SELECT id, phase_number, phase_name, status, last_modified FROM gsd_phases WHERE folder = {folder:String} ORDER BY phase_number ASC', { folder });
  if (phases.length === 0) return [];

  const byTime = [...phases].filter(p => p.last_modified).sort((a, b) => a.last_modified - b.last_modified);
  const windowMap = new Map();
  for (let i = 0; i < byTime.length; i++) {
    const start = i === 0 ? 0 : byTime[i - 1].last_modified;
    const end = i === byTime.length - 1 ? Date.now() : byTime[i].last_modified;
    windowMap.set(byTime[i].id, { start, end });
  }

  const out = [];
  for (const ph of phases) {
    const win = windowMap.get(ph.id);
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, sessionCount = 0;
    const modelFreq = {};
    if (win) {
      const rows = await q(`
        SELECT cs.total_input_tokens AS ti, cs.total_output_tokens AS to_, cs.total_cache_read AS cr, cs.total_cache_write AS cw, cs.models AS models
        FROM chats AS c JOIN chat_stats AS cs ON cs.chat_id = c.id
        WHERE c.folder = {folder:String} AND COALESCE(c.last_updated_at, c.created_at) BETWEEN {start:Int64} AND {end:Int64}`,
        { folder, start: win.start, end: win.end });
      for (const row of rows) {
        totalInput += row.ti || 0; totalOutput += row.to_ || 0; totalCacheRead += row.cr || 0; totalCacheWrite += row.cw || 0; sessionCount++;
        try { for (const m of JSON.parse(row.models || '[]')) { const key = typeof m === 'string' ? m : (m && m.model); if (key) modelFreq[key] = (modelFreq[key] || 0) + 1; } } catch { /* skip */ }
      }
    }
    const dominantModel = Object.entries(modelFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const cost = dominantModel ? (calculateCost(dominantModel, totalInput, totalOutput, totalCacheRead, totalCacheWrite) || 0) : 0;
    out.push({
      id: ph.id, phase_number: ph.phase_number, phase_name: ph.phase_name, status: ph.status,
      total_tokens: totalInput + totalOutput, cost, session_count: sessionCount,
    });
  }
  return out;
}

async function getCachedGSDOverview() {
  const projects = await getCachedGSDProjects();
  const totalProjects = projects.length;
  const totalPhases = projects.reduce((s, p) => s + p.total_phases, 0);
  const completedPhases = projects.reduce((s, p) => s + p.completed_phases, 0);
  const activePhases = projects.filter(p => p.active_phase).map(p => ({ folder: p.folder, name: p.name, activePhase: p.active_phase }));
  const executingPhases = Number((await q1("SELECT count() AS c FROM gsd_phases WHERE status = {s:String}", { s: 'executing' })).c);
  const plannedPhases = Number((await q1("SELECT count() AS c FROM gsd_phases WHERE status = {s:String}", { s: 'planned' })).c);
  return { totalProjects, totalPhases, completedPhases, activePhases, executingPhases, plannedPhases };
}

module.exports = {
  initDb, scanAll, scanAllAsync, resetAndRescanAsync, clearAll, cacheGSDProjects,
  getCachedChats, countCachedChats, getCachedOverview, getCachedDailyActivity,
  getCachedDeepAnalytics, getCachedChat, getCachedProjects, getCachedToolCalls,
  getCachedDashboardStats, getCostBreakdown, getCostAnalytics,
  rawQuery, schema, getAllToolCallRows,
  getCachedGSDProjects, getCachedGSDPhases, getCachedGSDOverview, getGSDPhaseTokens,
};
