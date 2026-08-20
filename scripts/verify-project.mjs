import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = fileURLToPath(new URL('..', import.meta.url))
const execFileAsync = promisify(execFile)
const required = [
  'README.md',
  'CONTRIBUTING.md',
  'package.json',
  'cordis.patch.yml',
  'src/index.ts',
  'src/domain/team-domain-port.ts',
  'src/storage/storage-domain-team-store.ts',
  'src/storage/team-spec.ts',
  'src/storage/team-store.ts',
  'src/migration/migrate-legacy-store.ts',
  'scripts/migrate-legacy-team-store.mjs',
  'tests/team-domain-port.spec.ts',
  'tests/migration.spec.ts',
  'tests/helpers/storage-stack.ts',
  'docs/00-vision.md',
  'docs/03-capability-family.md',
  'docs/09-sources.md',
  'docs/10-fusion-audit.md',
  'docs/11-official-first-development.md',
  'docs/12-independent-review-management.md',
  'docs/13-self-hosting-dogfood.md',
  'docs/OFFICIAL_BASELINE.json',
  'docs/adr/0005-official-first-pure-plugin-integration.md',
  'docs/adr/0006-independent-reviewer-autonomy.md',
  'docs/adr/0007-m1-storage-authority-and-remediation-order.md',
  'docs/adr/0008-self-hosting-dogfood-control-plane.md',
  'scripts/verify-official-baseline.mjs',
  'scripts/verify-reference-baselines.mjs',
  'scripts/sync-official-evidence.ps1',
  'ref/dsh-agent-teams/SOURCE_POINTER.json',
  'ref/dsh-agent-teams/sync-reference.ps1',
  'ref/jiuwenswarm/SOURCE_POINTER.json',
  'ref/jiuwenswarm/sync-reference.ps1',
  '.agents/skills/dsh-plugin-development/SKILL.md',
  '.gitattributes',
  '.editorconfig',
  '.oxlintrc.json',
  '.jscpd.json',
  'knip.json',
  'lefthook.yml',
  '.github/workflows/verify.yml',
  'src/runtime/authority.ts',
  'src/runtime/providers.ts',
  'src/runtime/prompts.ts',
  'src/runtime/usage-accounting.ts',
  'src/runtime/message-delivery.ts',
  'src/runtime/member-provisioning.ts',
]

// Engineering guardrail: one source file may not exceed this line count
// unless an exception below records why and which milestone retires it.
const SRC_FILE_LINE_LIMIT = 600
const SRC_FILE_LINE_LIMIT_EXCEPTIONS = new Map([
  ['src/domain/team-domain.ts', {
    reason: 'protocol core (roster/task/mailbox/budget/memory in one aggregate); splits with the M1B mailbox-retention restructuring',
    due: 'M1B',
  }],
])

const failures = []
for (const item of required) {
  try {
    if (!(await stat(join(root, item))).isFile()) failures.push(`${item}: not a file`)
  } catch {
    failures.push(`${item}: missing`)
  }
}

try {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (pkg.name !== 'dsh-agent-swarm') failures.push('package.json: unexpected package name')
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') failures.push('package.json: missing dsh.bundle.patch')
  if (pkg.type !== 'module') failures.push('package.json: ESM type is required')
  if (typeof pkg.packageManager !== 'string' || !pkg.packageManager.startsWith('pnpm@')) failures.push('package.json: packageManager must pin a pnpm version')
  if (!String(pkg.scripts?.verify ?? '').includes('pnpm lint')) failures.push('package.json: verify chain must include the lint gate')
  if (!String(pkg.scripts?.verify ?? '').includes('pnpm verify:duplication')) failures.push('package.json: verify chain must include the duplication gate')
  if (!String(pkg.scripts?.verify ?? '').includes('pnpm verify:exports')) failures.push('package.json: verify chain must include the dead-export gate')
  if (pkg.files?.some(item => item === 'ref' || item.startsWith('ref/'))) failures.push('package.json: ref must not be published')
} catch (error) {
  failures.push(`package.json: ${String(error)}`)
}

