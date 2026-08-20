import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const cwd = process.cwd()
console.log(`cwd=${cwd}`)
console.log(`node=${process.version}`)
console.log(`platform=${process.platform}/${process.arch}`)

for (const file of ['package.json', 'cordis.patch.yml', 'AGENTS.md']) {
  console.log(`${file}=${existsSync(resolve(cwd, file)) ? 'present' : 'missing'}`)
}

try {
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'))
  console.log(`package=${pkg.name ?? '(unnamed)'}@${pkg.version ?? '(unversioned)'}`)
  console.log(`bundlePatch=${pkg.dsh?.bundle?.patch ?? '(none)'}`)
  console.log(`client=${pkg.dsh?.client ? 'yes' : 'no'}`)
} catch (error) {
  console.log(`packageError=${String(error)}`)
}

for (const spec of ['@deepseek-ai/cordis/package.json', '@deepseek-ai/dsh-tools/package.json', '@deepseek-ai/dsh/package.json']) {
  try {
    const url = import.meta.resolve(spec)
    const pkg = JSON.parse(readFileSync(new URL(url), 'utf8'))
    console.log(`${spec}=${pkg.version}`)
  } catch {
    console.log(`${spec}=not-resolved`)
  }
}
