// queries.js — memhouse read/query layer.
//
// Serves the SAME response shapes as the root cache.js (the agentlytics API
// contract) but computed over the memhouse typed schema — one set of rooms per member,
// `sessions_<m>` / `messages_<m>` / `tool_calls_<m>` (../per-member/schema-member.sql.tpl),
// plus the session rollup, which is a SAVED QUERY and not an object
// (../per-member/rooms.js). The dashboard SPA consumes these shapes unchanged.
//
// Schema mapping notes (root cache schema → memhouse):
//   chats            → sessions_<m> / the rollup  (id → session_id, bubble_count → total_msgs)
//   chat_stats       → rollup aggregates          (token/char sums, models array)
//   messages.content → messages_<m>.text          (cache_read → cache_read_tokens, …)
//   tool_calls       → tool_calls_<m>             (args_json → args, chat_id → session_id)
//   epoch-ms columns → DateTime64(3,'UTC')        (converted with toUnixTimestamp64Milli)
//
// All reads run with the `final: 1` setting so ReplacingMergeTree collapses
// duplicate versions at read time (see DESIGN.md data-plane rules).

const { createClient, ClickHouseLogLevel } = require('@clickhouse/client');
const { calculateCost, normalizeModelName } = require('../../pricing');
const { resolveRooms, READ_SETTINGS } = require('../house/house');

const config = {
  url: process.env.MEMHOUSE_URL || 'http://localhost:8123',
  username: process.env.MEMHOUSE_USER || 'memhouse_root',
  password: process.env.MEMHOUSE_PASSWORD || '',
  database: process.env.MEMHOUSE_DB || process.env.MEMHOUSE_USER, // house defaults to the user's own name
};

/**
 * The house may have moved under this process: the operator converts a pre-one-layout
 * house and the member's rooms go from `<name>.*` to `mem.<name>_*`, while this server
 * still holds the database its env named at boot. The shipper and `update` learned to
 * adopt that; the dashboard did not, so every endpoint answered 500 behind a page that
 * simply looked blank. Checked once at startup, cheap, and never fatal.
 *
 * @returns {Promise<'current'|'moved'|'unknown'>}
 */
async function adoptMovedHouse() {
  const me = config.username;
  if (!me || config.database === 'mem') return 'current';
  const probe = createClient({ ...clientOptions(), database: 'system' });
  try {
    const rs = await probe.query({
      query: `SELECT database, name FROM system.tables WHERE (database = {old:String} AND name IN ('messages', {mine:String})) OR (database = 'mem' AND name = {mine:String})`,
      query_params: { old: config.database, mine: `${me}_messages` },
      format: 'JSONEachRow',
    });
    const rows = await rs.json();
    const has = (d, n) => rows.some((r) => r.database === d && r.name === n);
    if (has(config.database, `${me}_messages`) || has(config.database, 'messages')) return 'current';
    if (!has('mem', `${me}_messages`)) return 'unknown';
    console.log(`[memhouse] rooms moved: ${config.database}.messages is now mem.${me}_messages — reading house 'mem'`);
    config.database = 'mem';
    _client = null; // rebuilt with the new database on the next call
    return 'moved';
  } catch { return 'unknown'; }
  finally { try { await probe.close(); } catch { /* nothing to close */ } }
}

