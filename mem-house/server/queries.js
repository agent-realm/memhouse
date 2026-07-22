// queries.js — mem-house read/query layer.
//
// Serves the SAME response shapes as the root cache.js (the agentlytics API
// contract) but computed over the mem-house typed schema (sessions, messages,
// tool_calls + sessions_v view; see ../schema.sql). The dashboard SPA consumes
// these shapes unchanged.
//
// Schema mapping notes (root cache schema → mem-house):
//   chats            → sessions / sessions_v   (id → session_id, bubble_count → total_msgs)
//   chat_stats       → sessions_v aggregates   (token/char sums, models array)
//   messages.content → messages.text           (cache_read → cache_read_tokens, …)
//   tool_calls       → tool_calls              (args_json → args, chat_id → session_id)
//   epoch-ms columns → DateTime64(3,'UTC')     (converted with toUnixTimestamp64Milli)
//
// All reads run with the `final: 1` setting so ReplacingMergeTree collapses
// duplicate versions at read time (see DESIGN.md data-plane rules).

const { createClient } = require('@clickhouse/client');
const { calculateCost, normalizeModelName } = require('../../pricing');

const config = {
  url: process.env.MEMHOUSE_URL || 'http://localhost:8123',
  username: process.env.MEMHOUSE_USER || 'memhouse_root',
  password: process.env.MEMHOUSE_PASSWORD || '',
  database: process.env.MEMHOUSE_DB || 'memhouse',
};

let _client = null;
function getClient() {
  if (_client) return _client;
  _client = createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    request_timeout: 60000,
    clickhouse_settings: {
      final: 1,
      output_format_json_quote_64bit_integers: 0,
    },
  });
  return _client;
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

async function q(query, params = {}) {
  const rs = await getClient().query({ query, query_params: params, format: 'JSONEachRow' });
  return rs.json();
}
async function q1(query, params = {}) { return (await q(query, params))[0]; }
function safeParseJson(s) { try { return JSON.parse(s); } catch { return {}; } }

// Session timestamp: prefer adapter's last_updated_at, then created_at, then the
// message-derived start (always present in sessions_v). All UTC DateTime64(3).
const TS = "COALESCE(c.last_updated_at, c.created_at, c.started)";
const MS = `toUnixTimestamp64Milli(${TS})`;
const EXCLUDED_MODELS = "('', '<synthetic>')";

// ── shared filter builder (named params) — mirrors root cache.js filters() ──────
// Applies over sessions_v aliased `c`. editorLike/folderLike toggle LIKE-substring
// vs exact equality, matching each root getter's behavior.
function filters(opts, { editorLike = false, folderLike = false } = {}) {
  const parts = [];
  const params = {};
  if (opts.hiddenFolders && opts.hiddenFolders.length) {
    parts.push('c.folder NOT IN {hidden:Array(String)}');
    params.hidden = opts.hiddenFolders;
  }
  if (opts.editor) {
    if (editorLike) { parts.push('c.source LIKE {editor:String}'); params.editor = `%${opts.editor}%`; }
    else { parts.push('c.source = {editor:String}'); params.editor = opts.editor; }
  }
  if (opts.folder) {
    if (folderLike) { parts.push('c.folder LIKE {folder:String}'); params.folder = `%${opts.folder}%`; }
    else { parts.push('c.folder = {folder:String}'); params.folder = opts.folder; }
  }
  if (opts.chatId) { parts.push('c.session_id = {chatId:String}'); params.chatId = opts.chatId; }
  if (opts.dateFrom != null) { parts.push(`${MS} >= {dateFrom:Int64}`); params.dateFrom = opts.dateFrom; }
  if (opts.dateTo != null) { parts.push(`${MS} <= {dateTo:Int64}`); params.dateTo = opts.dateTo; }
  return {
    and: parts.length ? ' AND ' + parts.join(' AND ') : '',
    where: parts.length ? ' WHERE ' + parts.join(' AND ') : '',
    params,
  };
}

// Restrict a messages/tool_calls query to the filtered session set. Empty filter →
// no restriction (avoids a pointless subquery).
function inSessions(f, col) {
  if (!f.and) return '';
  return ` AND ${col} IN (SELECT session_id FROM sessions_v AS c WHERE 1=1${f.and})`;
}

// Fold a [{name|model, cnt}] list through normalizeModelName into a freq map.
function normalizedModelFreq(rows) {
  const freq = {};
  for (const r of rows) {
    const k = normalizeModelName(r.model) || r.model;
    freq[k] = (freq[k] || 0) + Number(r.cnt);
  }
  return freq;
}
const topN = (freq, n) => Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([name, count]) => ({ name, count }));

