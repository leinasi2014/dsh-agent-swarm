import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const rootIndex = args.indexOf('--root')
const root = realpathSync(rootIndex >= 0 ? resolve(args[rootIndex + 1]) : fileURLToPath(new URL('..', import.meta.url)))
const skipGit = args.includes('--skip-git')
const failures = []

const bindingPath = 'docs/governance/project-binding.yaml'
const registryPath = 'docs/governance/document-registry.yaml'
const adoptionManifestPath = 'docs/governance/adoption-manifest-v1.yaml'
const protectedLegacyPaths = [
  '.agents/skills/dsh-agent-swarm-operations/SKILL.md',
  'docs/12-independent-review-management.md',
  'docs/development/2026-08-23-code-quality-architecture-standard.md',
  'docs/development/2026-08-23-development-standard.md',
  'docs/governance/2026-08-23-development-governance-refactor.md',
  'docs/governance/2026-08-23-project-management-governance.md',
]
const requiredRecoveryEvidence = ['docs/development/2026-08-23-worktree-cleanup-ledger.md']
const legalRoles = new Set(['stable-authority', 'dynamic-authority', 'evidence', 'projection', 'reference'])

function projectPath(path) {
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return target
  failures.push(`${path}: path escapes the project root`)
  return undefined
}

function readRequired(path) {
  const target = projectPath(path)
  if (target === undefined || !existsSync(target)) {
    failures.push(`${path}: missing`)
    return ''
  }
  if (!lstatSync(target).isFile()) {
    failures.push(`${path}: not a file`)
    return ''
  }
  const real = realpathSync(target)
  const rel = relative(root, real)
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    failures.push(`${path}: resolves outside the project root`)
    return ''
  }
  return readFileSync(target, 'utf8')
}

function scalar(value) {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

// The project registry intentionally uses a restricted, line-oriented YAML
// profile. This parser is a project gate for that profile, not a general YAML parser.
function parseDocuments(registry) {
  const documents = []
  let current
  for (const line of registry.split(/\r?\n/u)) {
    const start = line.match(/^\s*-\s+documentId:\s*(.+?)\s*$/u)
    if (start) {
      if (current) documents.push(current)
      current = { documentId: scalar(start[1]) }
      continue
    }
    if (/^\S/u.test(line)) {
      if (current) documents.push(current)
      current = undefined
      continue
    }
    if (!current) continue
    const field = line.match(/^\s{4}(path|role|subject|writeMode|accountableOwner|mutationAuthority|updateTriggers|validation|sourceAuthority|refreshPolicy|expiryPolicy):\s*(.+?)\s*$/u)
    if (field) current[field[1]] = scalar(field[2])
  }
  if (current) documents.push(current)
  return documents
}

function validateThinAdapter(path, content, maxLines, requiredPhrases) {
  const lines = content.split(/\r?\n/u).length
  if (lines > maxLines) failures.push(`${path}: ${lines} lines exceeds thin-adapter limit ${maxLines}`)
  for (const phrase of requiredPhrases) {
    if (!content.includes(phrase)) failures.push(`${path}: missing required pointer ${phrase}`)
  }
  if (/\bgit\s+worktree\s+(?:add|remove|move|prune)\b/iu.test(content)) {
    failures.push(`${path}: raw worktree lifecycle command is forbidden`)
  }
}

function validateLinks(path, content) {
  const source = projectPath(path)
  if (!source) return
  const links = content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)
  for (const match of links) {
    let target = match[1].trim().replace(/^<|>$/g, '')
    if (target === '' || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue
    target = target.split('#', 1)[0].split('?', 1)[0]
    if (target === '') continue
    try {
      target = decodeURIComponent(target)
    } catch {
      failures.push(`${path}: malformed encoded link ${match[1]}`)
      continue
    }
    const absolute = resolve(dirname(source), target)
    const rel = relative(root, absolute)
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      failures.push(`${path}: link escapes project root: ${match[1]}`)
    } else if (!existsSync(absolute)) {
      failures.push(`${path}: broken local link: ${match[1]}`)
    }
  }
}