let _client = null;
function clientOptions() {
  return {
    log: { level: process.env.MEMHOUSE_DEBUG ? ClickHouseLogLevel.DEBUG : ClickHouseLogLevel.OFF },
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    request_timeout: 60000,
    clickhouse_settings: { ...READ_SETTINGS, output_format_json_quote_64bit_integers: 0 },
  };
}
function getClient() {
  if (_client) return _client;
  // See the note in shipper/ship.js: the driver's ERROR-level dump lands ahead of every
  // message we print, so a handled refusal reads like a crash. MEMHOUSE_DEBUG=1 restores it.
  _client = createClient(clientOptions());
  return _client;
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// Room routing. Rooms are named for the member
// (`messages_alice`), so a read layer hardcoding `messages` either hits a permission
// error or, against a house provisioned for someone else, silently returns the wrong
// shared-layout data. Every query below names its rooms as `{{sessions_v}}` and friends,
// and this is the single place they are resolved.
//
// `{{name}}` cannot collide with ClickHouse's own `{name:Type}` parameter syntax: double
// braces, no type.
const ROOM_TOKEN = /\{\{([a-z_]+)\}\}/g;
let roomsPromise = null;

function rooms() {
  // Resolved once per process. resolveRooms asks the server for currentUser(), so it is a
  // round trip, and every dashboard request would otherwise pay for it.
  if (!roomsPromise) {
    roomsPromise = resolveRooms(getClient()).catch((e) => { roomsPromise = null; throw e; });
  }
  return roomsPromise;
}

function applyRooms(sql, r) {
  return sql.replace(ROOM_TOKEN, (_, name) => {
    const t = r[name];
    if (!t) throw new Error(`query names unknown room '${name}'`);
    return t;
  });
}

async function q(query, params = {}, settings = undefined) {
  const rs = await getClient().query({
    query: applyRooms(query, await rooms()), query_params: params, format: 'JSONEachRow',
    ...(settings ? { clickhouse_settings: settings } : {}),
  });
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
  if (opts.chatId) {
    // Accept the composite 'session_id::user_id' id form getChats emits.
    // Last-separator split: codebuff session ids legitimately contain '::'.
    const cut = String(opts.chatId).lastIndexOf('::');
    const sid = cut === -1 ? String(opts.chatId) : String(opts.chatId).slice(0, cut);
    const uid = cut === -1 ? undefined : String(opts.chatId).slice(cut + 2);
    parts.push('c.session_id = {chatId:String}'); params.chatId = sid;
    if (uid) { parts.push('c.user_id = {chatUid:String}'); params.chatUid = uid; }
  }
  if (opts.dateFrom != null) { parts.push(`${MS} >= {dateFrom:Int64}`); params.dateFrom = opts.dateFrom; }
  if (opts.dateTo != null) { parts.push(`${MS} <= {dateTo:Int64}`); params.dateTo = opts.dateTo; }
  return {
    and: parts.length ? ' AND ' + parts.join(' AND ') : '',
    where: parts.length ? ' WHERE ' + parts.join(' AND ') : '',
    params,
  };
}

// Restrict a messages/tool_calls query to the filtered session set. Empty filter →
// no restriction (avoids a pointless subquery). Matches the FULL (session_id,
// user_id) key: with session_id alone, an owner/no-RLS reader filtering by
// folder/date/editor would pull EVERY member's rows for a colliding adapter-local
// session_id into the filtered aggregate.
function inSessions(f, col) {
  if (!f.and) return '';
  const alias = col.split('.')[0];
  return ` AND (${alias}.session_id, ${alias}.user_id) IN (SELECT session_id, user_id FROM {{sessions_v}} AS c WHERE 1=1${f.and})`;
}

/**
 * Narrow a query to an explicit set of (session_id, user_id) pairs.
 *
 * Distinct from inSessions(), which restricts to whatever the USER filtered to. This
 * restricts to the rows a caller is actually going to use — the fifty sessions on the
 * page, not the twelve hundred in the house.
 *
 * arrayZip, not two INs: the rooms are keyed on the PAIR, and matching the columns
 * independently would pull in another member's rows for a colliding adapter-local
 * session_id. Same idiom getDeepAnalytics already uses.
 */
function scopeAnd(scope, alias) {
  if (!scope || !scope.ids || !scope.ids.length) return '';
  const a = alias ? `${alias}.` : '';
  return ` AND (${a}session_id, ${a}user_id) IN arrayZip({scopeIds:Array(String)}, {scopeUsers:Array(String)})`;
}

function scopeParams(f, scope) {
  if (!scope || !scope.ids || !scope.ids.length) return f.params;
  return { ...f.params, scopeIds: scope.ids, scopeUsers: scope.users };
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
// The same exclusions as EXCLUDED_MODELS, usable in JS.
const EXCLUDED_MODEL_SET = new Set(['', '<synthetic>']);
// Tiebreak on the name. A top-N cut over counts alone is not a total order: two tools
// tied at the cut line resolve by arrival order, so the same house can show a different
// tenth tool on consecutive loads. Same rule as getChats' ORDER BY tiebreaker.
const topN = (freq, n) => Object.entries(freq).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, n)
  .map(([name, count]) => ({ name, count }));

// ── overview ────────────────────────────────────────────────────────────────────
async function getOverview(opts = {}) {
  const f = filters(opts);
  // Six independent reads, issued together. They share nothing but the filter, and every
  // one of them is a full round trip: awaited in sequence they cost 6 x RTT before any
  // result exists. Measured against a ClickHouse 6,000 km away, that sequencing — not the
  // database — was roughly two thirds of what the browser waited for.
  //
  // The comments on each query below are the reasons its SHAPE is what it is; none of
  // them is a reason for it to wait on the one above.
  const [totalRow, editors, modes, rows, projects, range] = await Promise.all([
    // Same definition as getChats(). The nav bar read this and the Sessions page read
    // getChats, so a house with one placeholder session showed "9 sessions" beside
    // "8 sessions" in the same header, and the depth histogram summed to 7. A session row
    // with no name and no messages is a placeholder the shipper keeps to absorb the
    // incremental skip; it is not a conversation, and only one of the two counters knew.
    q1(`SELECT count() AS cnt FROM {{sessions_v}} AS c WHERE 1=1${f.and} AND (c.name != '' OR c.total_msgs > 0)`,
      f.params),
    // Root parity WAS: without a folder filter the editor breakdown is global — which put
    // "34 + 3" chips under a header reading "3 sessions" when an editor filter was applied,
    // and 12 under a header of 11 with no filter at all. Parity with a wrong number is not a
    // feature.
    q(`SELECT source, count() AS count FROM {{sessions_v}} AS c
       WHERE (c.name != '' OR c.total_msgs > 0)${f.and} GROUP BY source ORDER BY count DESC`, f.params),
    q(`SELECT mode, count() AS count FROM {{sessions_v}} AS c WHERE mode != ''${f.and} GROUP BY mode`, f.params),
    q(`
      SELECT formatDateTime(${TS}, '%Y-%m', 'UTC') AS month, source, count() AS count
      FROM {{sessions_v}} AS c WHERE 1=1${f.and}
      GROUP BY month, source ORDER BY month`, f.params),
    q(`
      SELECT folder, count() AS count FROM {{sessions_v}} AS c
      WHERE folder != ''${f.and} GROUP BY folder ORDER BY count DESC LIMIT 20`, f.params),
    q1(`SELECT min(${MS}) AS oldest, max(${MS}) AS newest FROM {{sessions_v}} AS c WHERE 1=1${f.and}`, f.params),
  ]);

  const totalChats = Number(totalRow.cnt);

  const byMode = {};
  for (const m of modes) byMode[m.mode] = Number(m.count);

  const monthMap = {};
  for (const r of rows) {
    if (!monthMap[r.month]) monthMap[r.month] = { count: 0, editors: {} };
    monthMap[r.month].count += Number(r.count);
    monthMap[r.month].editors[r.source] = Number(r.count);
  }
  const byMonth = Object.keys(monthMap).sort().map(m => ({ month: m, ...monthMap[m] }));

  const topProjects = projects.map(p => ({
    name: p.folder.split(/[/\\]/).slice(-2).join('/'),
    fullPath: p.folder,
    count: Number(p.count),
  }));

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
    FROM {{sessions_v}} AS c WHERE 1=1${f.and}
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
  const r = await rooms();

  // Nine independent reads, one round trip. Sequential, this endpoint paid 9 x RTT
  // before any result existed — the largest fan-out on the dashboard. Each query's
  // shape is unchanged; only the waiting is gone.
  const [hourlyRows, weekdayRows, depthRows, tokenRow, streakRows,
         monthEditorRows, velocityRows, modelRows, toolRows] = await Promise.all([
    q(`
    SELECT toHour(${TS}, {tz:String}) AS hour, count() AS count
    FROM {{sessions_v}} AS c WHERE 1=1${f.and} GROUP BY hour ORDER BY hour`, p),
    q(`
    SELECT toDayOfWeek(${TS}, 0, {tz:String}) % 7 AS dow, count() AS count
    FROM {{sessions_v}} AS c WHERE 1=1${f.and} GROUP BY dow ORDER BY dow`, p),
    q(`
    SELECT total_msgs AS msgs FROM {{sessions_v}} AS c WHERE total_msgs > 0${f.and}`, f.params),
    q1(`
    SELECT COALESCE(sum(input_tokens), 0) AS input, COALESCE(sum(output_tokens), 0) AS output,
           COALESCE(sum(cache_read_tokens), 0) AS cacheRead, COALESCE(sum(cache_write_tokens), 0) AS cacheWrite,
           COALESCE(sum(user_chars), 0) AS userChars, COALESCE(sum(assistant_chars), 0) AS assistantChars,
           COALESCE(sum(total_msgs), 0) AS messages,
           -- The SAME definition the KPI beside it uses. A plain count() here put a
           -- fourth session number on a screen that already had three: nav 11, chips 12,
           -- avg depth 40/12, histogram 10.
           countIf(c.name != '' OR c.total_msgs > 0) AS sessions
    FROM {{sessions_v}} AS c WHERE 1=1${f.and}`, f.params),
    q(`
    SELECT DISTINCT formatDateTime(${TS}, '%Y-%m-%d', {tz:String}) AS day
    FROM {{sessions_v}} AS c WHERE 1=1${f.and} ORDER BY day`, p),
    q(`
    SELECT formatDateTime(${TS}, '%Y-%m', 'UTC') AS month, source, count() AS count
    FROM {{sessions_v}} AS c WHERE 1=1${f.and} GROUP BY month, source ORDER BY month`, f.params),
    q(`
    SELECT formatDateTime(c.last_updated_at, '%Y-%m', 'UTC') AS month,
           avg(total_msgs) AS avgMsgs, avg(input_tokens + output_tokens) AS avgTokens
    FROM {{sessions_v}} AS c WHERE c.last_updated_at IS NOT NULL${f.and}
    GROUP BY month ORDER BY month`, f.params),
    q(r.model_stats ? `
    SELECT m.model AS model, sum(m.msgs) AS cnt FROM {{model_stats}} AS m
    WHERE m.model NOT IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}
    GROUP BY model` : `
    SELECT m.model AS model, count() AS cnt FROM {{messages}} AS m
    WHERE m.model NOT IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}
    GROUP BY model`, f.params),
    q(r.tool_stats ? `
    SELECT tool_name, sum(tc.calls) AS cnt FROM {{tool_stats}} AS tc
    WHERE 1=1${inSessions(f, 'tc.session_id')} GROUP BY tool_name` : `
    SELECT tool_name, count() AS cnt FROM {{tool_calls}} AS tc
    WHERE 1=1${inSessions(f, 'tc.session_id')} GROUP BY tool_name`, f.params),
  ]);

  const hourly = new Array(24).fill(0);
  for (const r of hourlyRows) hourly[Number(r.hour)] = Number(r.count);

  const weekdays = new Array(7).fill(0);
  for (const r of weekdayRows) weekdays[Number(r.dow)] = Number(r.count);

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

  const monthEditors = {};
  const allSources = new Set();
  for (const r of monthEditorRows) {
    if (!monthEditors[r.month]) monthEditors[r.month] = {};
    monthEditors[r.month][r.source] = Number(r.count);
    allSources.add(r.source);
  }

  const topModels = topN(normalizedModelFreq(modelRows), 10);

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
      sessions: Number(tokenRow.sessions), messages: Number(tokenRow.messages), estimated: tokensEstimated,
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
  let sql = `SELECT count() AS cnt FROM {{sessions_v}} AS c WHERE 1=1${f.and}`;
  if (opts.named !== false) sql += " AND (c.name != '' OR c.total_msgs > 0)";
  return Number((await q1(sql, f.params)).cnt);
}

async function getChats(opts = {}) {
  const f = filters(opts, { editorLike: true, folderLike: true });
  let sql = `
    SELECT c.session_id AS id, c.user_id AS user_id, c.source AS source, c.name AS name, c.mode AS mode, c.folder AS folder,
           toUnixTimestamp64Milli(c.created_at) AS created_at,
           toUnixTimestamp64Milli(c.last_updated_at) AS last_updated_at,
           c.total_msgs AS bubble_count,
           c.input_tokens AS _inTok, c.output_tokens AS _outTok,
           c.cache_read_tokens AS _cacheR, c.cache_write_tokens AS _cacheW,
           c.user_chars AS _uChars, c.assistant_chars AS _aChars
    FROM {{sessions_v}} AS c WHERE 1=1${f.and}`;
  const params = { ...f.params };
  if (opts.named !== false) sql += " AND (c.name != '' OR c.total_msgs > 0)";
  // Tiebreak on the session key. `ORDER BY <ts> DESC` alone is not a total order —
  // sessions that stopped in the same millisecond tie, and ClickHouse is free to return
  // ties in any order, INCLUDING A DIFFERENT ONE PER QUERY. With LIMIT/OFFSET on top,
  // that means page 2 can repeat or skip a row that page 1 already showed. Found by
  // diffing this endpoint's response between two equivalent sources: identical rows,
  // different order, 129 distinct timestamps across 300 sessions.
  sql += ` ORDER BY ${MS} DESC, c.session_id, c.user_id`;
  if (opts.limit) { sql += ' LIMIT {limit:UInt64}'; params.limit = opts.limit; }
  if (opts.offset) { sql += ' OFFSET {offset:UInt64}'; params.offset = opts.offset; }
  const rows = await q(sql, params);
  if (rows.length === 0) return [];

  // ONE cost implementation, shared with the Costs page.
  //
  // getChats used to compute its own, and the two disagreed three times running: first the
  // whole session priced at its dominant model ($10.02 against $150), then sessions whose
  // rows carry no model at all ($0 against $10.50), then sessions with zero tokens but
  // non-zero chars ($0 against $0.033). Each round fixed the case that had been measured
  // and left the next one. computePerChatCosts already handles all of them — the orphan
  // bucket, the source-dominant and global-dominant fallbacks, the char estimate — so call
  // it instead of growing a second copy of the same logic.
  // Price the fifty rows on the page, not the twelve hundred in the house. This query
  // set was the most expensive thing the dashboard ran — 1,413,624 rows read and 272 MiB
  // per call, three endpoints calling it — and getChats used ~4% of what it asked for.
  const perChat = await computePerChatCosts(f, {
    ids: rows.map((r) => String(r.id)),
    users: rows.map((r) => String(r.user_id)),
  });
  const costBySession = {};
  const topModelBySession = {};
  for (const r of perChat) {
    // computePerChatCosts already emits the composite key as `id`.
    const k = r.id;
    costBySession[k] = { total: r.totalCost, unpriced: !!r.hasUnpriced };
    if (r.byModel[0]) topModelBySession[k] = r.byModel[0].model;
  }

  return rows.map(r => {
    const k = `${r.id}::${r.user_id}`;
    const topModel = topModelBySession[k] || null;
    const summed = costBySession[k];
    const cost = summed ? summed.total : 0;
    return {
      // Composite API id: rollups are keyed (session_id, user_id), so the id a
      // client clicks must pin BOTH — otherwise opening one of two colliding
      // rows shows an arbitrary member's transcript. '::' never occurs in
      // session ids; getChat() splits it and plain ids still work.
      id: `${r.id}::${r.user_id}`, user: r.user_id,
      source: r.source, name: r.name, mode: r.mode, folder: r.folder,
      createdAt: r.created_at, lastUpdatedAt: r.last_updated_at,
      encrypted: false, bubbleCount: Number(r.bubble_count), topModel, cost,
      // Surfaced, not just computed. A session containing an unpriced model reports a cost
      // that silently omits part of itself; the caller can now say so.
      costPartial: !!(summed && summed.unpriced),
    };
  });
}

// ── single chat ─────────────────────────────────────────────────────────────────
async function getChat(id) {
  // Accept both id forms: composite 'session_id::user_id' (what getChats emits —
  // deterministic when members share a session_id) and a plain full session_id
  // (manual/legacy use). Split on the LAST '::' — some adapters (codebuff) build
  // session ids as '<project>::<chatId>', so the first separator can be inside
  // the sid. CH user names here are colon-free identifiers.
  // EQUALITY, not prefix LIKE: the UI passes complete ids, and a prefix match is
  // ambiguous when one id prefixes another ('1' vs '10'). Prefix search, if ever
  // needed, must be a separate deterministic operation.
  const cut = String(id).lastIndexOf('::');
  const sidPart = cut === -1 ? String(id) : String(id).slice(0, cut);
  const uidPart = cut === -1 ? undefined : String(id).slice(cut + 2);
  let sql = `
    SELECT c.session_id AS id, c.user_id AS user_id, c.source AS source, c.name AS name, c.mode AS mode, c.folder AS folder,
           toUnixTimestamp64Milli(c.created_at) AS created_at,
           toUnixTimestamp64Milli(c.last_updated_at) AS last_updated_at,
           c.total_msgs AS total_msgs, c.user_msgs AS user_msgs, c.assistant_msgs AS assistant_msgs,
           c.user_chars AS user_chars, c.assistant_chars AS assistant_chars,
           c.input_tokens AS input_tokens, c.output_tokens AS output_tokens,
           c.cache_read_tokens AS cache_read_tokens, c.cache_write_tokens AS cache_write_tokens
    FROM {{sessions_v}} AS c WHERE session_id = {sid:String}`;
  const params = { sid: sidPart };
  if (uidPart) { sql += ' AND user_id = {uid:String}'; params.uid = uidPart; }
  sql += ' LIMIT 1';
  let chat = await q1(sql, params);
  if (!chat && uidPart) {
    // A plain codebuff-style id ('<source>:<project>::<chatId>', no user suffix)
    // parses as sid::uid above. Retry treating the whole string as the sid.
    chat = await q1(sql.replace(' AND user_id = {uid:String}', ''), { sid: String(id) });
  }
  if (!chat) return null;

  // Sessions are keyed (session_id, user_id): constrain the row reloads to the
  // selected rollup's writer, or an owner/no-RLS reader viewing a house where two
  // members share an adapter-local session_id would see their rows merged.
  const [messages, toolCalls] = await Promise.all([
    q(`
    SELECT role, text AS content, model, input_tokens, output_tokens
    FROM {{messages}} WHERE session_id = {cid:String} AND user_id = {uid:String} ORDER BY seq`,
      { cid: chat.id, uid: chat.user_id }),
    q(`
    SELECT tool_name, args FROM {{tool_calls}} WHERE session_id = {cid:String} AND user_id = {uid:String} ORDER BY idx`,
      { cid: chat.id, uid: chat.user_id }),
  ]);
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
    // Echo the id form the caller used: composite stays composite so follow-up
    // URLs built from it (markdown download) stay pinned to the same writer.
    id: uidPart ? `${chat.id}::${chat.user_id}` : chat.id, user: chat.user_id,
    source: chat.source, name: chat.name, mode: chat.mode, folder: chat.folder,
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
  const r = await rooms();
  const df = filters({
    hiddenFolders: opts.includeHidden ? [] : opts.hiddenFolders,
    dateFrom: opts.dateFrom, dateTo: opts.dateTo,
  });

  // Four independent reads, one round trip.
  const [perSource, sums, modelRows, toolRows] = await Promise.all([
    q(`
    SELECT folder, source, count() AS count, min(${MS}) AS first_seen, max(${MS}) AS last_seen
    FROM {{sessions_v}} AS c WHERE folder != ''${df.and}
    GROUP BY folder, source ORDER BY folder, count DESC`, df.params),
    q(`
    SELECT folder, sum(total_msgs) AS totalMessages,
           sum(input_tokens) AS totalInputTokens, sum(output_tokens) AS totalOutputTokens,
           sum(user_chars) AS totalUserChars, sum(assistant_chars) AS totalAssistantChars,
           sum(cache_read_tokens) AS totalCacheRead, sum(cache_write_tokens) AS totalCacheWrite
    FROM {{sessions_v}} AS c WHERE folder != ''${df.and} GROUP BY folder`, df.params),
    q(r.model_stats ? `
    SELECT m.folder AS folder, m.model AS model, sum(m.msgs) AS cnt FROM {{model_stats}} AS m
    WHERE m.folder != '' AND m.model NOT IN ${EXCLUDED_MODELS}${inSessions(df, 'm.session_id')}
    GROUP BY folder, model` : `
    SELECT m.folder AS folder, m.model AS model, count() AS cnt FROM {{messages}} AS m
    WHERE m.folder != '' AND m.model NOT IN ${EXCLUDED_MODELS}${inSessions(df, 'm.session_id')}
    GROUP BY folder, model`, df.params),
    q(r.tool_stats ? `
    SELECT tc.folder AS folder, tc.tool_name AS tool_name, sum(tc.calls) AS cnt FROM {{tool_stats}} AS tc
    WHERE tc.folder != ''${inSessions(df, 'tc.session_id')} GROUP BY folder, tool_name` : `
    SELECT tc.folder AS folder, tc.tool_name AS tool_name, count() AS cnt FROM {{tool_calls}} AS tc
    WHERE tc.folder != ''${inSessions(df, 'tc.session_id')} GROUP BY folder, tool_name`, df.params),
  ]);

  const map = {};
  for (const r of perSource) {
    if (!map[r.folder]) map[r.folder] = { folder: r.folder, totalSessions: 0, editors: {}, firstSeen: r.first_seen, lastSeen: r.last_seen };
    map[r.folder].totalSessions += Number(r.count);
    map[r.folder].editors[r.source] = Number(r.count);
    if (r.first_seen != null && r.first_seen < map[r.folder].firstSeen) map[r.folder].firstSeen = r.first_seen;
    if (r.last_seen != null && r.last_seen > map[r.folder].lastSeen) map[r.folder].lastSeen = r.last_seen;
  }

  const sumByFolder = {};
  for (const r of sums) sumByFolder[r.folder] = r;

  const modelsByFolder = {};
  for (const r of modelRows) {
    const k = normalizeModelName(r.model) || r.model;
    if (!modelsByFolder[r.folder]) modelsByFolder[r.folder] = {};
    modelsByFolder[r.folder][k] = (modelsByFolder[r.folder][k] || 0) + Number(r.cnt);
  }

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
    SELECT c.session_id AS id, c.user_id AS user_id, c.total_msgs AS msgs, c.user_chars AS uc, c.assistant_chars AS ac,
           c.input_tokens AS ti, c.output_tokens AS to_, c.cache_read_tokens AS cr, c.cache_write_tokens AS cw
    FROM {{sessions_v}} AS c WHERE 1=1${f.and} ORDER BY ${MS} DESC, c.session_id, c.user_id`;
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

  // Constrain by the FULL (session_id, user_id) pairs of the selected rollups —
  // an id-only list would readmit other members' rows for colliding session_ids.
  const ids = rows.map(r => r.id);
  const users = rows.map(r => r.user_id);
  let topTools = [], topModels = [], totalToolCalls = 0;
  if (ids.length > 0) {
    const pairs = { ids, users };
    const r = await rooms();
    const [toolRows, modelRows] = await Promise.all([
      q(r.tool_stats ? `
      SELECT tool_name, sum(calls) AS cnt FROM {{tool_stats}}
      WHERE (session_id, user_id) IN arrayZip({ids:Array(String)}, {users:Array(String)})
      GROUP BY tool_name` : `
      SELECT tool_name, count() AS cnt FROM {{tool_calls}}
      WHERE (session_id, user_id) IN arrayZip({ids:Array(String)}, {users:Array(String)})
      GROUP BY tool_name`, pairs),
      q(r.model_stats ? `
      SELECT model, sum(msgs) AS cnt FROM {{model_stats}}
      WHERE (session_id, user_id) IN arrayZip({ids:Array(String)}, {users:Array(String)})
        AND model NOT IN ${EXCLUDED_MODELS} GROUP BY model` : `
      SELECT model, count() AS cnt FROM {{messages}}
      WHERE (session_id, user_id) IN arrayZip({ids:Array(String)}, {users:Array(String)})
        AND model NOT IN ${EXCLUDED_MODELS} GROUP BY model`, pairs),
    ]);
    const toolFreq = {};
    for (const r of toolRows) { toolFreq[r.tool_name] = Number(r.cnt); totalToolCalls += Number(r.cnt); }
    topTools = topN(toolFreq, 30);
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
  // Join on the FULL (session_id, user_id) key — id alone fans each call out to
  // every member's colliding session row (duplicates + wrong chat names). The
  // drill-down also honors the same hidden/date/editor filters as the charts it
  // is opened from, so out-of-scope call args never appear in it.
  let sql = `
    SELECT tc.tool_name AS tool_name, tc.args AS args, tc.source AS source, tc.folder AS folder,
           toUnixTimestamp64Milli(tc.ts) AS timestamp, s.name AS chat_name,
           concat(tc.session_id, '::', tc.user_id) AS chat_id
    FROM {{tool_calls}} AS tc INNER JOIN {{sessions}} AS s
      ON s.session_id = tc.session_id AND s.user_id = tc.user_id
    WHERE tc.tool_name = {name:String}`;
  const params = { name: toolName, limit };
  if (opts.folder) { sql += ' AND tc.folder = {folder:String}'; params.folder = opts.folder; }
  if (opts.hiddenFolders && opts.hiddenFolders.length) {
    sql += ' AND tc.folder NOT IN {hidden:Array(String)}';
    params.hidden = opts.hiddenFolders;
  }
  if (opts.editor) { sql += ' AND tc.source LIKE {editor:String}'; params.editor = `%${opts.editor}%`; }
  if (opts.dateFrom != null) { sql += ' AND toUnixTimestamp64Milli(tc.ts) >= {dateFrom:Int64}'; params.dateFrom = opts.dateFrom; }
  if (opts.dateTo != null) { sql += ' AND toUnixTimestamp64Milli(tc.ts) <= {dateTo:Int64}'; params.dateTo = opts.dateTo; }
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
// the same way; '' is the memhouse null and synthetic models have no pricing).
const ORPHAN_TOKENS = '(m.input_tokens > 0 OR m.output_tokens > 0 OR m.cache_read_tokens > 0 OR m.cache_write_tokens > 0)';

// session_id → dominant model (most frequent across the session's messages).
async function sessionDominantMap(f, scope = null) {
  // model_stats already holds one row per (session, model) with the message count —
  // argMax over a few thousand pre-aggregated rows instead of a scan of the room.
  const r = await rooms();
  const rows = await q(r.model_stats ? `
    SELECT session_id, user_id, argMax(model, msgs) AS dominant
    FROM {{model_stats}} AS m WHERE m.model NOT IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}${scopeAnd(scope, 'm')}
    GROUP BY session_id, user_id` : `
    SELECT session_id, user_id, argMax(model, cnt) AS dominant
    FROM (SELECT m.session_id AS session_id, m.user_id AS user_id, m.model AS model, count() AS cnt
          FROM {{messages}} AS m WHERE m.model NOT IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}${scopeAnd(scope, 'm')}
          GROUP BY session_id, user_id, model)
    GROUP BY session_id, user_id`, scopeParams(f, scope));
  const map = {};
  for (const r of rows) map[`${r.session_id}::${r.user_id}`] = r.dominant;
  return map;
}

// source → dominant model + global dominant (for sessions with tokens but no model).
async function sourceDominantMap(f) {
  const r = await rooms();
  const rows = await q(r.model_stats ? `
    SELECT m.source AS source, m.model AS model, sum(m.msgs) AS cnt
    FROM {{model_stats}} AS m WHERE m.model NOT IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}
    GROUP BY source, model` : `
    SELECT m.source AS source, m.model AS model, count() AS cnt
    FROM {{messages}} AS m WHERE m.model NOT IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}
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

  // Five independent reads, one round trip. sourceDominantMap stays lazy below — it is
  // only needed when unmodeled sessions exist, which most passes have none of.
  //
  // The ORPHAN_TOKENS predicate is dropped on the model_stats path on purpose: it
  // filtered individual message rows to any-token ones before summing, and a row with
  // zero tokens contributes zero to every sum — the predicate saved work, never changed
  // a number. The stat rows are already summed, so there is no work left to save.
  const r = await rooms();
  const [modelTokens, orphanRows, dominantMap, charRows, unmodeledRows] = await Promise.all([
    q(r.model_stats ? `
    SELECT m.model AS model, sum(m.input_tokens) AS input, sum(m.output_tokens) AS output,
           sum(m.cache_read_tokens) AS cacheRead, sum(m.cache_write_tokens) AS cacheWrite
    FROM {{model_stats}} AS m
    WHERE m.model NOT IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}
    GROUP BY model` : `
    SELECT m.model AS model, sum(m.input_tokens) AS input, sum(m.output_tokens) AS output,
           sum(m.cache_read_tokens) AS cacheRead, sum(m.cache_write_tokens) AS cacheWrite
    FROM {{messages}} AS m
    WHERE m.model NOT IN ${EXCLUDED_MODELS} AND ${ORPHAN_TOKENS}${inSessions(f, 'm.session_id')}
    GROUP BY model`, f.params),
    q(r.model_stats ? `
    SELECT m.session_id AS session_id, m.user_id AS user_id, sum(m.input_tokens) AS input, sum(m.output_tokens) AS output,
           sum(m.cache_read_tokens) AS cacheRead, sum(m.cache_write_tokens) AS cacheWrite
    FROM {{model_stats}} AS m
    WHERE m.model IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}
    GROUP BY session_id, user_id
    HAVING sum(m.input_tokens) > 0 OR sum(m.output_tokens) > 0 OR sum(m.cache_read_tokens) > 0 OR sum(m.cache_write_tokens) > 0` : `
    SELECT m.session_id AS session_id, m.user_id AS user_id, sum(m.input_tokens) AS input, sum(m.output_tokens) AS output,
           sum(m.cache_read_tokens) AS cacheRead, sum(m.cache_write_tokens) AS cacheWrite
    FROM {{messages}} AS m
    WHERE m.model IN ${EXCLUDED_MODELS} AND ${ORPHAN_TOKENS}${inSessions(f, 'm.session_id')}
    GROUP BY session_id, user_id`, f.params),
    sessionDominantMap(f),
    q(`
    SELECT c.session_id AS session_id, c.user_id AS user_id, c.user_chars AS userChars, c.assistant_chars AS asstChars
    FROM {{sessions_v}} AS c
    WHERE notEmpty(c.models) AND c.input_tokens = 0 AND c.output_tokens = 0
      AND (c.user_chars > 0 OR c.assistant_chars > 0)${f.and}`, f.params),
    q(`
    SELECT c.source AS source, c.input_tokens AS input, c.output_tokens AS output,
           c.cache_read_tokens AS cacheRead, c.cache_write_tokens AS cacheWrite
    FROM {{sessions_v}} AS c
    WHERE empty(c.models) AND (c.input_tokens > 0 OR c.output_tokens > 0)${f.and}`, f.params),
  ]);

  const orphanByModel = {};
  const addOrphan = (dominant, input, output, cacheRead, cacheWrite) => {
    if (!orphanByModel[dominant]) orphanByModel[dominant] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    orphanByModel[dominant].input += Number(input) || 0;
    orphanByModel[dominant].output += Number(output) || 0;
    orphanByModel[dominant].cacheRead += Number(cacheRead) || 0;
    orphanByModel[dominant].cacheWrite += Number(cacheWrite) || 0;
  };
  for (const r of orphanRows) {
    const dominant = dominantMap[`${r.session_id}::${r.user_id}`];
    if (dominant) addOrphan(dominant, r.input, r.output, r.cacheRead, r.cacheWrite);
  }

  // Sessions that name models but report zero tokens → estimate from chars.
  for (const r of charRows) {
    const dominant = dominantMap[`${r.session_id}::${r.user_id}`];
    if (dominant) addOrphan(dominant, Math.round((Number(r.userChars) || 0) / CHARS_PER_TOKEN), Math.round((Number(r.asstChars) || 0) / CHARS_PER_TOKEN), 0, 0);
  }

  // Sessions with tokens but NO model at all → the source's dominant model.
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
/**
 * @param {object} f      the user's filter
 * @param {object|null} scope  {ids, users} — the sessions the caller will actually use.
 *   getChats passes the page it just fetched; the cost pages pass nothing, because they
 *   are pricing the whole house on purpose.
 */