// ── overview ────────────────────────────────────────────────────────────────────
async function getOverview(opts = {}) {
  const f = filters(opts);
  const totalChats = Number((await q1(`SELECT count() AS cnt FROM sessions_v AS c WHERE 1=1${f.and}`, f.params)).cnt);

  // Root parity: without a folder filter the editor breakdown is global.
  const editors = opts.folder
    ? await q(`SELECT source, count() AS count FROM sessions_v AS c WHERE 1=1${f.and} GROUP BY source ORDER BY count DESC`, f.params)
    : await q('SELECT source, count() AS count FROM sessions_v GROUP BY source ORDER BY count DESC');

  const modes = await q(`SELECT mode, count() AS count FROM sessions_v AS c WHERE mode != ''${f.and} GROUP BY mode`, f.params);
  const byMode = {};
  for (const m of modes) byMode[m.mode] = Number(m.count);

  const rows = await q(`
    SELECT formatDateTime(${TS}, '%Y-%m', 'UTC') AS month, source, count() AS count
    FROM sessions_v AS c WHERE 1=1${f.and}
    GROUP BY month, source ORDER BY month`, f.params);
  const monthMap = {};
  for (const r of rows) {
    if (!monthMap[r.month]) monthMap[r.month] = { count: 0, editors: {} };
    monthMap[r.month].count += Number(r.count);
    monthMap[r.month].editors[r.source] = Number(r.count);
  }
  const byMonth = Object.keys(monthMap).sort().map(m => ({ month: m, ...monthMap[m] }));

  const projects = await q(`
    SELECT folder, count() AS count FROM sessions_v AS c
    WHERE folder != ''${f.and} GROUP BY folder ORDER BY count DESC LIMIT 20`, f.params);
  const topProjects = projects.map(p => ({
    name: p.folder.split(/[/\\]/).slice(-2).join('/'),
    fullPath: p.folder,
    count: Number(p.count),
  }));

  const range = await q1(`SELECT min(${MS}) AS oldest, max(${MS}) AS newest FROM sessions_v AS c WHERE 1=1${f.and}`, f.params);

  return {
    totalChats,
    editors: editors.map(e => ({ id: e.source, count: Number(e.count) })),
    byMode, byMonth, topProjects,
    oldestChat: range ? range.oldest : null,
    newestChat: range ? range.newest : null,
  };
}

