import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(process.argv[2] ?? '.')
const errors = []
const text = async path => readFile(join(root, path), 'utf8')

let pkg
try { pkg = JSON.parse(await text('package.json')) } catch (error) { errors.push(`package.json: ${String(error)}`) }

if (pkg) {
  if (pkg.type !== 'module') errors.push('package.json: type must be module')
  if (!pkg.main) errors.push('package.json: main is required')
  if (!pkg.exports?.['.']) errors.push('package.json: exports[.] is required')
  const hasClientMeta = pkg.dsh?.client !== undefined
  const hasClientExport = pkg.exports?.['./client'] !== undefined
  if (hasClientMeta !== hasClientExport) errors.push('package.json: dsh.client and ./client export must appear together')
  if (pkg.dsh?.bundle?.patch && pkg.exports?.['./cordis.patch.yml'] === undefined) {
    errors.push('package.json: Bundle patch should be exported')
  }
}

try {
  const source = await text('src/index.ts')
  if (/from ['"](?:cordis|schemastery)['"]/.test(source)) errors.push('src/index.ts: use @deepseek-ai scoped imports')
  const hasDefault = /export\s+default/.test(source)
  const hasApply = /export\s+(?:async\s+)?function\s+apply/.test(source)
  if (hasDefault && hasApply) errors.push('src/index.ts: do not mix default Service export and function-plugin apply export')
  if (hasApply && !/export\s+const\s+name/.test(source)) errors.push('src/index.ts: function plugin should export name')
} catch (error) { errors.push(`src/index.ts: ${String(error)}`) }

if (pkg?.dsh?.bundle?.patch) {
  try {
    const patch = await text(pkg.dsh.bundle.patch.replace(/^\.\//, ''))
    if (!/^\s*-\s+(?:insert:|id:)/m.test(patch)) errors.push('cordis patch: expected top-level YAML array')
    if (!patch.includes(pkg.name)) errors.push('cordis patch: package name not found; verify row name')
  } catch (error) { errors.push(`cordis patch: ${String(error)}`) }
}

async function walk(dir) {
  for (const name of await readdir(dir)) {
    if (name === 'node_modules' || name === 'lib' || name === '.git') continue
    const path = join(dir, name)
    const info = await stat(path)
    if (info.isDirectory()) {
      // Reference checkouts are pinned, read-only upstream evidence. Validate the
      // wrapper metadata, but never impose this project's formatting on upstream.
      if (name === 'source' && resolve(dir).startsWith(resolve(root, 'ref'))) continue
      await walk(path)
    }
    else if (/\.(ts|tsx|md|json|ya?ml|mjs)$/.test(name)) {
      const content = await readFile(path, 'utf8')
      if (content.includes('\uFFFD')) errors.push(`${path}: invalid UTF-8 replacement character`)
      if (!content.endsWith('\n')) errors.push(`${path}: missing final newline`)
    }
  }
}
await walk(root)

if (errors.length) {
  console.error('DSH plugin verification failed:')
  errors.forEach(error => console.error(`- ${error}`))
  process.exitCode = 1
} else {
  console.log('DSH plugin structural verification: PASS')
}