async function computePerChatCosts(f, scope = null) {
  const p = scopeParams(f, scope);
  const r = await rooms();
  // Five independent reads, one round trip. This function is called by three endpoints;
  // sequential, it alone cost 5 x RTT per call. On the model_stats path the ORPHAN
  // predicate is dropped/HAVINGed for the reason written in estimateCosts.
  const [aRows, bRows, cRows, dominantMap, sourceDominants] = await Promise.all([
    q(r.model_stats ? `
    SELECT m.session_id AS session_id, m.user_id AS user_id, m.model AS model, sum(m.input_tokens) AS i, sum(m.output_tokens) AS o,
           sum(m.cache_read_tokens) AS cr, sum(m.cache_write_tokens) AS cw
    FROM {{model_stats}} AS m
    WHERE m.model NOT IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}${scopeAnd(scope, 'm')}
    GROUP BY session_id, user_id, model` : `
    SELECT m.session_id AS session_id, m.user_id AS user_id, m.model AS model, sum(m.input_tokens) AS i, sum(m.output_tokens) AS o,
           sum(m.cache_read_tokens) AS cr, sum(m.cache_write_tokens) AS cw
    FROM {{messages}} AS m
    WHERE m.model NOT IN ${EXCLUDED_MODELS} AND ${ORPHAN_TOKENS}${inSessions(f, 'm.session_id')}${scopeAnd(scope, 'm')}
    GROUP BY session_id, user_id, model`, p),
    q(r.model_stats ? `
    SELECT m.session_id AS session_id, m.user_id AS user_id, sum(m.input_tokens) AS i, sum(m.output_tokens) AS o,
           sum(m.cache_read_tokens) AS cr, sum(m.cache_write_tokens) AS cw
    FROM {{model_stats}} AS m
    WHERE m.model IN ${EXCLUDED_MODELS}${inSessions(f, 'm.session_id')}${scopeAnd(scope, 'm')}
    GROUP BY session_id, user_id
    HAVING sum(m.input_tokens) > 0 OR sum(m.output_tokens) > 0 OR sum(m.cache_read_tokens) > 0 OR sum(m.cache_write_tokens) > 0` : `
    SELECT m.session_id AS session_id, m.user_id AS user_id, sum(m.input_tokens) AS i, sum(m.output_tokens) AS o,
           sum(m.cache_read_tokens) AS cr, sum(m.cache_write_tokens) AS cw
    FROM {{messages}} AS m
    WHERE m.model IN ${EXCLUDED_MODELS} AND ${ORPHAN_TOKENS}${inSessions(f, 'm.session_id')}${scopeAnd(scope, 'm')}
    GROUP BY session_id, user_id`, p),
    q(`
    SELECT c.session_id AS id, c.user_id AS user_id, c.source AS source, c.name AS name, c.folder AS folder,
           toUnixTimestamp64Milli(c.last_updated_at) AS last_updated_at,
           toUnixTimestamp64Milli(c.created_at) AS created_at,
           c.total_msgs AS msgs, c.models AS models,
           c.user_chars AS uc, c.assistant_chars AS ac,
           c.input_tokens AS ti, c.output_tokens AS to_,
           c.cache_read_tokens AS cr, c.cache_write_tokens AS cw,
           formatDateTime(${TS}, '%Y-%m', 'UTC') AS month
    FROM {{sessions_v}} AS c WHERE 1=1${f.and}${scopeAnd(scope, 'c')}`, p),
    sessionDominantMap(f, scope),
    // NOT scoped, deliberately. This is the house-wide "which model does this editor
    // usually run", used to price sessions that recorded no model at all. Computed from
    // the fifty rows on the page it would answer differently on page 1 than on page 2,
    // and the same session would report a different cost depending on where it was read.
    // Its scope is the user's FILTER, which is what it has always been.
    sourceDominantMap(f),
  ]);
  const { sourceDominant, globalDominant } = sourceDominants;

  const byChatModel = {};
  for (const r of aRows) { const k = `${r.session_id}::${r.user_id}`; (byChatModel[k] = byChatModel[k] || []).push(r); }

  const orphanByChat = {};
  for (const r of bRows) orphanByChat[`${r.session_id}::${r.user_id}`] = r;

  const out = [];
  for (const c of cRows) {
    const key = `${c.id}::${c.user_id}`; // rollups are per (session_id, user_id)
    const hasModels = (c.models || []).length > 0;
    const dominant = dominantMap[key] || null;
    const tokenMap = {};
    const add = (rawModel, i, o, cr, cw) => {
      if (!rawModel) return;
      const key = normalizeModelName(rawModel) || rawModel;
      if (!tokenMap[key]) tokenMap[key] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      tokenMap[key].input += Number(i) || 0; tokenMap[key].output += Number(o) || 0;
      tokenMap[key].cacheRead += Number(cr) || 0; tokenMap[key].cacheWrite += Number(cw) || 0;
    };
    for (const r of (byChatModel[key] || [])) add(r.model, r.i, r.o, r.cr, r.cw);
    const orphan = orphanByChat[key];
    if (orphan && dominant) add(dominant, orphan.i, orphan.o, orphan.cr, orphan.cw);
    if (hasModels && Number(c.ti) === 0 && Number(c.to_) === 0 && (c.uc > 0 || c.ac > 0) && dominant)
      add(dominant, Math.round((Number(c.uc) || 0) / CHARS_PER_TOKEN), Math.round((Number(c.ac) || 0) / CHARS_PER_TOKEN), 0, 0);
    if (!hasModels && (Number(c.ti) > 0 || Number(c.to_) > 0)) {
      const srcDom = sourceDominant[c.source] || globalDominant;
      if (srcDom) add(srcDom, c.ti, c.to_, c.cr, c.cw);
    }
    let totalCost = 0; const byModel = [];
    // A model with no price contributes nothing to totalCost, so the number a session
    // reports silently omits part of itself. Carry the fact alongside the number.
    let hasUnpriced = false;
    for (const [model, tok] of Object.entries(tokenMap)) {
      const cost = calculateCost(model, tok.input, tok.output, tok.cacheRead, tok.cacheWrite);
      if (cost !== null) { totalCost += cost; byModel.push({ model, cost }); }
      else hasUnpriced = true;
    }
    byModel.sort((a, b) => b.cost - a.cost);
    out.push({
      id: key, user: c.user_id, source: c.source, name: c.name, folder: c.folder,
      last_updated_at: c.last_updated_at, created_at: c.created_at,
      msgs: Number(c.msgs), month: c.month, totalCost, byModel, hasUnpriced,
    });
  }
  return out;
}

