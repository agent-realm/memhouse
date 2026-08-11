import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Search, Filter, List, FolderOpen, ChevronDown, ChevronRight, X, AlertTriangle } from 'lucide-react'
import { Chart as ChartJS, ArcElement, CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler } from 'chart.js'
import { Line, Doughnut, Bar } from 'react-chartjs-2'
import { fetchChats } from '../lib/api'
import { editorColor, editorLabel, formatNumber, formatCost, formatDate, dateRangeToApiParams } from '../lib/constants'
import { useTheme } from '../lib/theme'
import KpiCard from '../components/KpiCard'
import EditorIcon from '../components/EditorIcon'
import SectionTitle from '../components/SectionTitle'
import DateRangePicker from '../components/DateRangePicker'
import ChatSidebar from '../components/ChatSidebar'
import PageHeader from '../components/PageHeader'

ChartJS.register(ArcElement, CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler)

const MONO = 'JetBrains Mono, monospace'

// Custom Chart.js plugin: drag-to-select range on x-axis
const dragSelectPlugin = {
  id: 'dragSelect',
  beforeEvent(chart, args) {
    const evt = args.event
    const state = chart._dragSelect || (chart._dragSelect = { dragging: false, startX: 0, endX: 0 })
    const area = chart.chartArea
    if (!area) return

    if (evt.type === 'mousedown' && evt.x >= area.left && evt.x <= area.right && evt.y >= area.top && evt.y <= area.bottom) {
      state.dragging = true
      state.startX = evt.x
      state.endX = evt.x
    }
    if (evt.type === 'mousemove' && state.dragging) {
      state.endX = Math.max(area.left, Math.min(evt.x, area.right))
      args.changed = false
      chart.draw()
      return false
    }
    if (evt.type === 'mouseup' && state.dragging) {
      state.dragging = false
      state.endX = Math.max(area.left, Math.min(evt.x, area.right))
      const x1 = Math.min(state.startX, state.endX)
      const x2 = Math.max(state.startX, state.endX)
      if (x2 - x1 > 5) {
        const scale = chart.scales.x
        const startIdx = scale.getValueForPixel(x1)
        const endIdx = scale.getValueForPixel(x2)
        const labels = chart.data.labels
        const startLabel = labels[Math.max(0, Math.round(startIdx))]
        const endLabel = labels[Math.min(labels.length - 1, Math.round(endIdx))]
        if (chart.config.options._onRangeSelect) {
          chart.config.options._onRangeSelect(startLabel, endLabel)
        }
      }
      chart.draw()
    }
  },
  afterDraw(chart) {
    const state = chart._dragSelect
    if (!state) return
    const area = chart.chartArea
    const ctx = chart.ctx
    // Draw persisted selection highlight
    const opts = chart.config.options
    if (opts._selectionRange && chart.data.labels) {
      const scale = chart.scales.x
      const labels = chart.data.labels
      const si = labels.indexOf(opts._selectionRange[0])
      const ei = labels.indexOf(opts._selectionRange[1])
      if (si >= 0 && ei >= 0) {
        const px1 = scale.getPixelForValue(si)
        const px2 = scale.getPixelForValue(ei)
        ctx.save()
        ctx.fillStyle = 'rgba(99,102,241,0.10)'
        ctx.fillRect(Math.min(px1, px2), area.top, Math.abs(px2 - px1), area.bottom - area.top)
        ctx.strokeStyle = 'rgba(99,102,241,0.4)'
        ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.strokeRect(Math.min(px1, px2), area.top, Math.abs(px2 - px1), area.bottom - area.top)
        ctx.restore()
      }
    }
    // Draw active drag overlay
    if (state.dragging) {
      const x1 = Math.min(state.startX, state.endX)
      const x2 = Math.max(state.startX, state.endX)
      ctx.save()
      ctx.fillStyle = 'rgba(99,102,241,0.15)'
      ctx.fillRect(x1, area.top, x2 - x1, area.bottom - area.top)
      ctx.restore()
    }
  },
}
ChartJS.register(dragSelectPlugin)

// Custom tooltip positioner: below cursor
Tooltip.positioners.belowCursor = function(elements, eventPosition) {
  return { x: eventPosition.x, y: eventPosition.y + 20 }
}

