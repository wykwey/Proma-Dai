import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'

const root = process.cwd()

// ---- collect all declared top-level deps from every package.json ----
const pkgFiles = []
// root
if (existsSync(join(root, 'package.json'))) pkgFiles.push(join(root, 'package.json'))
// packages and apps
for (const top of ['packages', 'apps']) {
  const dir = join(root, top)
  if (!existsSync(dir)) continue
  for (const sub of readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory())) {
    const f = join(dir, sub, 'package.json')
    if (existsSync(f)) pkgFiles.push(f)
    // cli/electron may have nested scripts but no package.json there that matters
  }
}

const declaredExact = new Set()
for (const f of pkgFiles) {
  const p = JSON.parse(readFileSync(f, 'utf8'))
  for (const k of Object.keys(p.dependencies || {})) declaredExact.add(k)
  for (const k of Object.keys(p.devDependencies || {})) declaredExact.add(k)
  for (const k of Object.keys(p.peerDependencies || {})) declaredExact.add(k)
}

// loose key: for @scope/pkg -> "@scope/pkg"; for pkg/sub -> "pkg"
const key = (n) => (n.startsWith('@') ? n.split('/').slice(0, 2).join('/') : n.split('/')[0])

// ---- scan source imports ----
const srcDirs = []
for (const dir of [
  'apps/electron/src',
  'apps/cli/src',
  'packages/core',
  'packages/shared',
  'packages/ui',
  'packages/session-core',
]) {
  if (existsSync(join(root, dir))) srcDirs.push(join(root, dir))
}
const importLoose = new Set()
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'out', '.git', 'evals', 'scripts'].includes(e.name)) continue
      walk(p)
    } else if (/\.(ts|tsx|mjs|js|jsx)$/.test(e.name)) {
      const c = readFileSync(p, 'utf8')
      const reModules =
        /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+["'])([^"'\s,)(;]+)/g
      let m
      while ((m = reModules.exec(c))) {
        let bare = m[1]
        if (bare.startsWith('.') || bare.startsWith('/') || bare.startsWith('node:')) continue
        bare = bare.replace(/['"]$/, '')
        if (bare.startsWith('@')) importLoose.add(bare.split('/').slice(0, 2).join('/'))
        else importLoose.add(bare.split('/')[0])
      }
    }
  }
}
for (const d of srcDirs) if (existsSync(d)) walk(d)

// ---- result 1: declared but not imported in src ----
const declaredNotImported = [...declaredExact]
  .filter((n) => !importLoose.has(key(n)))
  .sort()

// ---- result 2: installed top-level dirs in node_modules not declared ----
const nm = join(root, 'node_modules')
const installedScoped = []
for (const n of readdirSync(nm).filter((x) => !x.startsWith('.'))) {
  if (n.startsWith('@')) {
    for (const sub of readdirSync(join(nm, n))) installedScoped.push(`${n}/${sub}`)
  } else installedScoped.push(n)
}
const orphan = installedScoped.filter((n) => !declaredExact.has(n)).sort()
const orphanLoose = orphan.filter((n) => !importLoose.has(key(n)))

console.log('\n===== 1) declared in package.json but never imported in src =====')
console.log(declaredNotImported.length ? declaredNotImported.join('\n') : '(none)')

console.log('\n===== 2) installed in node_modules top but NOT declared in ANY package.json =====')
console.log(orphan.length ? orphan.join('\n') : '(none)')

console.log('\n===== 3) of those orphans, also never imported in src (true orphans) =====')
console.log(orphanLoose.length ? orphanLoose.join('\n') : '(none)')
