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

// Bundled packages that genuinely ship no license file, each with its declared license
// and why it may be listed without a text. Any other package without one fails the build.
// Empty today: every bundled package ships its license file.
//   'name': { license: 'MIT', reason: 'one line: why there is no file, and what was checked' },
export const NO_LICENSE_FILE = {}

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
      // Keyed by INSTALL DIRECTORY, not by name: two versions of one package can both be
      // bundled (a nested copy beside the top-level one), and each carries its own license.
      const found = new Map() // dir -> name
      for (const out of Object.values(bundle)) {
        if (out.type !== 'chunk') continue
        for (const id of Object.keys(out.modules || {})) {
          const p = packageOf(id)
          if (p && !found.has(p.dir)) found.set(p.dir, p.name)
        }
      }
      for (const name of extra) {
        const dir = path.join(root, 'node_modules', name).split(path.sep).join('/')
        if (!found.has(dir) && fs.existsSync(dir)) found.set(dir, name)
      }
      // One entry per name@version; two install dirs holding the same version are one notice.
      const entries = new Map()
      for (const [dir, name] of found) {
        const info = readPackage(dir)
        const key = `${name}@${info.version}`
        if (!entries.has(key)) entries.set(key, { name, ...info })
      }
      const list = [...entries.values()].sort((a, b) => (a.name === b.name
        ? a.version.localeCompare(b.version, undefined, { numeric: true })
        : (a.name < b.name ? -1 : 1)))
      // A bundled package whose license text cannot be shipped fails the build. A notice
      // file that silently omits one is the defect this plugin exists to prevent. The only
      // exceptions are packages that genuinely ship no license file, named in
      // NO_LICENSE_FILE with their declared license and the reason.
      const missing = list.filter((e) => !e.texts.length && !NO_LICENSE_FILE[e.name])
      if (missing.length) {
        this.error(`bundled without a license text: ${missing.map((e) => `${e.name}@${e.version} (declares ${e.license})`).join(', ')}. `
          + 'Add the license text, or list the package in NO_LICENSE_FILE (ui/third-party-notices.js) with its declared license and why.')
      }
      const blocks = list.map((e) => {
        const allowed = NO_LICENSE_FILE[e.name]
        const head = `${e.name}${e.version ? ` ${e.version}` : ''} — ${e.license}${e.repo ? `\n${e.repo}` : ''}`
        const body = e.texts.length
          ? e.texts.map((t) => (e.texts.length > 1 ? `[${t.file}]\n${t.text}` : t.text)).join('\n\n')
          : `(this package ships no license file; declared license: ${allowed.license}. ${allowed.reason})`
        return `${'='.repeat(72)}\n${head}\n${'-'.repeat(72)}\n${body}\n`
      })
      const source = [
        'memhouse dashboard — third-party software included in this directory (public/)',
        '',
        'The built dashboard bundles the packages below. Each is listed with its version,',
        'its declared license, and the license text it ships. Generated at build time by',
        'ui/third-party-notices.js from the bundle\'s module graph.',
        '',
        `${list.length} packages.`,
        '',
        ...blocks,
      ].join('\n')
      this.emitFile({ type: 'asset', fileName, source })
    },
  }
}