function remoteHasEmbeddedCredential(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    try {
      const url = new URL(value)
      if (url.username !== '' || url.password !== '') return true
    } catch {
      return true
    }
  }
  if (/^[^/@:\s]+@[^/\s:]+:/u.test(value)) return true
  return /[?&](?:access[_-]?token|token|api[_-]?key|password|secret)=/iu.test(value)
}

const binding = readRequired(bindingPath)
const registry = readRequired(registryPath)
const adoptionManifest = readRequired(adoptionManifestPath)

for (const phrase of [
  'name: manage-agile-software-development',
  'candidateSelfActivation: forbidden',
  'activation: reviewed-integration-and-result-readback',
  'integrationRef: refs/heads/main',
  'backend: git-worktree',
  'parallelWriterCapability: CONFIGURED',
  'allocationAuthority: git-common-dir/dsh-agent-swarm-isolation/v1/state.json',
  'lifecycleEntry: pnpm-isolation-open-status-close-reconcile',
  'rawLifecycleCommandsForbidden: true',
  'layoutGateDoesNotAuthorizeAllocation: true',
  'committedMarkdownAuthority: false',
  'alias: origin',
  'role: development-authority',
  '- alias: github',
  'readTarget: native',
  'candidateBoundChecks: adapter',
  'nonAuthorAcceptance: missing',
  'expectedTargetMutation: native',
  'readResult: native',
  'projectDirectionOwner: product-and-architecture-owner',
  'coordinationOwner: pipeline-capacity-and-integration-scheduler',
  'roleCombinationPolicy: risk-scaled',
  'candidateAndEvidenceAuthority: git-commit-plus-check-receipts',
  'integrationAuthority: expected-main-identity',
  'isolationStatus: pnpm-verify-isolation-status',
  'parallelWriter: managed-lifecycle-only',
]) {
  if (!binding.includes(phrase)) failures.push(`${bindingPath}: missing or changed declaration ${phrase}`)
}
const methodBlock = binding.match(/^method:\s*\r?\n((?:^[ \t].*(?:\r?\n|$))*)/mu)?.[1] ?? ''
if (!/^\s{2}policyDigest:\s+[0-9a-f]{40}\s*$/mu.test(methodBlock)) failures.push(`${bindingPath}: method policyDigest must be one lowercase 40-hex commit identity`)
if (/^\s{2}deliveryLane\s*:/mu.test(binding)) failures.push(`${bindingPath}: a project-global deliveryLane is forbidden; classify each Feature Pipeline`)
if (/candidateState\s*:/u.test(binding)) failures.push(`${bindingPath}: dynamic candidateState is forbidden in stable binding`)
if (/https?:\/\//iu.test(binding) || /[A-Za-z]:[\\/]/u.test(binding) || /\/(?:Users|home)\//u.test(binding)) {
  failures.push(`${bindingPath}: private URL or machine-local absolute path is forbidden`)
}

for (const path of protectedLegacyPaths) {
  const target = projectPath(path)
  if (target && existsSync(target)) failures.push(`${path}: superseded governance file must be deleted`)
}
for (const path of requiredRecoveryEvidence) readRequired(path)

for (const phrase of [
  'inspectedBase: f465400b731f4593384c699a0c6fea08b9300be6',
  'recoveryAuthority: git-object-at-inspected-base',
  'branchDeletion: forbidden-by-this-manifest',
  'exactCandidateExternalNonAuthorReview: required',
]) {
  if (!adoptionManifest.includes(phrase)) failures.push(`${adoptionManifestPath}: missing immutable adoption fact ${phrase}`)
}
for (const path of protectedLegacyPaths) {
  if (!adoptionManifest.includes(`path: ${path}`)) failures.push(`${adoptionManifestPath}: missing superseded-path classification ${path}`)
}