export default function Sessions({ overview }) {
  const { dark } = useTheme()
  const txtDim = dark ? '#555' : '#999'
  const legendColor = dark ? '#777' : '#555'
  const gridColor = dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.06)'
  const [chats, setChats] = useState([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [editor, setEditor] = useState(searchParams.get('editor') || '')
  const [loading, setLoading] = useState(true)
  const [groupByProject, setGroupByProject] = useState(false)
  const [collapsedProjects, setCollapsedProjects] = useState(new Set())
  const [dateRange, setDateRange] = useState(null) // [startWeek, endWeek] — chart drag-select
  const [apiDateRange, setApiDateRange] = useState(null) // { from, to } — server-side date filter
  const [selectedChatId, setSelectedChatId] = useState(null)
  const chartRef = useRef(null)

  const onRangeSelect = useCallback((start, end) => {
    if (start && end) setDateRange([start, end].sort())
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchChats({ editor, limit: 1000, ...dateRangeToApiParams(apiDateRange) }).then(data => {
      setChats(data.chats)
      setTotal(data.total)
      setLoading(false)
    })
  }, [editor, apiDateRange])

  const searchFiltered = search
    ? chats.filter(c =>
        (c.name || '').toLowerCase().includes(search.toLowerCase()) ||
        (c.folder || '').toLowerCase().includes(search.toLowerCase()) ||
        c.id.toLowerCase().includes(search.toLowerCase())
      )
    : chats

  // Apply date range filter
  const filtered = useMemo(() => {
    if (!dateRange) return searchFiltered
    const [start, end] = dateRange
    // Add 6 days to end week to cover full week
    const startMs = new Date(start).getTime()
    const endMs = new Date(end).getTime() + 6 * 86400000
    return searchFiltered.filter(c => {
      const ts = c.lastUpdatedAt || c.createdAt
      return ts && ts >= startMs && ts <= endMs
    })
  }, [searchFiltered, dateRange])

  const editors = overview?.editors || []
  const MODEL_COLORS = ['#6366f1', '#a78bfa', '#818cf8', '#c084fc', '#e879f9', '#f472b6', '#fb7185', '#f87171', '#fbbf24', '#34d399']

  // Summary stats from filtered chats
  const stats = useMemo(() => {
    const editorCounts = {}
    const modelCounts = {}
    const modeCounts = {}
    let bloatCount = 0
    let largeCount = 0
    const projectSet = new Set()
    for (const c of filtered) {
      if (c.source) editorCounts[c.source] = (editorCounts[c.source] || 0) + 1
      if (c.topModel) modelCounts[c.topModel] = (modelCounts[c.topModel] || 0) + 1
      if (c.mode) modeCounts[c.mode] = (modeCounts[c.mode] || 0) + 1
      if (c.folder) projectSet.add(c.folder)
      if (c.bubbleCount >= 500) bloatCount++
      else if (c.bubbleCount >= 200) largeCount++
    }
    return {
      editorEntries: Object.entries(editorCounts).sort((a, b) => b[1] - a[1]),
      modelEntries: Object.entries(modelCounts).sort((a, b) => b[1] - a[1]).slice(0, 10),
      modeEntries: Object.entries(modeCounts).sort((a, b) => b[1] - a[1]),
      bloatCount,
      largeCount,
      projectCount: projectSet.size,
    }
  }, [filtered])

  // Timeline chart data: sessions per week by editor (always use full list, not date-filtered)
  const timelineChart = useMemo(() => {
    if (searchFiltered.length === 0) return null
    const weekMap = {}
    for (const c of searchFiltered) {
      const ts = c.lastUpdatedAt || c.createdAt
      if (!ts) continue
      const d = new Date(ts)
      const day = d.getDay()
      const diff = d.getDate() - day + (day === 0 ? -6 : 1)
      const monday = new Date(d)
      monday.setDate(diff)
      const wk = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
      if (!weekMap[wk]) weekMap[wk] = {}
      const src = c.source || 'unknown'
      weekMap[wk][src] = (weekMap[wk][src] || 0) + 1
    }
    const weeks = Object.keys(weekMap).sort()
    const editorIds = [...new Set(searchFiltered.map(c => c.source).filter(Boolean))]
    return {
      labels: weeks,
      datasets: editorIds.map(eid => ({
        label: editorLabel(eid),
        data: weeks.map(w => weekMap[w][eid] || 0),
        borderColor: editorColor(eid),
        backgroundColor: editorColor(eid) + '15',
        borderWidth: 1.5,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
      })),
    }
  }, [searchFiltered])

  // Group by project
  const grouped = useMemo(() => {
    if (!groupByProject) return null
    const map = {}
    for (const c of filtered) {
      const key = c.folder || '(no project)'
      if (!map[key]) map[key] = []
      map[key].push(c)
    }
    return Object.entries(map)
      .map(([folder, items]) => ({ folder, name: folder === '(no project)' ? '(no project)' : folder.split('/').pop(), items }))
      .sort((a, b) => b.items.length - a.items.length)
  }, [filtered, groupByProject])

  function toggleProject(folder) {
    setCollapsedProjects(prev => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }

  const SessionRow = ({ c }) => (
    <tr
      key={c.id}
      className="cursor-pointer transition"
      style={{ borderBottom: '1px solid var(--c-border)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--c-bg3)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      onClick={() => setSelectedChatId(c.id)}
    >
      <td className="py-2 px-3">
        <span className="inline-flex items-center gap-1.5">
          <EditorIcon source={c.source} size={12} />
          <span className="text-[12px]" style={{ color: 'var(--c-text2)' }}>{editorLabel(c.source)}</span>
        </span>
      </td>
      <td className="py-2 px-3 font-medium truncate max-w-[280px] text-[12px]" style={{ color: 'var(--c-white)' }}>
        {c.name || <span style={{ color: 'var(--c-text3)' }}>Untitled</span>}
        {c.encrypted && <span className="ml-1.5 text-[10px] text-yellow-500/60">locked</span>}
      </td>
      {!groupByProject && (
        <td className="py-2 px-3 truncate max-w-[160px] text-[12px]" style={{ color: 'var(--c-text2)' }} title={c.folder}>
          {c.folder ? (
            <span
              className="cursor-pointer hover:underline"
              style={{ color: 'var(--c-accent)' }}
              onClick={e => { e.stopPropagation(); navigate(`/projects/detail?folder=${encodeURIComponent(c.folder)}`) }}
            >{c.folder.split('/').pop()}</span>
          ) : ''}
        </td>
      )}
      <td className="py-2 px-3 text-[12px]" style={{ color: 'var(--c-text2)' }}>{c.mode || ''}</td>
      <td className="py-2 px-3 text-[12px] font-mono truncate max-w-[150px]" style={{ color: 'var(--c-text2)' }} title={c.topModel || ''}>
        {c.topModel || ''}
      </td>
      <td className="py-2 px-3 text-[12px]">
        {c.bubbleCount >= 500 ? (
          <span className="inline-flex items-center gap-0.5 font-bold" style={{ color: '#ef4444' }}>
            <AlertTriangle size={9} />{c.bubbleCount}
          </span>
        ) : c.bubbleCount >= 200 ? (
          <span className="inline-flex items-center gap-0.5 font-bold" style={{ color: '#f59e0b' }}>
            <AlertTriangle size={9} />{c.bubbleCount}
          </span>
        ) : (
          <span style={{ color: 'var(--c-text3)' }}>{c.bubbleCount || 0}</span>
        )}
      </td>
      <td className="py-2 px-3 text-[12px] font-mono text-right" style={{ color: c.cost > 0 ? 'var(--c-text2)' : 'var(--c-text3)' }}>
        {/* costPartial: the session used a model with no price, so this number omits part
            of itself. The API has carried the flag since 0.4.6 and nothing rendered it. */}
        {c.cost > 0 ? <span title={c.costPartial ? 'partial — this session used a model with no price' : undefined}>{formatCost(c.cost)}{c.costPartial ? '*' : ''}</span> : ''}
      </td>
      <td className="py-2 px-3 text-[12px] whitespace-nowrap" style={{ color: 'var(--c-text3)' }}>
        {formatDate(c.lastUpdatedAt || c.createdAt)}
      </td>
    </tr>
  )

  return (
    <div className="fade-in space-y-3">
      <PageHeader icon={List} title="Sessions" />

      {/* KPIs */}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))' }}>
        <KpiCard label="sessions" value={formatNumber(filtered.length)} sub={filtered.length !== total ? `of ${formatNumber(total)}` : ''} />
        <KpiCard label="projects" value={stats.projectCount} />
        <KpiCard label="editors" value={stats.editorEntries.length} />
        <KpiCard label="models" value={stats.modelEntries.length} />
        {(stats.bloatCount + stats.largeCount) > 0 && (
          <KpiCard label="large context" value={stats.bloatCount + stats.largeCount} sub={stats.bloatCount > 0 ? `${stats.bloatCount} bloated` : ''} />
        )}
      </div>

      {/* Summary charts */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="card p-3">
            <SectionTitle>editors</SectionTitle>
            <div style={{ height: 140 }}>
              <Doughnut
                data={{
                  labels: stats.editorEntries.map(e => editorLabel(e[0])),
                  datasets: [{ data: stats.editorEntries.map(e => e[1]), backgroundColor: stats.editorEntries.map(e => editorColor(e[0])), borderWidth: 0 }],
                }}
                options={{
                  responsive: true, maintainAspectRatio: false, cutout: '60%',
                  plugins: {
                    legend: { position: 'right', labels: { color: legendColor, font: { size: 9, family: MONO }, usePointStyle: true, pointStyle: 'circle', padding: 6 } },
                    tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } },
                  },
                }}
              />
            </div>
          </div>
          <div className="card p-3">
            <SectionTitle>models</SectionTitle>
            <div style={{ height: 140 }}>
              {stats.modelEntries.length > 0 ? (
                <Doughnut
                  data={{
                    labels: stats.modelEntries.map(m => m[0]),
                    datasets: [{ data: stats.modelEntries.map(m => m[1]), backgroundColor: MODEL_COLORS, borderWidth: 0 }],
                  }}
                  options={{
                    responsive: true, maintainAspectRatio: false, cutout: '60%',
                    plugins: {
                      legend: { position: 'right', labels: { color: legendColor, font: { size: 9, family: MONO }, usePointStyle: true, pointStyle: 'circle', padding: 6 } },
                      tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } },
                    },
                  }}
                />
              ) : <div className="text-[11px] py-8 text-center" style={{ color: 'var(--c-text3)' }}>no model data</div>}
            </div>
          </div>
          <div className="card p-3">
            <SectionTitle>modes</SectionTitle>
            <div style={{ height: 140 }}>
              {stats.modeEntries.length > 0 ? (
                <Bar
                  data={{
                    labels: stats.modeEntries.map(m => m[0] || 'unknown'),
                    datasets: [{
                      data: stats.modeEntries.map(m => m[1]),
                      backgroundColor: '#6366f1',
                      borderRadius: 3,
                    }],
                  }}
                  options={{
                    responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                    scales: {
                      x: { grid: { color: gridColor }, ticks: { color: txtDim, font: { size: 8, family: MONO } } },
                      y: { grid: { display: false }, ticks: { color: legendColor, font: { size: 9, family: MONO } } },
                    },
                    plugins: { legend: { display: false }, tooltip: { bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } } },
                  }}
                />
              ) : <div className="text-[11px] py-8 text-center" style={{ color: 'var(--c-text3)' }}>no mode data</div>}
            </div>
          </div>
        </div>
      )}

      {/* Timeline chart */}
      {timelineChart && timelineChart.labels.length > 1 && (
        <div className="card p-3">
          <div className="flex items-center justify-between mb-2">
            <SectionTitle>
              session timeline
              <span className="ml-2 font-normal text-[10px]" style={{ color: 'var(--c-text3)' }}>(drag to select range)</span>
            </SectionTitle>
            {dateRange && (
              <button
                onClick={() => setDateRange(null)}
                className="flex items-center gap-1 text-[11px] px-2 py-0.5 transition"
                style={{ color: 'var(--c-accent)', border: '1px solid var(--c-border)' }}
              >
                <X size={10} />
                {dateRange[0]} — {dateRange[1]}
              </button>
            )}
          </div>
          <div style={{ height: 160 }}>
            <Line
              ref={chartRef}
              data={timelineChart}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove', 'mousedown', 'mouseup'],
                _onRangeSelect: onRangeSelect,
                _selectionRange: dateRange,
                scales: {
                  x: { grid: { display: false }, ticks: { color: txtDim, font: { size: 9, family: MONO }, maxTicksLimit: 20, maxRotation: 0 } },
                  y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: txtDim, stepSize: 1, font: { size: 9, family: MONO } } },
                },
                plugins: {
                  legend: { position: 'top', labels: { color: legendColor, font: { size: 9, family: MONO }, usePointStyle: true, pointStyle: 'circle', padding: 10 } },
                  tooltip: { position: 'belowCursor', bodyFont: { family: MONO, size: 10 }, titleFont: { family: MONO, size: 10 } },
                },
              }}
            />
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2">
          <select
            value={editor}
            onChange={e => setEditor(e.target.value)}
            className="px-2 py-1 text-[12px] outline-none"
            style={{ background: 'var(--c-bg3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
          >
            <option value="">All Editors</option>
            {editors.map(e => (
              <option key={e.id} value={e.id}>{editorLabel(e.id)} ({e.count})</option>
            ))}
          </select>
          <div className="relative flex-1 max-w-sm">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--c-text3)' }} />
            <input
              type="text"
              placeholder="Search sessions..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-7 pr-3 py-1 text-[12px] outline-none"
              style={{ background: 'var(--c-bg3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
            />
          </div>
          <button
            onClick={() => setGroupByProject(!groupByProject)}
            className="flex items-center gap-1.5 px-3 py-1 text-[12px] transition"
            style={{
              border: groupByProject ? '1px solid var(--c-accent)' : '1px solid var(--c-border)',
              color: groupByProject ? 'var(--c-accent)' : 'var(--c-text2)',
              background: groupByProject ? 'rgba(99,102,241,0.1)' : 'transparent',
            }}
          >
            {groupByProject ? <FolderOpen size={13} /> : <List size={13} />}
            {groupByProject ? 'grouped' : 'flat'}
          </button>
          <span className="text-[11px]" style={{ color: 'var(--c-text3)' }}>
            {loading ? 'loading...' : `${filtered.length} of ${total}`}
          </span>
        {/* Server-side date range filter */}
        <div className="ml-auto"><DateRangePicker value={apiDateRange} onChange={setApiDateRange} /></div>
      </div>

      {/* Session table */}
      {!groupByProject ? (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider" style={{ borderBottom: '1px solid var(--c-border)', color: 'var(--c-text3)' }}>
                <th className="text-left py-2 px-3 font-medium">editor</th>
                <th className="text-left py-2 px-3 font-medium">name</th>
                <th className="text-left py-2 px-3 font-medium">project</th>
                <th className="text-left py-2 px-3 font-medium">mode</th>
                <th className="text-left py-2 px-3 font-medium">model</th>
                <th className="text-left py-2 px-3 font-medium">context</th>
                <th className="text-right py-2 px-3 font-medium">est. cost</th>
                <th className="text-left py-2 px-3 font-medium">updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => <SessionRow key={c.id} c={c} />)}
            </tbody>
          </table>
          {filtered.length === 0 && !loading && (
            <div className="text-center py-12 text-sm" style={{ color: 'var(--c-text3)' }}>no sessions found</div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {grouped.map(g => {
            const isCollapsed = collapsedProjects.has(g.folder)
            const editorSet = [...new Set(g.items.map(c => c.source).filter(Boolean))]
            return (
              <div key={g.folder} className="card overflow-hidden">
                <div
                  className="flex items-center gap-2 px-4 py-2.5 cursor-pointer transition"
                  onClick={() => toggleProject(g.folder)}
                >
                  {isCollapsed ? <ChevronRight size={13} style={{ color: 'var(--c-text3)' }} /> : <ChevronDown size={13} style={{ color: 'var(--c-text3)' }} />}
                  <FolderOpen size={13} style={{ color: 'var(--c-text3)' }} />
                  <span className="text-xs font-medium" style={{ color: 'var(--c-white)' }}>{g.name}</span>
                  <span className="text-[11px] truncate max-w-[300px]" style={{ color: 'var(--c-text3)' }}>{g.folder !== g.name && g.folder !== '(no project)' ? g.folder : ''}</span>
                  <span className="ml-auto flex items-center gap-2">
                    {editorSet.slice(0, 5).map(e => (
                      <span key={e} className="w-2 h-2 rounded-full" style={{ background: editorColor(e) }} title={editorLabel(e)} />
                    ))}
                    <span className="text-[11px]" style={{ color: 'var(--c-text3)' }}>{g.items.length}</span>
                  </span>
                </div>
                {!isCollapsed && (
                  <table className="w-full text-sm">
                    <tbody>
                      {g.items.map(c => <SessionRow key={c.id} c={c} />)}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
          {grouped.length === 0 && !loading && (
            <div className="text-center py-12 text-sm" style={{ color: 'var(--c-text3)' }}>no sessions found</div>
          )}
        </div>
      )}

      {/* Chat sidebar */}
      <ChatSidebar chatId={selectedChatId} onClose={() => setSelectedChatId(null)} />
    </div>
  )
}
