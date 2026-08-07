import { useState, useEffect, useRef, useMemo } from 'react'
import { Play, Database, Table2, ChevronDown, Copy, Download, BarChart3, LineChart, PieChart } from 'lucide-react'
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler } from 'chart.js'
import { Bar, Line, Doughnut } from 'react-chartjs-2'
import { executeQuery, fetchSchema } from '../lib/api'
import { useTheme } from '../lib/theme'
import PageHeader from '../components/PageHeader'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler)

// Two backends share this SPA: the typed mem-house house (sessions / messages /
// tool_calls + the session rollup) and the legacy agentlytics cache (chats /
// chat_stats). Both are ClickHouse, and the flavor comes from /api/schema.
//
// The typed examples are TEMPLATED, not literal. A per-member house names its rooms for
// the member and has no `sessions_v` object at all — the rollup is a saved query — so
// `/api/schema` reports the resolved names and `{{room}}` tokens are substituted here.
// Detecting the flavor by `tables.includes('sessions_v')` stopped working for the same
// reason: it reported an indeterminate schema and offered nothing.
const TYPED_EXAMPLES = [
  { label: 'Sessions per editor', sql: `SELECT source, count() AS count FROM {{sessions_v}} AS c GROUP BY source ORDER BY count DESC` },
  { label: 'Top 10 projects', sql: `SELECT project, count() AS sessions, sum(total_msgs) AS messages FROM {{sessions_v}} AS c WHERE project != '' GROUP BY project ORDER BY sessions DESC LIMIT 10` },
  { label: 'Messages per day', sql: `SELECT toDate(ts) AS day, count() AS count FROM {{messages}} GROUP BY day ORDER BY day` },
  { label: 'Top models', sql: `SELECT model, count() AS count FROM {{messages}} WHERE model NOT IN ('', '<synthetic>') GROUP BY model ORDER BY count DESC LIMIT 10` },
  { label: 'Top tools', sql: `SELECT tool_name, count() AS count FROM {{tool_calls}} GROUP BY tool_name ORDER BY count DESC LIMIT 15` },
  { label: 'Token usage by editor', sql: `SELECT source, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens FROM {{sessions_v}} AS c GROUP BY source ORDER BY input_tokens DESC` },
  { label: 'Sessions by mode', sql: `SELECT mode, count() AS count FROM {{sessions_v}} AS c WHERE mode != '' GROUP BY mode ORDER BY count DESC` },
  { label: 'Hourly distribution', sql: `SELECT toHour(ts) AS hour, count() AS count FROM {{messages}} GROUP BY hour ORDER BY hour` },
  // Grouped by (session_id, user_id), matching the room's ORDER BY. `{{messages}}` is
  // the caller's own room, where user_id is constant — but point the same query at a
  // team `Merge` room (all_messages) and two members can carry the same adapter-local
  // session id; grouping on session_id alone would merge them and make any(source) an
  // arbitrary member's.
  { label: 'Full-text search', sql: `SELECT session_id, user_id, any(source) AS source, count() AS hits FROM {{messages}} WHERE text_ngram LIKE '%clickhouse%' GROUP BY session_id, user_id ORDER BY hits DESC LIMIT 10` },
]
const LEGACY_EXAMPLES = [
  { label: 'Sessions per editor', sql: `SELECT source, count() AS count FROM chats GROUP BY source ORDER BY count DESC` },
  { label: 'Top 10 projects', sql: `SELECT folder, count() AS sessions, sum(bubble_count) AS messages FROM chats WHERE folder IS NOT NULL GROUP BY folder ORDER BY sessions DESC LIMIT 10` },
  { label: 'Messages per day', sql: `SELECT toDate(toDateTime(intDiv(created_at, 1000))) AS day, count() AS count FROM chats WHERE created_at IS NOT NULL GROUP BY day ORDER BY day` },
  { label: 'Top models', sql: `SELECT model, count() AS count FROM messages WHERE model IS NOT NULL GROUP BY model ORDER BY count DESC LIMIT 10` },
  { label: 'Top tools', sql: `SELECT tool_name, count() AS count FROM tool_calls GROUP BY tool_name ORDER BY count DESC LIMIT 15` },
  { label: 'Token usage by editor', sql: `SELECT c.source AS source, sum(cs.total_input_tokens) AS input_tokens, sum(cs.total_output_tokens) AS output_tokens FROM chat_stats AS cs JOIN chats AS c ON c.id = cs.chat_id GROUP BY c.source ORDER BY input_tokens DESC` },
  { label: 'Sessions by mode', sql: `SELECT mode, count() AS count FROM chats WHERE mode IS NOT NULL GROUP BY mode ORDER BY count DESC` },
  { label: 'Hourly distribution', sql: `SELECT toHour(toDateTime(intDiv(created_at, 1000))) AS hour, count() AS count FROM chats WHERE created_at IS NOT NULL GROUP BY hour ORDER BY hour` },
]

