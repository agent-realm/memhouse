/* global process */
// Writes THIRD_PARTY_NOTICES.txt beside the built dashboard (public/), listing every
// third-party package whose code ends up in the bundle, with its license text.
//
// Why: the bundle carries React, chart.js, lucide, react-markdown and others, all under
// licenses (MIT, ISC, …) whose one condition is that the notice travels with every copy.
// Vite strips their license comments when it minifies, so the published package shipped
// those copies with no notice at all. This plugin reads the bundle's own module graph, so
// the list is exactly what was bundled, never a hand-kept list that drifts.
//
// No dependency of its own on purpose: it reads each package's package.json and license
// file straight off node_modules.
import fs from 'node:fs'
import path from 'node:path'

const LICENSE_FILE = /^(licen[sc]e|copying|notice)([.-].*)?$/i

// '/abs/ui/node_modules/react-dom/cjs/x.js' -> { name: 'react-dom', dir: '/abs/ui/node_modules/react-dom' }
// The LAST node_modules segment wins, so a nested copy is attributed to itself.
export function packageOf(id) {
  const clean = String(id).replace(/^\0/, '').split('?')[0].split(path.sep).join('/')
  const i = clean.lastIndexOf('/node_modules/')
  if (i < 0) return null
  const parts = clean.slice(i + '/node_modules/'.length).split('/')
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
  if (!name || name.startsWith('.')) return null
  return { name, dir: clean.slice(0, i + '/node_modules/'.length) + name }
}

function readPackage(dir) {
  let pkg = {}
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) } catch { /* no manifest */ }
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort() } catch { /* unreadable dir */ }
  const texts = files.map((f) => {
    try { return { file: f, text: fs.readFileSync(path.join(dir, f), 'utf-8').trim() } } catch { return null }
  }).filter(Boolean)
  const license = typeof pkg.license === 'string' ? pkg.license
    : (pkg.license && pkg.license.type) || (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type || l).join(' OR ') : '')
  const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository && pkg.repository.url) || pkg.homepage || ''
  return { version: pkg.version || '', license: license || 'UNKNOWN', repo, texts }
}

/**
 * @param {object} [o]
 * @param {string} [o.fileName]  where the notices land, relative to outDir
 * @param {string[]} [o.extra]   packages that reach the bundle without showing up as a JS
 *                               module: tailwindcss (its preflight CSS is in the stylesheet),
 *                               react-router-dom (it only re-exports react-router, so the
 *                               graph holds react-router's modules, not its own)
 * @param {string} [o.root]      where to resolve `extra` from (the ui/ directory)
 */
export default function thirdPartyNotices({ fileName = 'THIRD_PARTY_NOTICES.txt', extra = [], root = process.cwd() } = {}) {
  return {
    name: 'memhouse-third-party-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const found = new Map()
      for (const out of Object.values(bundle)) {
        if (out.type !== 'chunk') continue
        for (const id of Object.keys(out.modules || {})) {
          const p = packageOf(id)
          if (p && !found.has(p.name)) found.set(p.name, p.dir)
        }
      }
      for (const name of extra) {
        const dir = path.join(root, 'node_modules', name)
        if (!found.has(name) && fs.existsSync(dir)) found.set(name, dir)
      }
      const names = [...found.keys()].sort()
      const missing = []
      const blocks = names.map((name) => {
        const info = readPackage(found.get(name))
        if (!info.texts.length) missing.push(name)
        const head = `${name}${info.version ? ` ${info.version}` : ''} — ${info.license}${info.repo ? `\n${info.repo}` : ''}`
        const body = info.texts.length
          ? info.texts.map((t) => (info.texts.length > 1 ? `[${t.file}]\n${t.text}` : t.text)).join('\n\n')
          : `(this package ships no license file; its package.json declares: ${info.license})`
        return `${'='.repeat(72)}\n${head}\n${'-'.repeat(72)}\n${body}\n`
      })
      if (missing.length) this.warn(`no license file in: ${missing.join(', ')} — listed with their declared license only`)
      const source = [
        'memhouse dashboard — third-party software included in this directory (public/)',
        '',
        'The built dashboard bundles the packages below. Each is listed with its version,',
        'its declared license, and the license text it ships. Generated at build time by',
        'ui/third-party-notices.js from the bundle\'s module graph.',
        '',
        `${names.length} packages.`,
        '',
        ...blocks,
      ].join('\n')
      this.emitFile({ type: 'asset', fileName, source })
    },
  }
}