async function getCostAnalytics(opts = {}) {
  const f = filters(opts, { editorLike: true });
  const [overall, perChat] = await Promise.all([estimateCosts(opts), computePerChatCosts(f)]);

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
  // Same total-order rule as getChats: a top-50 cut over ties must not depend on the
  // order the rows happened to arrive in. Every session in a synthetic house costs the
  // same, and the list changed identity between two equivalent sources without a
  // secondary key.
  sessionCosts.sort((a, b) => (b.cost - a.cost) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

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
// Bounded at the SERVER, not in JS. `q()` buffers every row into memory, so
// `SELECT number FROM numbers(2000000000)` killed the whole dashboard process —
// "FATAL ERROR: Ineffective mark-compacts near heap limit", unauthenticated, on the bound
// port. Capping after the rows arrive is too late; ClickHouse has to stop sending.
const RAW_MAX_ROWS = 10000;
const RAW_MAX_BYTES = 64 * 1024 * 1024;
async function rawQuery(sql) {
  const rows = await q(sql, {}, {
    max_result_rows: RAW_MAX_ROWS,
    max_result_bytes: RAW_MAX_BYTES,
    // Cut the result off rather than failing a query that was legitimately large.
    result_overflow_mode: 'break',
    max_execution_time: 30,
    // Result caps bound what LEAVES the server; this bounds what the query does inside
    // it — a huge GROUP BY hits none of the caps above while eating the box's memory.
    // Used to come from the member settings profile; that object is gone (it detached
    // members on replace and its name was server-global), so the one caller that pipes
    // arbitrary SQL carries its own ceiling.
    max_memory_usage: 8000000000,
  });
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows, count: rows.length, truncated: rows.length >= RAW_MAX_ROWS };
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
  // The SPA used to infer the house's flavor from `tables.includes('sessions_v')`. That
  // stopped working the moment the rollup became a saved query: a per-member house has
  // three rooms named for the member and no `sessions_v` at all, so the page reported an
  // indeterminate schema and every typed example it might have offered would have failed
  // with UNKNOWN_TABLE. Hand it the resolved names instead of making it guess.
  const r = await rooms();
  return {
    tables: tbls.map((t) => t.name),
    schema: out,
    rooms: {
      member: r.member,
      sessions: r.sessions,
      messages: r.messages,
      tool_calls: r.tool_calls,
      // A parenthesised SELECT, not a name. It drops
      // into a `FROM … AS c` unchanged, which is what the examples do with it.
      sessions_v: r.sessions_v,
    },
  };
}

module.exports = { adoptMovedHouse,
  getClient, config,
  getOverview, getDailyActivity, getDashboardStats,
  getChats, countChats, getChat,
  getProjects, getDeepAnalytics, getToolCalls,
  estimateCosts, getCostAnalytics,
  rawQuery, schema,
  // Used only by the server's own guard to learn which database names are real. Not
  // reachable from any route.
  rawQueryUnguarded: (sql) => q(sql),
};
