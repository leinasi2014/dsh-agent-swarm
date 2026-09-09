import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { sha256File, verifyP0Evidence } from './p0/evidence.mjs'

function argument(name, environment) {
  const index = process.argv.indexOf(name)
  if (index >= 0) {
    const value = process.argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
    return value
  }
  return environment === undefined ? undefined : process.env[environment]
}

try {
  const candidate = process.argv.includes('--candidate')
  const rootValue = argument('--root', candidate ? 'P0_PROOF_ROOT' : undefined)
  let expected
  if (candidate) {
    const expectedPath = argument('--expected', 'P0_EXPECTED')
    const expectedSha = argument('--expected-sha256', 'P0_EXPECTED_SHA256')
    // Empty/partial settings are supplied-but-invalid, not an absent prerequisite.
    if ([rootValue, expectedPath, expectedSha].every(value => value === undefined)) {
      console.log('P0 managed-Team product proof: NOT_CONFIGURED (external controller receipt absent; engineering checks do not prove product acceptance)')
      process.exit(0)
    }
    if (![rootValue, expectedPath, expectedSha].every(value => typeof value === 'string' && value.trim().length > 0)) {
      throw new Error('configured product proof requires --root, --expected and --expected-sha256 together')
    }
    if (!/^[0-9a-f]{64}$/u.test(expectedSha) || await sha256File(resolve(expectedPath)) !== expectedSha) {
      throw new Error('external controller expected JSON digest mismatch')
    }
    expected = JSON.parse(await readFile(resolve(expectedPath), 'utf8'))
    const repo = resolve(argument('--candidate-repo') ?? '.')
    const git = ref => execFileSync('git', ['rev-parse', ref], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
    if (expected.candidateCommit !== git('HEAD') || expected.candidateTree !== git('HEAD^{tree}')) {
      throw new Error('controller candidate commit/tree differs from the actual checkout')
    }
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: repo, windowsHide: true })
    expected = { ...expected, requireManaged: true }
  } else {
    expected = { candidateCommit: argument('--candidate-commit'), candidateTree: argument('--candidate-tree') }
    if (!rootValue || !expected.candidateCommit || !expected.candidateTree) {
      throw new Error('usage: --candidate [--root <proof-root> --expected <controller.json> --expected-sha256 <digest> --candidate-repo <checkout>] OR --root <legacy-proof-root> --candidate-commit <sha> --candidate-tree <sha>')
    }
  }
  const root = resolve(rootValue)
  const manifest = JSON.parse(await readFile(resolve(root, 'evidence', 'manifest.json'), 'utf8'))
  const result = await verifyP0Evidence(root, manifest, expected)
  if (!result.ok) throw new Error(result.failures.join('\n'))
  console.log(`P0 ${candidate ? 'controller-bound managed-Team product' : 'legacy compatibility'} evidence: PASS (${manifest.artifact.sha256})`)
} catch (error) {
  console.error(`P0 evidence: FAIL: ${error.message}`)
  process.exit(1)
}
