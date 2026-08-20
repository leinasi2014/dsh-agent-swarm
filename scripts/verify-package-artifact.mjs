import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const failures = []

for (const [label, relativePath] of [
  ['main', pkg.main],
  ['types', pkg.types],
  ['exports[.].default', pkg.exports?.['.']?.default],
  ['exports[.].types', pkg.exports?.['.']?.types],
  ['bundle patch', pkg.dsh?.bundle?.patch],
]) {
  if (typeof relativePath !== 'string') {
    failures.push(`${label}: missing path`)
    continue
  }
  try {
    await access(resolve(root, relativePath))
  } catch {
    failures.push(`${label}: target does not exist: ${relativePath}`)
  }
}

if (failures.length === 0) {
  try {
    const entry = await import(pathToFileURL(resolve(root, pkg.main)).href)
    if (typeof entry.apply !== 'function') failures.push('built entry: function plugin must export apply')
    if (typeof entry.name !== 'string') failures.push('built entry: function plugin must export name')
    if (typeof entry.AgentSwarmRuntime !== 'function') failures.push('built entry: missing AgentSwarmRuntime service export')
    if (typeof entry.TeamId !== 'function') failures.push('built entry: missing branded TeamId constructor')
  } catch (error) {
    failures.push(`built entry cannot be imported: ${String(error)}`)
  }
}

if (failures.length > 0) {
  console.error('Package artifact verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('Package entry, types, bundle patch, and runtime import: PASS')
}
