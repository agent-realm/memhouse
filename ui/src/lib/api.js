export const BASE = '';

// ── Auth helpers ──
const AUTH_KEY = 'agentlytics_relay_token';

export function getAuthToken() {
  return localStorage.getItem(AUTH_KEY);
}

export function setAuthToken(token) {
  if (token) localStorage.setItem(AUTH_KEY, token);
  else localStorage.removeItem(AUTH_KEY);
}

let onAuthFailure = null;
export function setOnAuthFailure(fn) { onAuthFailure = fn; }

async function authFetch(url, opts = {}) {
  const token = getAuthToken();
  if (token) {
    opts.headers = { ...opts.headers, Authorization: `Bearer ${token}` };
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    setAuthToken(null);
    if (onAuthFailure) onAuthFailure();
    throw new Error('Unauthorized');
  }
  return res;
}

export async function login(password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Login failed');
  }
  const data = await res.json();
  if (data.token) setAuthToken(data.token);
  return data;
}

// Append optional dateFrom/dateTo (ms timestamps) to URLSearchParams
function appendDateParams(q, params) {
  if (params.dateFrom) q.set('dateFrom', params.dateFrom);
  if (params.dateTo) q.set('dateTo', params.dateTo);
}

export async function fetchOverview(params = {}) {
  const q = new URLSearchParams();
  if (params.editor) q.set('editor', params.editor);
  appendDateParams(q, params);
  const qs = q.toString();
  const res = await fetch(`${BASE}/api/overview${qs ? '?' + qs : ''}`);
  return res.json();
}

export async function fetchChats(params = {}) {
  const q = new URLSearchParams();
  if (params.editor) q.set('editor', params.editor);
  if (params.folder) q.set('folder', params.folder);
  if (params.limit) q.set('limit', params.limit);
  if (params.offset) q.set('offset', params.offset);
  if (params.named === false) q.set('named', 'false');
  appendDateParams(q, params);
  const res = await fetch(`${BASE}/api/chats?${q}`);
  return res.json();
}

export async function fetchChat(id) {
  // Some adapters emit ids containing '/' (e.g. Kiro's dir/file fallback) —
  // encode so the id stays a single path segment for the /api/chats/:id route.
  const res = await fetch(`${BASE}/api/chats/${encodeURIComponent(id)}`);
  return res.json();
}

export async function fetchProjects(params = {}) {
  const q = new URLSearchParams();
  appendDateParams(q, params);
  const qs = q.toString();
  const res = await fetch(`${BASE}/api/projects${qs ? '?' + qs : ''}`);
  return res.json();
}

export async function fetchDailyActivity(params = {}) {
  const q = new URLSearchParams();
  if (params.editor) q.set('editor', params.editor);
  appendDateParams(q, params);
  const qs = q.toString();
  const res = await fetch(`${BASE}/api/daily-activity${qs ? '?' + qs : ''}`);
  return res.json();
}

export async function fetchDeepAnalytics(params = {}) {
  const q = new URLSearchParams();
  if (params.editor) q.set('editor', params.editor);
  if (params.folder) q.set('folder', params.folder);
  if (params.limit) q.set('limit', params.limit);
  appendDateParams(q, params);
  const res = await fetch(`${BASE}/api/deep-analytics?${q}`);
  return res.json();
}