// `{{room}}` -> the resolved name (or, for the rollup on a per-member house, the whole
// subquery). Same token shape the server's own query layer uses.
function applyRooms(sql, rooms) {
  return sql.replace(/\{\{([a-z_]+)\}\}/g, (m, name) => rooms[name] ?? m)
}

export default function SqlViewer() {
  const { dark } = useTheme()
  // Three states, and they must stay distinguishable: 'loading' while /api/schema is
  // in flight, an array once the house's flavor is known, and null when the request
  // finished without telling us. Guessing wrong offers queries against tables that do
  // not exist, so nothing is offered until the answer is in — but a page that is
  // merely still loading must not claim detection failed.
  const [examples, setExamples] = useState('loading')
  const [sql, setSql] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [schema, setSchema] = useState(null)
  const [showSchema, setShowSchema] = useState(false)
  const [chartType, setChartType] = useState('bar')
  const [elapsed, setElapsed] = useState(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    fetchSchema().then(s => {
      setSchema(s)
      // Three outcomes, not two. The typed house is whichever one /api/schema resolved
      // rooms for; the legacy one has `chats`. Anything else — an error object with no
      // `tables`, a half-applied schema with neither marker — is indeterminate, and
      // offering either set would hand the user queries that error.
      //
      // `rooms` is the authority, not a table name: a per-member house has no
      // `sessions_v` object, so the old `tables.includes('sessions_v')` test called a
      // perfectly healthy typed house indeterminate.
      const tables = s?.tables
      const rooms = s?.rooms
      const ex = rooms?.sessions ? TYPED_EXAMPLES.map(e => ({ ...e, sql: applyRooms(e.sql, rooms) }))
        : !Array.isArray(tables) ? null
          : tables.includes('chats') ? LEGACY_EXAMPLES
            : null
      setExamples(ex)
      if (!ex) return
      // Swap the prefilled query only if the user hasn't edited it yet.
      setSql(prev => (prev === '' || prev === TYPED_EXAMPLES[0].sql || prev === LEGACY_EXAMPLES[0].sql) ? ex[0].sql : prev)
    }).catch(() => setExamples(null))
  }, [])

  const runQuery = async () => {
    // Guard here, not only on the button: ⌘+Enter reaches this directly, and an
    // empty submit comes back as a bare "sql string required" from /api/query.
    if (!sql.trim() || loading) return
    setLoading(true)
    setError(null)
    setResult(null)
    const t0 = performance.now()
    try {
      const data = await executeQuery(sql.trim())
      setElapsed(((performance.now() - t0)).toFixed(0))
      if (data.error) {
        setError(data.error)
      } else {
        setResult(data)
      }
    } catch (e) {
      setError(e.message)
      setElapsed(null)
    }
    setLoading(false)
  }

  const handleKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      runQuery()
    }
  }

  const copyResults = () => {
    if (!result) return
    const header = result.columns.join('\t')
    const rows = result.rows.map(r => result.columns.map(c => r[c] ?? '').join('\t'))
    navigator.clipboard.writeText([header, ...rows].join('\n'))
  }

  const downloadCsv = () => {
    if (!result) return
    const escape = (v) => {
      const s = String(v ?? '')
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = result.columns.map(escape).join(',')
    const rows = result.rows.map(r => result.columns.map(c => escape(r[c])).join(','))
    const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'query-results.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  // Auto-detect chartable data
  const chartData = useMemo(() => {
    if (!result || result.columns.length < 2 || result.rows.length === 0) return null
    const cols = result.columns
    // Find a label column (string-like) and value columns (numeric)
    const labelCol = cols.find(c => result.rows.every(r => typeof r[c] === 'string' || r[c] === null)) || cols[0]
    const valueCols = cols.filter(c => c !== labelCol && result.rows.some(r => typeof r[c] === 'number'))
    if (valueCols.length === 0) return null

    const labels = result.rows.map(r => String(r[labelCol] ?? ''))
    const palette = ['#6366f1', '#f59e0b', '#06b6d4', '#10b981', '#f97316', '#ec4899', '#8b5cf6', '#3b82f6', '#ef4444', '#14b8a6']

    const datasets = valueCols.map((col, i) => ({
      label: col,
      data: result.rows.map(r => r[col] ?? 0),
      backgroundColor: chartType === 'doughnut'
        ? palette.slice(0, labels.length)
        : palette[i % palette.length] + '99',
      borderColor: palette[i % palette.length],
      borderWidth: chartType === 'line' ? 2 : 1,
      borderRadius: chartType === 'bar' ? 4 : 0,
      tension: 0.3,
      fill: chartType === 'line',
      pointRadius: chartType === 'line' ? 3 : 0,
    }))

    return { labels, datasets }
  }, [result, chartType])

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: chartData?.datasets?.length > 1 || chartType === 'doughnut', labels: { color: dark ? '#ccc' : '#555', font: { size: 11 } } },
      tooltip: { backgroundColor: dark ? '#1e1e2e' : '#fff', titleColor: dark ? '#fff' : '#111', bodyColor: dark ? '#ccc' : '#555', borderColor: dark ? '#333' : '#ddd', borderWidth: 1 },
    },
    scales: chartType !== 'doughnut' ? {
      x: { ticks: { color: dark ? '#888' : '#666', font: { size: 10 }, maxRotation: 45 }, grid: { color: dark ? '#ffffff08' : '#00000008' } },
      y: { ticks: { color: dark ? '#888' : '#666', font: { size: 10 } }, grid: { color: dark ? '#ffffff08' : '#00000008' } },
    } : undefined,
  }

  const txtStyle = { color: 'var(--c-text)' }
  const txt2Style = { color: 'var(--c-text2)' }
  const cardBg = { background: 'var(--c-card)', border: '1px solid var(--c-border)' }

  return (
    <div className="fade-in space-y-3">
      {/* Header */}
      <PageHeader icon={Database} title="SQL Viewer">
        <span className="text-[10px] px-1.5 py-0.5" style={{ color: 'var(--c-text3)', background: 'var(--c-bg3)' }}>cache.db</span>
        <div className="ml-auto">
          <button
            onClick={() => setShowSchema(!showSchema)}
            className="flex items-center gap-1 text-[11px] px-2 py-1 transition hover:bg-[var(--c-card)]"
            style={{ color: 'var(--c-text2)', border: '1px solid var(--c-border)' }}
          >
            <Table2 size={11} />
            Schema
            <ChevronDown size={10} className={`transition ${showSchema ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </PageHeader>

      {/* Schema panel */}
      {showSchema && schema && (
        <div className="rounded-lg p-3 space-y-2 text-[12px]" style={cardBg}>
          <div className="flex flex-wrap gap-4">
            {schema.tables.map(table => (
              <div key={table} className="min-w-[180px]">
                <div className="font-semibold mb-1" style={txtStyle}>{table}</div>
                <div className="space-y-0.5">
                  {schema.schema[table]?.map(col => (
                    <div key={col.name} className="flex gap-2" style={txt2Style}>
                      <span style={txtStyle}>{col.name}</span>
                      <span className="text-[11px] opacity-60">{col.type}</span>
                      {col.pk ? <span className="text-[10px] px-1 rounded" style={{ background: '#6366f133', color: '#6366f1' }}>PK</span> : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Example queries — withheld until the schema flavor is known, since the
          typed and legacy sets target entirely different tables. */}
      <div className="flex flex-wrap gap-1">
        {examples === 'loading' ? (
          <span className="text-[11px]" style={txt2Style}>loading examples…</span>
        ) : examples === null ? (
          <span className="text-[11px]" style={txt2Style}>
            examples unavailable — could not determine the schema from /api/schema
          </span>
        ) : examples.map((q, i) => (
          <button
            key={i}
            onClick={() => setSql(q.sql)}
            className="text-[11px] px-2 py-0.5 rounded transition hover:bg-[var(--c-card)]"
            style={{ ...txt2Style, border: '1px solid var(--c-border)' }}
          >
            {q.label}
          </button>
        ))}
      </div>

      {/* SQL editor */}
      <div className="rounded-lg overflow-hidden" style={cardBg}>
        <div className="flex items-center justify-between px-3 py-1.5" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <span className="text-[11px] font-mono" style={txt2Style}>SQL</span>
          <div className="flex items-center gap-1">
            <span className="text-[11px]" style={txt2Style}>⌘+Enter to run</span>
          </div>
        </div>
        <textarea
          ref={textareaRef}
          value={sql}
          onChange={e => setSql(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          className="w-full p-3 text-[12px] font-mono resize-y outline-none"
          style={{ background: 'transparent', color: 'var(--c-text)', minHeight: 80, maxHeight: 300 }}
          rows={4}
        />
        <div className="flex items-center gap-2 px-3 py-1.5" style={{ borderTop: '1px solid var(--c-border)' }}>
          <button
            onClick={runQuery}
            disabled={loading || !sql.trim()}
            className="flex items-center gap-1.5 px-3 py-1 text-[12px] font-medium rounded transition"
            style={{ background: '#6366f1', color: '#fff', opacity: loading ? 0.5 : 1 }}
          >
            <Play size={11} />
            {loading ? 'Running...' : 'Run Query'}
          </button>
          {elapsed && result && (
            <span className="text-[11px]" style={txt2Style}>
              {result.count} row{result.count !== 1 ? 's' : ''} in {elapsed}ms
            </span>
          )}
          {result && (
            <div className="ml-auto flex items-center gap-1">
              <button onClick={copyResults} className="p-1 rounded hover:bg-[var(--c-bg2)] transition" style={txt2Style} title="Copy to clipboard">
                <Copy size={12} />
              </button>
              <button onClick={downloadCsv} className="p-1 rounded hover:bg-[var(--c-bg2)] transition" style={txt2Style} title="Download CSV">
                <Download size={12} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: '#ef444420', border: '1px solid #ef444440', color: '#ef4444' }}>
          {error}
        </div>
      )}

      {/* Results table */}
      {result && result.rows.length > 0 && (
        <div className="rounded-lg overflow-hidden" style={cardBg}>
          <div className="overflow-x-auto" style={{ maxHeight: 400 }}>
            <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--c-border)' }}>
                  {result.columns.map(col => (
                    <th key={col} className="text-left px-3 py-1.5 font-semibold sticky top-0" style={{ ...txtStyle, background: 'var(--c-card)' }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i} className="hover:bg-[var(--c-bg2)] transition" style={{ borderBottom: '1px solid var(--c-border)' }}>
                    {result.columns.map(col => (
                      <td key={col} className="px-3 py-1 font-mono" style={txt2Style}>
                        {formatCell(row[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && result.rows.length === 0 && (
        <div className="rounded-lg px-3 py-6 text-center text-[12px]" style={{ ...cardBg, ...txt2Style }}>
          Query returned 0 rows
        </div>
      )}

      {/* Chart visualization */}
      {chartData && (
        <div className="rounded-lg p-4" style={cardBg}>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[12px] font-semibold" style={txtStyle}>Visualization</span>
            <div className="flex gap-0.5 ml-2" style={{ border: '1px solid var(--c-border)', borderRadius: 6 }}>
              {[
                { type: 'bar', icon: BarChart3 },
                { type: 'line', icon: LineChart },
                { type: 'doughnut', icon: PieChart },
              ].map(({ type, icon: Icon }) => (
                <button
                  key={type}
                  onClick={() => setChartType(type)}
                  className="p-1.5 transition"
                  style={{
                    background: chartType === type ? 'var(--c-bg2)' : 'transparent',
                    color: chartType === type ? 'var(--c-white)' : 'var(--c-text3)',
                    borderRadius: 4,
                  }}
                >
                  <Icon size={12} />
                </button>
              ))}
            </div>
          </div>
          <div style={{ height: chartType === 'doughnut' ? 280 : 260 }}>
            {chartType === 'bar' && <Bar data={chartData} options={chartOptions} />}
            {chartType === 'line' && <Line data={chartData} options={chartOptions} />}
            {chartType === 'doughnut' && <Doughnut data={chartData} options={chartOptions} />}
          </div>
        </div>
      )}
    </div>
  )
}

function formatCell(value) {
  if (value === null || value === undefined) return <span className="opacity-30">NULL</span>
  if (typeof value === 'number') return value.toLocaleString()
  const str = String(value)
  if (str.length > 120) return str.substring(0, 120) + '…'
  return str
}
