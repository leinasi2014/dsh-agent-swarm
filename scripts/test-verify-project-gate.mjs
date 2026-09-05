/** Exercise the actual verifier CLI and filesystem walk at the source boundary. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = await mkdtemp(join(tmpdir(), 'dsh-source-size-gate-'))
try {
  // Copy the verifier's normal input surface, not an alternative implementation.
  // No checkout, dependency, build output or live state is part of this fixture.
  const directories = new Set(['src', 'scripts', 'tests', 'docs', '.agents', '.github', 'ref'])
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git' || (entry.isDirectory() && !directories.has(entry.name))) continue
    await cp(join(root, entry.name), join(fixture, entry.name), {
      recursive: true,
      filter: path => !['node_modules', 'source', 'official-evidence'].includes(basename(path)),
    })
  }
  const files = ['src', 'scripts', 'tests'].flatMap(directory => ['ts', 'tsx'].map(extension => `${directory}/nested/size-fixture.${extension}`))
  const source = lines => '// size boundary fixture\n'.repeat(lines - 1)
  const run = () => spawnSync(process.execPath, [join(fixture, 'scripts/verify-project.mjs')], {
    cwd: fixture, encoding: 'utf8', windowsHide: true,
  })
  for (const file of files) {
    await mkdir(join(fixture, file, '..'), { recursive: true })
    await writeFile(join(fixture, file), source(600))
  }
  const baseline = run()
  assert.equal(baseline.status, 0, `600-line TS/TSX fixtures must pass the real CLI: ${baseline.stderr}`)
  for (const file of files) {
    await writeFile(join(fixture, file), source(601))
    const rejected = run()
    assert.equal(rejected.status, 1, `601-line ${file} must fail the real CLI`)
    assert.ok(rejected.stderr.includes(`${file}: 601 lines exceeds the 600-line source limit`), rejected.stderr)
    await writeFile(join(fixture, file), source(600))
  }
  console.log('Source size CLI fixtures: 600/601 lines across src/scripts/tests TS and TSX: PASS')
} finally {
  await rm(fixture, { recursive: true, force: true })
}