// POST, read as a stream. EventSource can only issue GET, and a full re-ship behind a GET
// is the easiest request on a machine to make by accident — a prefetch, a link checker, a
// curl in a log file. The wire format is unchanged (`data: {...}` frames); only the verb
// and the reader are.
export async function refetchAgents(onProgress) {
  const res = await fetch(`${BASE}/api/refetch`, { method: 'POST' });
  if (!res.ok || !res.body) throw new Error(`refetch failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let last = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() || '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let data;
      try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (data.error) throw new Error(data.error);
      if (data.done) { last = data; }
      else if (onProgress) onProgress(data);
    }
  }
  if (!last) throw new Error('refetch ended without completing');
  return last;
}

export async function fetchDashboardStats(params = {}) {
  const q = new URLSearchParams();
  if (params.editor) q.set('editor', params.editor);
  appendDateParams(q, params);
  const qs = q.toString();
  const res = await fetch(`${BASE}/api/dashboard-stats${qs ? '?' + qs : ''}`);
  return res.json();
}

export async function fetchCostAnalytics(params = {}) {
  const q = new URLSearchParams();
  if (params.editor) q.set('editor', params.editor);
  appendDateParams(q, params);
  const qs = q.toString();
  const res = await fetch(`${BASE}/api/cost-analytics${qs ? '?' + qs : ''}`);
  return res.json();
}

export async function fetchCosts(params = {}) {
  const q = new URLSearchParams();
  if (params.editor) q.set('editor', params.editor);
  if (params.folder) q.set('folder', params.folder);
  if (params.chatId) q.set('chatId', params.chatId);
  appendDateParams(q, params);
  const qs = q.toString();
  const res = await fetch(`${BASE}/api/costs${qs ? '?' + qs : ''}`);
  return res.json();
}

export async function fetchConfig() {
  const res = await fetch(`${BASE}/api/config`);
  return res.json();
}

export async function updateConfig(data) {
  const res = await fetch(`${BASE}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function fetchAllProjects() {
  const res = await fetch(`${BASE}/api/all-projects`);
  return res.json();
}

export async function executeQuery(sql) {
  const res = await fetch(`${BASE}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  return res.json();
}

export async function fetchSchema() {
  const res = await fetch(`${BASE}/api/schema`);
  return res.json();
}

export async function fetchShareImage(opts = {}) {
  const q = new URLSearchParams();
  if (opts.showEditors !== undefined) q.set('showEditors', opts.showEditors);
  if (opts.showModels !== undefined) q.set('showModels', opts.showModels);
  if (opts.showCosts !== undefined) q.set('showCosts', opts.showCosts);
  if (opts.showTokens !== undefined) q.set('showTokens', opts.showTokens);
  if (opts.showHours !== undefined) q.set('showHours', opts.showHours);
  if (opts.username) q.set('username', opts.username);
  if (opts.theme) q.set('theme', opts.theme);
  if (opts.folder) q.set('folder', opts.folder);
  const qs = q.toString();
  const res = await fetch(`${BASE}/api/share-image${qs ? '?' + qs : ''}`);
  return res.text();
}

export async function fetchToolCalls(name, opts = {}) {
  const q = new URLSearchParams({ name });
  if (opts.limit) q.set('limit', opts.limit);
  if (opts.folder) q.set('folder', opts.folder);
  if (opts.editor) q.set('editor', opts.editor);
  appendDateParams(q, opts);
  const res = await fetch(`${BASE}/api/tool-calls?${q}`);
  return res.json();
}

export async function fetchCheckAi(folder) {
  const q = new URLSearchParams({ folder });
  const res = await fetch(`${BASE}/api/check-ai?${q}`);
  return res.json();
}

export async function fetchUsage() {
  const res = await fetch(`${BASE}/api/usage`);
  return res.json();
}

// ── Artifacts API ──

export async function fetchArtifacts() {
  const res = await fetch(`${BASE}/api/artifacts`);
  return res.json();
}

export async function fetchArtifactContent(filePath) {
  const q = new URLSearchParams({ path: filePath });
  const res = await fetch(`${BASE}/api/artifact-content?${q}`);
  return res.json();
}

// ── MCPs API ──

export async function fetchMCPs() {
  const res = await fetch(`${BASE}/api/mcps`);
  return res.json();
}

// ── GSD API ──

export async function fetchGSDProjects() {
  const res = await fetch(`${BASE}/api/gsd/projects`);
  return res.json();
}

export async function fetchGSDPhases(folder) {
  const q = new URLSearchParams({ folder });
  const res = await fetch(`${BASE}/api/gsd/phases?${q}`);
  return res.json();
}

export async function fetchGSDPlan(folder, phase) {
  const q = new URLSearchParams({ folder, phase });
  const res = await fetch(`${BASE}/api/gsd/plan?${q}`);
  return res.json();
}

export async function fetchGSDOverview() {
  const res = await fetch(`${BASE}/api/gsd/overview`);
  return res.json();
}

export async function fetchGSDConfig(folder) {
  const q = new URLSearchParams({ folder });
  const res = await fetch(`${BASE}/api/gsd/config?${q}`);
  return res.json();
}

export async function fetchGSDPhaseTokens(folder) {
  const q = new URLSearchParams({ folder });
  const res = await fetch(`${BASE}/api/gsd/phase-tokens?${q}`);
  return res.json();
}

export async function fetchGSDFile(folder, type, phaseDir) {
  const q = new URLSearchParams({ folder, type });
  if (phaseDir) q.set('phase', phaseDir);
  const res = await fetch(`${BASE}/api/gsd/file?${q}`);
  return res.json();
}

// ── Relay API ──

export async function fetchMode() {
  try {
    const res = await fetch(`${BASE}/api/mode`);
    if (!res.ok) return { mode: 'local' };
    return res.json();
  } catch {
    return { mode: 'local' };
  }
}

export async function fetchRelayTeamStats() {
  const res = await authFetch(`${BASE}/relay/team-stats`);
  return res.json();
}

export async function fetchRelayUserActivity(username, opts = {}) {
  const q = new URLSearchParams();
  if (opts.folder) q.set('folder', opts.folder);
  if (opts.limit) q.set('limit', opts.limit);
  const qs = q.toString();
  const res = await authFetch(`${BASE}/relay/activity/${encodeURIComponent(username)}${qs ? '?' + qs : ''}`);
  return res.json();
}

export async function fetchRelaySearch(query, opts = {}) {
  const q = new URLSearchParams({ q: query });
  if (opts.username) q.set('username', opts.username);
  if (opts.folder) q.set('folder', opts.folder);
  if (opts.limit) q.set('limit', opts.limit);
  const res = await authFetch(`${BASE}/relay/search?${q}`);
  return res.json();
}

export async function fetchRelayFeed(opts = {}) {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', opts.limit);
  if (opts.since) q.set('since', opts.since);
  const qs = q.toString();
  const res = await authFetch(`${BASE}/relay/feed${qs ? '?' + qs : ''}`);
  return res.json();
}

export async function mergeRelayUsers(from, to) {
  const res = await authFetch(`${BASE}/relay/merge-users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  return res.json();
}

export async function fetchRelaySession(chatId, username) {
  const q = new URLSearchParams();
  if (username) q.set('username', username);
  const qs = q.toString();
  const res = await authFetch(`${BASE}/relay/session/${encodeURIComponent(chatId)}${qs ? '?' + qs : ''}`);
  return res.json();
}
