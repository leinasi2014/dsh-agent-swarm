import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
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
  'docs/13-self-hosting-dogfood.md',
  'docs/governance/adoption-manifest-v1.yaml',
  'docs/governance/project-binding.yaml',
  'docs/governance/document-registry.yaml',
  'docs/GOALS.md',
  'docs/OFFICIAL_BASELINE.json',
  'docs/adr/0005-official-first-pure-plugin-integration.md',
  'docs/adr/0006-independent-reviewer-autonomy.md',
  'docs/adr/0007-m1-storage-authority-and-remediation-order.md',
  'docs/adr/0008-self-hosting-dogfood-control-plane.md',
  'scripts/verify-official-baseline.mjs',
  'scripts/verify-reference-baselines.mjs',
  'scripts/merge-guard.mjs',
  'scripts/verify-worktree-layout.mjs',
  'scripts/verify-isolation-status.mjs',
  'scripts/verify-governance.mjs',
  'scripts/test-governance-gate.mjs',
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
  '.github/workflows/policy.yml',
  '.github/workflows/isolation.yml',
  '.github/workflows/compatibility.yml',
  'src/runtime/authority.ts',
  'src/runtime/providers.ts',
  'src/runtime/prompts.ts',
  'src/runtime/usage-accounting.ts',
  'src/runtime/message-delivery.ts',
  'src/runtime/member-provisioning.ts',
]

// Engineering guardrail: one source file may not exceed this line count
// unless an exception below records why and which milestone retires it.
// The registry is currently empty: every source file is within the limit.
const SRC_FILE_LINE_LIMIT = 600
// Reasoned exceptions: `[reason, retiring milestone]`. Each entry is debt with
// an owner and a deadline — the reason must name what pushed the file over and
// the milestone whose work splits it back under the limit.
const SRC_FILE_LINE_LIMIT_EXCEPTIONS = new Map([
  // M3-1 (issue #100) wired the execution-root lifecycle into the composition
  // root (claim/submit/review/reassign/remove/archive integration points, the
  // Provider registry passthrough and the disposal settle). The generic
  // manager already lives in `execution-roots.ts` and the claim/sweep/scan
  // integration in `execution-root-surface.ts`; what remains in the runtime
  // is the minimal call-site wiring over a file that sat at 599/600. Retired
  // by M3-2: the tool-facing read surfaces (`waitForChange`,
  // `activePeerEvidence`) move to a wait-surface collaborator, returning the
  // file under the limit.
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
  const verify = String(pkg.scripts?.verify ?? '')
  const candidate = String(pkg.scripts?.['verify:candidate'] ?? '')
  const engineering = String(pkg.scripts?.['verify:engineering'] ?? '')
  if (!verify.includes('pnpm verify:candidate')) failures.push('package.json: verify must route to the candidate gate')
  if (!candidate.includes('pnpm verify:engineering')) failures.push('package.json: candidate gate must route to the engineering gate')
  for (const [script, label] of [
    ['pnpm verify:structure', 'structure'],
    ['pnpm lint', 'lint'],
    ['pnpm verify:duplication', 'duplication'],
    ['pnpm verify:exports', 'dead-export'],
    ['pnpm typecheck', 'typecheck'],
    ['pnpm typecheck:test', 'test-typecheck'],
    ['pnpm test', 'test'],
    ['pnpm verify:scenarios', 'scenario-audit'],
    ['pnpm build', 'build'],
    ['pnpm verify:artifact', 'artifact'],
  ]) {
    if (!engineering.includes(script)) failures.push(`package.json: engineering gate must include the ${label} gate`)
  }
  if (!String(pkg.scripts?.['verify:policy'] ?? '').includes('test-governance-gate.mjs')) failures.push('package.json: policy gate must keep its negative policy tests')
  if (!String(pkg.scripts?.['verify:policy:declared'] ?? '').includes('--skip-git')) failures.push('package.json: declared policy gate must skip authority-remote observation')
  if (!String(pkg.scripts?.['verify:isolation'] ?? '').includes('test-worktree-layout-gate.mjs')) failures.push('package.json: isolation gate must keep its negative policy tests')
  if (!String(pkg.scripts?.['verify:isolation:status'] ?? '').includes('verify-isolation-status.mjs')) failures.push('package.json: isolation status gate must remain independently callable')
  if (!String(pkg.scripts?.['verify:compatibility'] ?? '').includes('verify:references')) failures.push('package.json: compatibility gate must keep reference verification')
  if (pkg.files?.some(item => item === 'ref' || item.startsWith('ref/'))) failures.push('package.json: ref must not be published')
} catch (error) {
  failures.push(`package.json: ${String(error)}`)
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
  ['AGENTS.md', ['$manage-agile-software-development', 'docs/governance/project-binding.yaml', 'official DSH']],
  ['CLAUDE.md', ['$manage-agile-software-development', 'AGENTS.md']],
  ['docs/07-implementation-roadmap.md', ['Gate A', 'Official-first']],
  ['docs/13-self-hosting-dogfood.md', ['stable control Profile', 'acceptance Profile', 'ADR-0008']],
  ['docs/GOALS.md', ['产品目标', '稳定范围', '产品红线', '能力演进顺序', '章程变更']],
  ['.agents/skills/dsh-plugin-development/SKILL.md', ['official-first compatibility gate', 'docs/11-official-first-development.md']],
  ['docs/governance/project-binding.yaml', ['backend: single-checkout', 'parallelWriterCapability: NOT_CONFIGURED', 'exactCandidateExternalNonAuthorReview: required']],
  ['docs/governance/document-registry.yaml', ['documentId: project-binding', 'stableDocumentFirewall: enabled', 'accountableOwner:']],
  ['docs/governance/adoption-manifest-v1.yaml', ['inspectedBase: f465400b731f4593384c699a0c6fea08b9300be6', 'branchDeletion: forbidden-by-this-manifest']],
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
      if (name === '.worktree' || name === 'node_modules' || name === 'lib' || name === 'source' || name === 'official-evidence') continue
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
  console.log('Project structure, tracked reference pointers, manifests, routed gates, source size limits, UTF-8, and trailing newlines: PASS')
}