for (const name of ['dsh-agent-teams', 'jiuwenswarm']) {
  try {
    const pointer = JSON.parse(await readFile(join(root, 'ref', name, 'SOURCE_POINTER.json'), 'utf8'))
    const source = join(root, 'ref', name, 'source')
    if (!(await stat(source)).isDirectory()) {
      failures.push(`ref/${name}/source: not a directory`)
      continue
    }
    const { stdout: head } = await execFileAsync('git', ['-C', source, 'rev-parse', 'HEAD'])
    if (head.trim() !== pointer.commit) failures.push(`ref/${name}: HEAD does not match SOURCE_POINTER.json`)
    const { stdout: dirty } = await execFileAsync('git', ['-C', source, 'status', '--porcelain'])
    if (dirty.trim() !== '') failures.push(`ref/${name}: source checkout is dirty`)
  } catch (error) {
    failures.push(`ref/${name}: ${String(error)}`)
  }
}

try {
  const skill = await readFile(join(root, '.agents/skills/dsh-plugin-development/SKILL.md'), 'utf8')
  if (!skill.startsWith('---\n')) failures.push('SKILL.md: missing YAML frontmatter')
  for (const section of ['执行流程', '理论模型', '验证矩阵', '失败处理']) {
    if (!skill.includes(section)) failures.push(`SKILL.md: missing section ${section}`)
  }
} catch (error) {
  failures.push(`SKILL.md: ${String(error)}`)
}

for (const [file, phrases] of [
  ['AGENTS.md', ['official-first', 'docs/11-official-first-development.md']],
  ['CLAUDE.md', ['official-first', 'pure plugins']],
  ['docs/07-implementation-roadmap.md', ['Gate A', 'Official-first']],
  ['docs/12-independent-review-management.md', ['Reviewer autonomy', 'Project-manager boundary']],
  ['docs/13-self-hosting-dogfood.md', ['stable control Profile', 'acceptance Profile', 'ADR-0008']],
  ['.agents/skills/dsh-plugin-development/SKILL.md', ['official-first compatibility gate', 'docs/11-official-first-development.md']],
]) {
  try {
    const content = await readFile(join(root, file), 'utf8')
    for (const phrase of phrases) {
      if (!content.includes(phrase)) failures.push(`${file}: missing mandatory governance phrase ${phrase}`)
    }
  } catch (error) {
    failures.push(`${file}: ${String(error)}`)
  }
}

async function walk(dir) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    const info = await stat(path)
    if (info.isDirectory()) {
      if (name === 'node_modules' || name === 'lib' || name === 'source' || name === 'official-evidence') continue
      await walk(path)
      continue
    }
    const rel = relative(root, path).replaceAll('\\', '/')
    if (/^(src|scripts|tests)\/.*\.ts$/.test(rel)) {
      const content = await readFile(path, 'utf8')
      const lines = content.split('\n').length
      const exception = SRC_FILE_LINE_LIMIT_EXCEPTIONS.get(rel)
      if (lines > SRC_FILE_LINE_LIMIT && exception === undefined) {
        failures.push(`${rel}: ${lines} lines exceeds the ${SRC_FILE_LINE_LIMIT}-line source limit; split it or register a reasoned exception`)
      }
    }
    if (!/\.(md|json|ya?ml|ts|mjs|ps1|sh)$/.test(name)) continue
    const content = await readFile(path, 'utf8')
    if (content.includes('\uFFFD')) failures.push(`${rel}: invalid UTF-8 replacement character`)
    if (!content.endsWith('\n')) failures.push(`${rel}: missing final newline`)
  }
}
await walk(root)

if (failures.length > 0) {
  console.error('Project verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('Project structure, pinned clean references, manifests, engineering gates, source size limits, UTF-8, and trailing newlines: PASS')
}