// ── daily activity ──────────────────────────────────────────────────────────────
async function getDailyActivity(opts = {}) {
  const f = filters(opts);
  const params = { ...f.params, tz: TZ };
  const rows = await q(`
    SELECT formatDateTime(${TS}, '%Y-%m-%d', {tz:String}) AS day,
           source,
           toHour(${TS}, {tz:String}) AS hour,
           count() AS count
    FROM sessions_v AS c WHERE 1=1${f.and}
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

// ── dashboard stats ─────────────────────────────────────────────────────────────
async function getDashboardStats(opts = {}) {
  const f = filters(opts);
  const p = { ...f.params, tz: TZ };

  const hourlyRows = await q(`
    SELECT toHour(${TS}, {tz:String}) AS hour, count() AS count
    FROM sessions_v AS c WHERE 1=1${f.and} GROUP BY hour ORDER BY hour`, p);
  const hourly = new Array(24).fill(0);
  for (const r of hourlyRows) hourly[Number(r.hour)] = Number(r.count);

  const weekdayRows = await q(`
    SELECT toDayOfWeek(${TS}, 0, {tz:String}) % 7 AS dow, count() AS count
    FROM sessions_v AS c WHERE 1=1${f.and} GROUP BY dow ORDER BY dow`, p);
  const weekdays = new Array(7).fill(0);
  for (const r of weekdayRows) weekdays[Number(r.dow)] = Number(r.count);

  const depthRows = await q(`
    SELECT total_msgs AS msgs FROM sessions_v AS c WHERE total_msgs > 0${f.and}`, f.params);
  const depthBuckets = { '1': 0, '2-5': 0, '6-10': 0, '11-20': 0, '21-50': 0, '51-100': 0, '100+': 0 };
  for (const r of depthRows) {
    const m = Number(r.msgs);
    if (m <= 1) depthBuckets['1']++;
    else if (m <= 5) depthBuckets['2-5']++;
    else if (m <= 10) depthBuckets['6-10']++;
    else if (m <= 20) depthBuckets['11-20']++;
    else if (m <= 50) depthBuckets['21-50']++;
    else if (m <= 100) depthBuckets['51-100']++;
    else depthBuckets['100+']++;
  }

  const tokenRow = await q1(`
    SELECT COALESCE(sum(input_tokens), 0) AS input, COALESCE(sum(output_tokens), 0) AS output,
           COALESCE(sum(cache_read_tokens), 0) AS cacheRead, COALESCE(sum(cache_write_tokens), 0) AS cacheWrite,
           COALESCE(sum(user_chars), 0) AS userChars, COALESCE(sum(assistant_chars), 0) AS assistantChars,
           count() AS sessions
    FROM sessions_v AS c WHERE 1=1${f.and}`, f.params);

  const streakRows = await q(`
    SELECT DISTINCT formatDateTime(${TS}, '%Y-%m-%d', {tz:String}) AS day
    FROM sessions_v AS c WHERE 1=1${f.and} ORDER BY day`, p);
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
  if (streakRows.length === 0) longestStreak = 0;

  const monthEditorRows = await q(`
    SELECT formatDateTime(${TS}, '%Y-%m', 'UTC') AS month, source, count() AS count
    FROM sessions_v AS c WHERE 1=1${f.and} GROUP BY month, source ORDER BY month`, f.params);
  const monthEditors = {};
  const allSources = new Set();
  for (const r of monthEditorRows) {
    if (!monthEditors[r.month]) monthEditors[r.month] = {};
    monthEditors[r.month][r.source] = Number(r.count);
    allSources.add(r.source);
  }

  const velocityRows = await q(`
    SELECT formatDateTime(c.last_updated_at, '%Y-%m', 'UTC') AS month,
           avg(total_msgs) AS avgMsgs, avg(input_tokens + output_tokens) AS avgTokens
    FROM sessions_v AS c WHERE c.last_updated_at IS NOT NULL${f.and}
    GROUP BY month ORDER BY month`, f.params);

  const modelRows = await q(`
    SELECT m.model AS model, count() AS cnt FROM messages AS m
    WHERE m.model NOT IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}
    GROUP BY model`, f.params);
  const topModels = topN(normalizedModelFreq(modelRows), 10);

  const toolRows = await q(`
    SELECT tool_name, count() AS cnt FROM tool_calls AS tc
    WHERE 1=1${inSessions(f, 'tc.session_id')} GROUP BY tool_name`, f.params);
  let totalToolCalls = 0;
  const toolFreq = {};
  for (const r of toolRows) { toolFreq[r.tool_name] = Number(r.cnt); totalToolCalls += Number(r.cnt); }
  const topTools = topN(toolFreq, 8);

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
    topModels, topTools, totalToolCalls,
  };
}

// ── chats list ──────────────────────────────────────────────────────────────────
async function countChats(opts = {}) {
  const f = filters(opts, { editorLike: true, folderLike: true });
  let sql = `SELECT count() AS cnt FROM sessions_v AS c WHERE 1=1${f.and}`;
  if (opts.named !== false) sql += " AND (c.name != '' OR c.total_msgs > 0)";
  return Number((await q1(sql, f.params)).cnt);
}

async function getChats(opts = {}) {
  const f = filters(opts, { editorLike: true, folderLike: true });
  let sql = `
    SELECT c.session_id AS id, c.source AS source, c.name AS name, c.mode AS mode, c.folder AS folder,
           toUnixTimestamp64Milli(c.created_at) AS created_at,
           toUnixTimestamp64Milli(c.last_updated_at) AS last_updated_at,
           c.total_msgs AS bubble_count,
           c.input_tokens AS _inTok, c.output_tokens AS _outTok,
           c.cache_read_tokens AS _cacheR, c.cache_write_tokens AS _cacheW,
           c.user_chars AS _uChars, c.assistant_chars AS _aChars
    FROM sessions_v AS c WHERE 1=1${f.and}`;
  const params = { ...f.params };
  if (opts.named !== false) sql += " AND (c.name != '' OR c.total_msgs > 0)";
  sql += ` ORDER BY ${MS} DESC`;
  if (opts.limit) { sql += ' LIMIT {limit:UInt64}'; params.limit = opts.limit; }
  if (opts.offset) { sql += ' OFFSET {offset:UInt64}'; params.offset = opts.offset; }
  const rows = await q(sql, params);
  if (rows.length === 0) return [];

  // Top model per session = most frequent model across the session's messages.
  const ids = rows.map(r => r.id);
  const tmRows = await q(`
    SELECT session_id, argMax(model, cnt) AS top_model
    FROM (SELECT session_id, model, count() AS cnt FROM messages
          WHERE session_id IN {ids:Array(String)} AND model NOT IN ${EXCLUDED_MODELS}
          GROUP BY session_id, model)
    GROUP BY session_id`, { ids });
  const topModelBySession = {};
  for (const r of tmRows) topModelBySession[r.session_id] = r.top_model;

  return rows.map(r => {
    const topModel = topModelBySession[r.id] || null;
    let inTok = Number(r._inTok) || 0, outTok = Number(r._outTok) || 0;
    if (inTok === 0 && outTok === 0 && ((r._uChars || 0) > 0 || (r._aChars || 0) > 0)) {
      inTok = Math.round((r._uChars || 0) / 4);
      outTok = Math.round((r._aChars || 0) / 4);
    }
    const cost = topModel ? (calculateCost(topModel, inTok, outTok, Number(r._cacheR) || 0, Number(r._cacheW) || 0) || 0) : 0;
    return {
      id: r.id, source: r.source, name: r.name, mode: r.mode, folder: r.folder,
      createdAt: r.created_at, lastUpdatedAt: r.last_updated_at,
      encrypted: false, bubbleCount: Number(r.bubble_count), topModel, cost,
    };
  });
}

// ── single chat ─────────────────────────────────────────────────────────────────
async function getChat(id) {
  const chat = await q1(`
    SELECT c.session_id AS id, c.user_id AS user_id, c.source AS source, c.name AS name, c.mode AS mode, c.folder AS folder,
           toUnixTimestamp64Milli(c.created_at) AS created_at,
           toUnixTimestamp64Milli(c.last_updated_at) AS last_updated_at,
           c.total_msgs AS total_msgs, c.user_msgs AS user_msgs, c.assistant_msgs AS assistant_msgs,
           c.user_chars AS user_chars, c.assistant_chars AS assistant_chars,
           c.input_tokens AS input_tokens, c.output_tokens AS output_tokens,
           c.cache_read_tokens AS cache_read_tokens, c.cache_write_tokens AS cache_write_tokens
    FROM sessions_v AS c WHERE session_id LIKE {idp:String} LIMIT 1`, { idp: id + '%' });
  if (!chat) return null;

  // Sessions are keyed (session_id, user_id): constrain the row reloads to the
  // selected rollup's writer, or an owner/no-RLS reader viewing a house where two
  // members share an adapter-local session_id would see their rows merged.
  const messages = await q(`
    SELECT role, text AS content, model, input_tokens, output_tokens
    FROM messages WHERE session_id = {cid:String} AND user_id = {uid:String} ORDER BY seq`,
    { cid: chat.id, uid: chat.user_id });

  const toolCalls = await q(`
    SELECT tool_name, args FROM tool_calls WHERE session_id = {cid:String} AND user_id = {uid:String} ORDER BY idx`,
    { cid: chat.id, uid: chat.user_id });
  const toolCallDetails = toolCalls.map(tc => ({ name: tc.tool_name, args: safeParseJson(tc.args) }));

  let toolMessages = 0, systemMessages = 0;
  const models = [];
  for (const m of messages) {
    if (m.role === 'tool') toolMessages++;
    else if (m.role === 'system') systemMessages++;
    if (m.model && m.model !== '<synthetic>') models.push(m.model);
  }

  const stats = {
    totalMessages: Number(chat.total_msgs), userMessages: Number(chat.user_msgs),
    assistantMessages: Number(chat.assistant_msgs), toolMessages, systemMessages,
    toolCalls: toolCalls.map(tc => tc.tool_name), models,
    totalUserChars: Number(chat.user_chars), totalAssistantChars: Number(chat.assistant_chars),
    totalInputTokens: Number(chat.input_tokens), totalOutputTokens: Number(chat.output_tokens),
    totalCacheRead: Number(chat.cache_read_tokens), totalCacheWrite: Number(chat.cache_write_tokens),
  };

  return {
    id: chat.id, source: chat.source, name: chat.name, mode: chat.mode, folder: chat.folder,
    createdAt: chat.created_at, lastUpdatedAt: chat.last_updated_at, encrypted: false,
    messages: messages.map(m => ({
      role: m.role, content: m.content, model: m.model || null,
      inputTokens: Number(m.input_tokens) || 0, outputTokens: Number(m.output_tokens) || 0,
    })),
    stats, toolCallDetails,
  };
}

// ── projects ────────────────────────────────────────────────────────────────────
async function getProjects(opts = {}) {
  const df = filters({
    hiddenFolders: opts.includeHidden ? [] : opts.hiddenFolders,
    dateFrom: opts.dateFrom, dateTo: opts.dateTo,
  });

  const perSource = await q(`
    SELECT folder, source, count() AS count, min(${MS}) AS first_seen, max(${MS}) AS last_seen
    FROM sessions_v AS c WHERE folder != ''${df.and}
    GROUP BY folder, source ORDER BY folder, count DESC`, df.params);

  const map = {};
  for (const r of perSource) {
    if (!map[r.folder]) map[r.folder] = { folder: r.folder, totalSessions: 0, editors: {}, firstSeen: r.first_seen, lastSeen: r.last_seen };
    map[r.folder].totalSessions += Number(r.count);
    map[r.folder].editors[r.source] = Number(r.count);
    if (r.first_seen != null && r.first_seen < map[r.folder].firstSeen) map[r.folder].firstSeen = r.first_seen;
    if (r.last_seen != null && r.last_seen > map[r.folder].lastSeen) map[r.folder].lastSeen = r.last_seen;
  }

  const sums = await q(`
    SELECT folder, sum(total_msgs) AS totalMessages,
           sum(input_tokens) AS totalInputTokens, sum(output_tokens) AS totalOutputTokens,
           sum(user_chars) AS totalUserChars, sum(assistant_chars) AS totalAssistantChars,
           sum(cache_read_tokens) AS totalCacheRead, sum(cache_write_tokens) AS totalCacheWrite
    FROM sessions_v AS c WHERE folder != ''${df.and} GROUP BY folder`, df.params);
  const sumByFolder = {};
  for (const r of sums) sumByFolder[r.folder] = r;

  const modelRows = await q(`
    SELECT m.folder AS folder, m.model AS model, count() AS cnt FROM messages AS m
    WHERE m.folder != '' AND m.model NOT IN ${EXCLUDED_MODELS}${inSessions(df, 'm.session_id')}
    GROUP BY folder, model`, df.params);
  const modelsByFolder = {};
  for (const r of modelRows) {
    const k = normalizeModelName(r.model) || r.model;
    if (!modelsByFolder[r.folder]) modelsByFolder[r.folder] = {};
    modelsByFolder[r.folder][k] = (modelsByFolder[r.folder][k] || 0) + Number(r.cnt);
  }

  const toolRows = await q(`
    SELECT tc.folder AS folder, tc.tool_name AS tool_name, count() AS cnt FROM tool_calls AS tc
    WHERE tc.folder != ''${inSessions(df, 'tc.session_id')} GROUP BY folder, tool_name`, df.params);
  const toolsByFolder = {};
  for (const r of toolRows) {
    if (!toolsByFolder[r.folder]) toolsByFolder[r.folder] = {};
    toolsByFolder[r.folder][r.tool_name] = (toolsByFolder[r.folder][r.tool_name] || 0) + Number(r.cnt);
  }

  const result = [];
  for (const [folder, proj] of Object.entries(map)) {
    const s = sumByFolder[folder] || {};
    let totalInputTokens = Number(s.totalInputTokens) || 0;
    let totalOutputTokens = Number(s.totalOutputTokens) || 0;
    const totalUserChars = Number(s.totalUserChars) || 0;
    const totalAssistantChars = Number(s.totalAssistantChars) || 0;
    let tokensEstimated = false;
    if (totalInputTokens === 0 && totalOutputTokens === 0 && (totalUserChars > 0 || totalAssistantChars > 0)) {
      totalInputTokens = Math.round(totalUserChars / 4);
      totalOutputTokens = Math.round(totalAssistantChars / 4);
      tokensEstimated = true;
    }
    const toolFreq = toolsByFolder[folder] || {};
    const totalToolCalls = Object.values(toolFreq).reduce((a, b) => a + b, 0);
    result.push({
      folder, name: folder.split(/[/\\]/).pop(),
      totalSessions: proj.totalSessions, editors: proj.editors,
      firstSeen: proj.firstSeen, lastSeen: proj.lastSeen,
      totalMessages: Number(s.totalMessages) || 0,
      totalInputTokens, totalOutputTokens, tokensEstimated,
      totalUserChars, totalAssistantChars, totalToolCalls,
      totalCacheRead: Number(s.totalCacheRead) || 0, totalCacheWrite: Number(s.totalCacheWrite) || 0,
      topModels: topN(modelsByFolder[folder] || {}, 10),
      topTools: topN(toolFreq, 10),
    });
  }
  return result.sort((a, b) => b.totalSessions - a.totalSessions);
}

// ── deep analytics ──────────────────────────────────────────────────────────────
async function getDeepAnalytics(opts = {}) {
  const f = filters(opts, { editorLike: true });
  let sql = `
    SELECT c.session_id AS id, c.total_msgs AS msgs, c.user_chars AS uc, c.assistant_chars AS ac,
           c.input_tokens AS ti, c.output_tokens AS to_, c.cache_read_tokens AS cr, c.cache_write_tokens AS cw
    FROM sessions_v AS c WHERE 1=1${f.and} ORDER BY ${MS} DESC`;
  const params = { ...f.params };
  if (opts.limit) { sql += ' LIMIT {limit:UInt64}'; params.limit = opts.limit; }
  const rows = await q(sql, params);

  let totalMessages = 0, totalUserChars = 0, totalAssistantChars = 0;
  let totalInputTokens = 0, totalOutputTokens = 0, totalCacheRead = 0, totalCacheWrite = 0;
  for (const r of rows) {
    totalMessages += Number(r.msgs);
    totalUserChars += Number(r.uc);
    totalAssistantChars += Number(r.ac);
    totalInputTokens += Number(r.ti);
    totalOutputTokens += Number(r.to_);
    totalCacheRead += Number(r.cr);
    totalCacheWrite += Number(r.cw);
  }

  const ids = rows.map(r => r.id);
  let topTools = [], topModels = [], totalToolCalls = 0;
  if (ids.length > 0) {
    const toolRows = await q(`
      SELECT tool_name, count() AS cnt FROM tool_calls
      WHERE session_id IN {ids:Array(String)} GROUP BY tool_name`, { ids });
    const toolFreq = {};
    for (const r of toolRows) { toolFreq[r.tool_name] = Number(r.cnt); totalToolCalls += Number(r.cnt); }
    topTools = topN(toolFreq, 30);

    const modelRows = await q(`
      SELECT model, count() AS cnt FROM messages
      WHERE session_id IN {ids:Array(String)} AND model NOT IN ${EXCLUDED_MODELS} GROUP BY model`, { ids });
    topModels = topN(normalizedModelFreq(modelRows), 20);
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
    topTools, topModels,
  };
}

// ── tool calls ──────────────────────────────────────────────────────────────────
async function getToolCalls(toolName, opts = {}) {
  const limit = opts.limit || 200;
  let sql = `
    SELECT tc.tool_name AS tool_name, tc.args AS args, tc.source AS source, tc.folder AS folder,
           toUnixTimestamp64Milli(tc.ts) AS timestamp, s.name AS chat_name, tc.session_id AS chat_id
    FROM tool_calls AS tc INNER JOIN sessions AS s ON s.session_id = tc.session_id
    WHERE tc.tool_name = {name:String}`;
  const params = { name: toolName, limit };
  if (opts.folder) { sql += ' AND tc.folder = {folder:String}'; params.folder = opts.folder; }
  sql += ' ORDER BY tc.ts DESC LIMIT {limit:UInt64}';
  const rows = await q(sql, params);
  return rows.map(r => ({
    toolName: r.tool_name, args: safeParseJson(r.args), source: r.source, folder: r.folder,
    timestamp: r.timestamp, chatName: r.chat_name, chatId: r.chat_id,
  }));
}

// ── cost estimation ─────────────────────────────────────────────────────────────
// Messages with model '' or '<synthetic>' are "orphans": their tokens are
// attributed to the session's dominant model (root cache.js treats model IS NULL
// the same way; '' is the mem-house null and synthetic models have no pricing).
const ORPHAN_TOKENS = '(m.input_tokens > 0 OR m.output_tokens > 0 OR m.cache_read_tokens > 0 OR m.cache_write_tokens > 0)';

// session_id → dominant model (most frequent across the session's messages).
async function sessionDominantMap(f) {
  const rows = await q(`
    SELECT session_id, argMax(model, cnt) AS dominant
    FROM (SELECT m.session_id AS session_id, m.model AS model, count() AS cnt
          FROM messages AS m WHERE m.model NOT IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}
          GROUP BY session_id, model)
    GROUP BY session_id`, f.params);
  const map = {};
  for (const r of rows) map[r.session_id] = r.dominant;
  return map;
}

// source → dominant model + global dominant (for sessions with tokens but no model).
async function sourceDominantMap(f) {
  const rows = await q(`
    SELECT m.source AS source, m.model AS model, count() AS cnt
    FROM messages AS m WHERE m.model NOT IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}
    GROUP BY source, model`, f.params);
  const bySource = {}, globalFreq = {};
  for (const r of rows) {
    if (!bySource[r.source]) bySource[r.source] = {};
    bySource[r.source][r.model] = (bySource[r.source][r.model] || 0) + Number(r.cnt);
    globalFreq[r.model] = (globalFreq[r.model] || 0) + Number(r.cnt);
  }
  const sourceDominant = {};
  for (const [src, fr] of Object.entries(bySource)) sourceDominant[src] = Object.entries(fr).sort((a, b) => b[1] - a[1])[0]?.[0];
  const globalDominant = Object.entries(globalFreq).sort((a, b) => b[1] - a[1])[0]?.[0];
  return { sourceDominant, globalDominant };
}

const CHARS_PER_TOKEN = 4;

async function estimateCosts(opts = {}) {
  const f = filters(opts, { editorLike: true });

  const modelTokens = await q(`
    SELECT m.model AS model, sum(m.input_tokens) AS input, sum(m.output_tokens) AS output,
           sum(m.cache_read_tokens) AS cacheRead, sum(m.cache_write_tokens) AS cacheWrite
    FROM messages AS m
    WHERE m.model NOT IN ${EXCLUDED_MODELS} AND ${ORPHAN_TOKENS}${inSessions(f, 'm.session_id')}
    GROUP BY model`, f.params);

  const orphanRows = await q(`
    SELECT m.session_id AS session_id, sum(m.input_tokens) AS input, sum(m.output_tokens) AS output,
           sum(m.cache_read_tokens) AS cacheRead, sum(m.cache_write_tokens) AS cacheWrite
    FROM messages AS m
    WHERE m.model IN ${EXCLUDED_MODELS} AND ${ORPHAN_TOKENS}${inSessions(f, 'm.session_id')}
    GROUP BY session_id`, f.params);

  const dominantMap = await sessionDominantMap(f);

  const orphanByModel = {};
  const addOrphan = (dominant, input, output, cacheRead, cacheWrite) => {
    if (!orphanByModel[dominant]) orphanByModel[dominant] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    orphanByModel[dominant].input += Number(input) || 0;
    orphanByModel[dominant].output += Number(output) || 0;
    orphanByModel[dominant].cacheRead += Number(cacheRead) || 0;
    orphanByModel[dominant].cacheWrite += Number(cacheWrite) || 0;
  };
  for (const r of orphanRows) {
    const dominant = dominantMap[r.session_id];
    if (dominant) addOrphan(dominant, r.input, r.output, r.cacheRead, r.cacheWrite);
  }

  // Sessions that name models but report zero tokens → estimate from chars.
  const charRows = await q(`
    SELECT c.session_id AS session_id, c.user_chars AS userChars, c.assistant_chars AS asstChars
    FROM sessions_v AS c
    WHERE notEmpty(c.models) AND c.input_tokens = 0 AND c.output_tokens = 0
      AND (c.user_chars > 0 OR c.assistant_chars > 0)${f.and}`, f.params);
  for (const r of charRows) {
    const dominant = dominantMap[r.session_id];
    if (dominant) addOrphan(dominant, Math.round((Number(r.userChars) || 0) / CHARS_PER_TOKEN), Math.round((Number(r.asstChars) || 0) / CHARS_PER_TOKEN), 0, 0);
  }

  // Sessions with tokens but NO model at all → the source's dominant model.
  const unmodeledRows = await q(`
    SELECT c.source AS source, c.input_tokens AS input, c.output_tokens AS output,
           c.cache_read_tokens AS cacheRead, c.cache_write_tokens AS cacheWrite
    FROM sessions_v AS c
    WHERE empty(c.models) AND (c.input_tokens > 0 OR c.output_tokens > 0)${f.and}`, f.params);
  if (unmodeledRows.length > 0) {
    const { sourceDominant, globalDominant } = await sourceDominantMap(f);
    for (const r of unmodeledRows) {
      const dominant = sourceDominant[r.source] || globalDominant;
      if (dominant) addOrphan(dominant, r.input, r.output, r.cacheRead, r.cacheWrite);
    }
  }

  const tokenMap = {};
  const addTokens = (rawModel, input, output, cacheRead, cacheWrite) => {
    const key = normalizeModelName(rawModel) || rawModel;
    if (!tokenMap[key]) tokenMap[key] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    tokenMap[key].input += Number(input) || 0;
    tokenMap[key].output += Number(output) || 0;
    tokenMap[key].cacheRead += Number(cacheRead) || 0;
    tokenMap[key].cacheWrite += Number(cacheWrite) || 0;
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

// Per-session cost attribution in a FIXED number of bulk queries (no per-session
// round-trips). Mirrors root computePerChatCosts.
async function computePerChatCosts(f) {
  const aRows = await q(`
    SELECT m.session_id AS session_id, m.model AS model, sum(m.input_tokens) AS i, sum(m.output_tokens) AS o,
           sum(m.cache_read_tokens) AS cr, sum(m.cache_write_tokens) AS cw
    FROM messages AS m
    WHERE m.model NOT IN ${EXCLUDED_MODELS} AND ${ORPHAN_TOKENS}${inSessions(f, 'm.session_id')}
    GROUP BY session_id, model`, f.params);
  const byChatModel = {};
  for (const r of aRows) (byChatModel[r.session_id] = byChatModel[r.session_id] || []).push(r);

  const bRows = await q(`
    SELECT m.session_id AS session_id, sum(m.input_tokens) AS i, sum(m.output_tokens) AS o,
           sum(m.cache_read_tokens) AS cr, sum(m.cache_write_tokens) AS cw
    FROM messages AS m
    WHERE m.model IN ${EXCLUDED_MODELS} AND ${ORPHAN_TOKENS}${inSessions(f, 'm.session_id')}
    GROUP BY session_id`, f.params);
  const orphanByChat = {};
  for (const r of bRows) orphanByChat[r.session_id] = r;

  const cRows = await q(`
    SELECT c.session_id AS id, c.source AS source, c.name AS name, c.folder AS folder,
           toUnixTimestamp64Milli(c.last_updated_at) AS last_updated_at,
           toUnixTimestamp64Milli(c.created_at) AS created_at,
           c.total_msgs AS msgs, c.models AS models,
           c.user_chars AS uc, c.assistant_chars AS ac,
           c.input_tokens AS ti, c.output_tokens AS to_,
           c.cache_read_tokens AS cr, c.cache_write_tokens AS cw,
           formatDateTime(${TS}, '%Y-%m', 'UTC') AS month
    FROM sessions_v AS c WHERE 1=1${f.and}`, f.params);

  const dominantMap = await sessionDominantMap(f);
  const { sourceDominant, globalDominant } = await sourceDominantMap(f);

  const out = [];
  for (const c of cRows) {
    const hasModels = (c.models || []).length > 0;
    const dominant = dominantMap[c.id] || null;
    const tokenMap = {};
    const add = (rawModel, i, o, cr, cw) => {
      if (!rawModel) return;
      const key = normalizeModelName(rawModel) || rawModel;
      if (!tokenMap[key]) tokenMap[key] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      tokenMap[key].input += Number(i) || 0; tokenMap[key].output += Number(o) || 0;
      tokenMap[key].cacheRead += Number(cr) || 0; tokenMap[key].cacheWrite += Number(cw) || 0;
    };
    for (const r of (byChatModel[c.id] || [])) add(r.model, r.i, r.o, r.cr, r.cw);
    const orphan = orphanByChat[c.id];
    if (orphan && dominant) add(dominant, orphan.i, orphan.o, orphan.cr, orphan.cw);
    if (hasModels && Number(c.ti) === 0 && Number(c.to_) === 0 && (c.uc > 0 || c.ac > 0) && dominant)
      add(dominant, Math.round((Number(c.uc) || 0) / CHARS_PER_TOKEN), Math.round((Number(c.ac) || 0) / CHARS_PER_TOKEN), 0, 0);
    if (!hasModels && (Number(c.ti) > 0 || Number(c.to_) > 0)) {
      const srcDom = sourceDominant[c.source] || globalDominant;
      if (srcDom) add(srcDom, c.ti, c.to_, c.cr, c.cw);
    }
    let totalCost = 0; const byModel = [];
    for (const [model, tok] of Object.entries(tokenMap)) {
      const cost = calculateCost(model, tok.input, tok.output, tok.cacheRead, tok.cacheWrite);
      if (cost !== null) { totalCost += cost; byModel.push({ model, cost }); }
    }
    byModel.sort((a, b) => b.cost - a.cost);
    out.push({
      id: c.id, source: c.source, name: c.name, folder: c.folder,
      last_updated_at: c.last_updated_at, created_at: c.created_at,
      msgs: Number(c.msgs), month: c.month, totalCost, byModel,
    });
  }
  return out;
}

async function getCostAnalytics(opts = {}) {
  const f = filters(opts, { editorLike: true });
  const overall = await estimateCosts(opts);
  const perChat = await computePerChatCosts(f);

  const editorAgg = {}, projectAgg = {}, monthCosts = {};
  const sessionCosts = [];
  for (const r of perChat) {
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

// ── raw SQL / schema (SqlViewer) ────────────────────────────────────────────────
async function rawQuery(sql) {
  const rows = await q(sql);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows, count: rows.length };
}

async function schema() {
  const tbls = await q(`
    SELECT name FROM system.tables
    WHERE database = currentDatabase() AND NOT startsWith(name, '.') ORDER BY name`);
  const out = {};
  for (const { name } of tbls) {
    out[name] = await q(`
      SELECT name, type FROM system.columns
      WHERE database = currentDatabase() AND table = {tbl:String} ORDER BY position`, { tbl: name });
  }
  return { tables: tbls.map(t => t.name), schema: out };
}

module.exports = {
  getClient, config,
  getOverview, getDailyActivity, getDashboardStats,
  getChats, countChats, getChat,
  getProjects, getDeepAnalytics, getToolCalls,
  estimateCosts, getCostAnalytics,
  rawQuery, schema,
};