const documents = parseDocuments(registry)
if (documents.length === 0) failures.push(`${registryPath}: no registered documents`)
const ids = new Set()
const paths = new Set()
for (const document of documents) {
  if (!document.documentId || !document.path || !document.role || !document.subject || !document.writeMode || !document.accountableOwner || !document.mutationAuthority || !document.updateTriggers || !document.validation) {
    failures.push(`${registryPath}: incomplete document entry ${document.documentId ?? '<unknown>'}`)
    continue
  }
  if (!legalRoles.has(document.role)) failures.push(`${registryPath}: illegal role ${document.role} for ${document.documentId}`)
  if (ids.has(document.documentId)) failures.push(`${registryPath}: duplicate documentId ${document.documentId}`)
  if (paths.has(document.path)) failures.push(`${registryPath}: duplicate path ${document.path}`)
  ids.add(document.documentId)
  paths.add(document.path)
  const content = readRequired(document.path)
  if (document.path.endsWith('.md')) validateLinks(document.path, content)
  if (document.role === 'stable-authority' || document.role === 'projection') {
    const dynamicPatterns = [
      /^#{1,6}\s+(?:Current status|Current task|当前状态|当前开发目标|下一个目标|待办|进行中)\s*$/imu,
      /\b(?:activeTask|currentBranch|worktreePath|candidateSha|leaseHolder)\s*:/iu,
    ]
    if (dynamicPatterns.some(pattern => pattern.test(content))) {
      failures.push(`${document.path}: stable-document firewall rejected live coordination state`)
    }
  }
  if (document.role === 'projection' && (!document.sourceAuthority || !document.refreshPolicy || !document.expiryPolicy)) {
    failures.push(`${registryPath}: projection ${document.documentId} requires sourceAuthority, refreshPolicy, and expiryPolicy`)
  }
}
for (const document of documents) {
  if (document.role === 'projection' && document.sourceAuthority && !ids.has(document.sourceAuthority)) {
    failures.push(`${registryPath}: projection ${document.documentId} references unknown sourceAuthority ${document.sourceAuthority}`)
  }
}

validateThinAdapter('AGENTS.md', readRequired('AGENTS.md'), 80, [
  '$manage-agile-software-development',
  bindingPath,
  registryPath,
])
validateThinAdapter('CLAUDE.md', readRequired('CLAUDE.md'), 20, [
  'AGENTS.md',
  '$manage-agile-software-development',
])
validateThinAdapter('CONTRIBUTING.md', readRequired('CONTRIBUTING.md'), 120, [
  '$manage-agile-software-development',
  bindingPath,
])

if (!skipGit) {
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    const firstRecord = output.split(/\r?\n\r?\n/u).filter(Boolean)[0] ?? ''
    if (!/^branch refs\/heads\/main$/mu.test(firstRecord)) failures.push('isolation: primary checkout must be branch-attached to main')

    const aliases = new Set(execFileSync('git', ['remote'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    }).split(/\r?\n/u).filter(Boolean))
    for (const alias of ['origin', 'github']) {
      if (!aliases.has(alias)) {
        failures.push(`remote ${alias}: required authority alias is missing`)
        continue
      }
      for (const directionArgs of [
        ['remote', 'get-url', '--all', alias],
        ['remote', 'get-url', '--push', '--all', alias],
      ]) {
        const urls = execFileSync('git', directionArgs, {
          cwd: root,
          encoding: 'utf8',
          timeout: 30_000,
          windowsHide: true,
        }).split(/\r?\n/u).filter(Boolean)
        if (urls.some(remoteHasEmbeddedCredential)) failures.push(`remote ${alias}: credential or userinfo in URL is forbidden`)
      }
    }
  } catch (error) {
    failures.push(`isolation: unable to verify Git worktree state: ${String(error)}`)
  }
}

if (failures.length > 0) {
  console.error('Governance verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`Governance binding, registry, thin adapters, links, legacy firewall, and ${skipGit ? 'declared' : 'observed'} managed isolation: PASS`)
}
