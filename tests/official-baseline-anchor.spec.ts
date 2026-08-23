/**
 * Gate A release-anchor decision core (issue #105): the official baseline pin
 * must be a provable release, not a moving HEAD. These tests drive the pure
 * evaluator in scripts/verify-official-baseline.mjs through every remote
 * shape the anchor can face; the live `pnpm verify:official` run exercises
 * the git plumbing (ls-remote / fetch / merge-base) against the real remote.
 *
 * States (issue #105 acceptance):
 * - green: the pin is the latest release (tag landed on the pin);
 * - green, the core goal: official master advanced — with or without newer
 *   published releases — while the pinned release tag still contains the pin;
 * - red: the pin is not any release (no tag, not the tip, not contained);
 * - degraded green with warning: the npm-first/tag-pending window (the pin is
 *   the remote tip, or a verified ancestor of it, while the tag has not
 *   landed yet);
 * - red: the pinned release was superseded without its tag ever landing.
 */
import { describe, expect, it } from 'vitest'
import { dirname, join, resolve } from 'node:path'
import {
  collectOfficialBaselineEvidence,
  compareReleaseVersions,
  discoverOfficialCheckout,
  enclosingCheckoutCandidates,
  evaluateBaselineAnchor,
  inspectOfficialCheckout,
  officialCheckoutReadGit,
  parseLsRemote,
  parseReleaseVersion,
  tagNameForRelease,
  verifyLocalCheckout,
  verifyReleaseReachability,
  type BaselineAnchorInput,
} from '../scripts/verify-official-baseline.mjs'

// Real remote facts at development time: rc.8's release merge commit and the
// 0.1.1-rc.1 tip both exist as dsh-v* tags on the official remote.
const PIN = '141eb6fef83422698aef7a981029e843e8161534'
const NEWER_TIP = '528c682e061696f5a160f363f236ecbf53cbd006'
const UNRELATED = '9999999999999999999999999999999999999999'

function anchorInput(overrides: Partial<BaselineAnchorInput> = {}): BaselineAnchorInput {
  return {
    pin: PIN,
    release: '0.1.0-rc.8',
    branch: 'master',
    head: PIN,
    branchHead: PIN,
    tags: [{ name: 'dsh-v0.1.0-rc.8', sha: PIN }],
    ancestry: { tag: null, head: null },
    ...overrides,
  }
}

describe('official release version ordering', () => {
  it('orders rc numbers numerically, not lexicographically', () => {
    expect(compareReleaseVersions('0.1.0-rc.9', '0.1.0-rc.10')).toBeLessThan(0)
    expect(compareReleaseVersions('0.1.0-rc.10', '0.1.0-rc.9')).toBeGreaterThan(0)
    expect(compareReleaseVersions('0.1.0-rc.8', '0.1.0-rc.8')).toBe(0)
  })

  it('orders across triples and lets a final release outrank its rc', () => {
    expect(compareReleaseVersions('0.1.0-rc.8', '0.1.1-rc.1')).toBeLessThan(0)
    expect(compareReleaseVersions('0.1.0-rc.8', '0.1.0')).toBeLessThan(0)
    expect(compareReleaseVersions('0.1.0', '0.1.0-rc.8')).toBeGreaterThan(0)
    expect(compareReleaseVersions('0.2.0', '0.10.0')).toBeLessThan(0)
  })

  it('rejects malformed releases instead of guessing an order', () => {
    expect(parseReleaseVersion('latest')).toBeNull()
    expect(parseReleaseVersion('0.1')).toBeNull()
    expect(compareReleaseVersions('latest', '0.1.0-rc.8')).toBe(0)
    expect(tagNameForRelease('0.1.0-rc.8')).toBe('dsh-v0.1.0-rc.8')
  })
})

describe('ls-remote output parsing', () => {
  it('extracts HEAD, the pinned branch, and tags', () => {
    const output = [
      `${PIN}\trefs/heads/master`,
      `${NEWER_TIP}\trefs/heads/release/dsh-0.1.1-rc.1`,
      `${PIN}\trefs/heads/other`,
      `${PIN}\trefs/tags/dsh-v0.1.0-rc.8`,
      `${NEWER_TIP}\trefs/tags/dsh-v0.1.1-rc.1`,
      '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca\trefs/tags/dsh-v0.1.0-rc.7',
    ].join('\n')
    const facts = parseLsRemote(output, 'master')
    expect(facts.branchHead).toBe(PIN)
    expect(facts.tags.map(tag => tag.name).toSorted()).toEqual(['dsh-v0.1.0-rc.7', 'dsh-v0.1.0-rc.8', 'dsh-v0.1.1-rc.1'])
  })

  it('uses the peeled line as the commit of an annotated tag', () => {
    const tagObject = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const output = [
      `${NEWER_TIP}\tHEAD`,
      `${NEWER_TIP}\trefs/heads/master`,
      `${tagObject}\trefs/tags/dsh-v0.1.0-rc.8`,
      `${PIN}\trefs/tags/dsh-v0.1.0-rc.8^{}`,
    ].join('\n')
    const facts = parseLsRemote(output, 'master')
    expect(facts.head).toBe(NEWER_TIP)
    const pinned = facts.tags.find(tag => tag.name === 'dsh-v0.1.0-rc.8')
    expect(pinned?.sha).toBe(tagObject)
    expect(pinned?.peeled).toBe(PIN)
  })
})

describe('release anchor: pin is a provable release (green family)', () => {
  it('passes when the release tag landed exactly on the pin, even as the tip', () => {
    const verdict = evaluateBaselineAnchor(anchorInput())
    expect(verdict.status).toBe('pass')
    expect(verdict.anchor).toBe('release-tag')
    expect(verdict.warnings).toEqual([])
    expect(verdict.notes).toEqual([])
  })

  it('stays green when official master advanced past the pin and no newer release exists (core goal)', () => {
    const verdict = evaluateBaselineAnchor(anchorInput({ head: NEWER_TIP, branchHead: NEWER_TIP }))
    expect(verdict.status).toBe('pass')
    expect(verdict.anchor).toBe('release-tag')
    expect(verdict.warnings).toEqual([])
    expect(verdict.notes.join(' ')).toContain('advanced')
  })

  it('stays green, with a re-pin warning, when a newer release is published and the pin tag still holds', () => {
    const verdict = evaluateBaselineAnchor(anchorInput({
      head: NEWER_TIP,
      branchHead: NEWER_TIP,
      tags: [
        { name: 'dsh-v0.1.0-rc.8', sha: PIN },
        { name: 'dsh-v0.1.1-rc.1', sha: NEWER_TIP },
      ],
    }))
    expect(verdict.status).toBe('pass')
    expect(verdict.anchor).toBe('release-tag')
    expect(verdict.warnings.join(' ')).toContain('re-pin is due')
    expect(verdict.warnings.join(' ')).toContain('dsh-v0.1.1-rc.1')
  })

  it('anchors on an annotated tag through its peeled commit', () => {
    const verdict = evaluateBaselineAnchor(anchorInput({
      tags: [{ name: 'dsh-v0.1.0-rc.8', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', peeled: PIN }],
    }))
    expect(verdict.status).toBe('pass')
    expect(verdict.anchor).toBe('release-tag')
  })

  it('anchors on tag history once the tag commit is proven to contain the pin', () => {
    const verdict = evaluateBaselineAnchor(anchorInput({
      tags: [{ name: 'dsh-v0.1.0-rc.8', sha: NEWER_TIP }],
      ancestry: { tag: true, head: null },
    }))
    expect(verdict.status).toBe('pass')
    expect(verdict.anchor).toBe('release-tag-history')
  })
})

describe('release anchor: npm-first / tag-pending window (degraded green)', () => {
  it('passes, with a warning, while the pin is still the remote tip and the tag has not landed', () => {
    const verdict = evaluateBaselineAnchor(anchorInput({ tags: [] }))
    expect(verdict.status).toBe('pass')
    expect(verdict.anchor).toBe('pending-tag-head')
    expect(verdict.warnings.join(' ')).toContain('has not landed')
  })

  it('passes, with a warning, when master already advanced past the untagged pin and ancestry is proven', () => {
    const verdict = evaluateBaselineAnchor(anchorInput({
      head: NEWER_TIP,
      branchHead: NEWER_TIP,
      tags: [],
      ancestry: { tag: null, head: true },
    }))
    expect(verdict.status).toBe('pass')
    expect(verdict.anchor).toBe('pending-tag-history')
    expect(verdict.warnings.join(' ')).toContain('has not landed')
  })
})

describe('release anchor: pin is not any release (red family)', () => {
  it('fails when the tag is missing, the tip moved on, and the pin is not an ancestor', () => {
    const verdict = evaluateBaselineAnchor(anchorInput({
      head: NEWER_TIP,
      branchHead: NEWER_TIP,
      tags: [],
      ancestry: { tag: null, head: false },
    }))
    expect(verdict.status).toBe('fail')
    expect(verdict.failures.join(' ')).toContain('not any official release')
  })

  it('fails when the release tag points elsewhere and does not contain the pin', () => {
    const verdict = evaluateBaselineAnchor(anchorInput({
      tags: [{ name: 'dsh-v0.1.0-rc.8', sha: UNRELATED }],
      ancestry: { tag: false, head: null },
    }))
    expect(verdict.status).toBe('fail')
    expect(verdict.failures.join(' ')).toContain('does not contain the pinned commit')
  })

  it('fails when the pinned release was superseded without its tag ever landing', () => {
    const verdict = evaluateBaselineAnchor(anchorInput({
      head: NEWER_TIP,
      branchHead: NEWER_TIP,
      tags: [{ name: 'dsh-v0.1.1-rc.1', sha: NEWER_TIP }],
    }))
    expect(verdict.status).toBe('fail')
    expect(verdict.failures.join(' ')).toContain('cannot be proven to be a release')
  })

  it('fails without a tip at all when no tag anchors the pin', () => {
    const verdict = evaluateBaselineAnchor({
      pin: PIN,
      release: '0.1.0-rc.8',
      branch: 'master',
      tags: [],
      ancestry: { tag: null, head: null },
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.failures.join(' ')).toContain('not any official release')
  })
})

describe('release anchor: reachability escalation protocol', () => {
  it('requests a tag-reachability check before deciding a tag that misses the pin', () => {
    const verdict = evaluateBaselineAnchor(anchorInput({
      tags: [{ name: 'dsh-v0.1.0-rc.8', sha: NEWER_TIP }],
    }))
    expect(verdict.status).toBe('needs-ancestry')
    expect(verdict.ancestryRequest?.fact).toBe('tag')
    expect(verdict.ancestryRequest?.sha).toBe(NEWER_TIP)
    expect(verdict.ancestryRequest?.ref).toBe('refs/tags/dsh-v0.1.0-rc.8')
  })

  it('requests a branch-reachability check in the tag-pending window once the tip moved', () => {
    const verdict = evaluateBaselineAnchor(anchorInput({ head: NEWER_TIP, branchHead: NEWER_TIP, tags: [] }))
    expect(verdict.status).toBe('needs-ancestry')
    expect(verdict.ancestryRequest?.fact).toBe('head')
    expect(verdict.ancestryRequest?.sha).toBe(NEWER_TIP)
    expect(verdict.ancestryRequest?.ref).toBe('refs/heads/master')
  })

  it('settles both request kinds through the ancestry facts alone (no hidden state)', () => {
    const pending = anchorInput({ head: NEWER_TIP, branchHead: NEWER_TIP, tags: [] })
    const requested = evaluateBaselineAnchor(pending)
    expect(requested.status).toBe('needs-ancestry')
    const settled = evaluateBaselineAnchor({
      ...pending,
      ancestry: { tag: null, head: requested.ancestryRequest?.fact === 'head' },
    })
    expect(settled.status).toBe('pass')
    expect(settled.anchor).toBe('pending-tag-history')
  })
})

describe('official checkout discovery', () => {
  const pluginRoot = resolve(join('fixture', 'official', 'nested', 'independent', 'dsh-agent-swarm'))
  const officialRoot = resolve(join('fixture', 'official'))
  const baseline = { commit: PIN, release: '0.1.0-rc.8' }
  const officialFacts = {
    root: officialRoot,
    head: PIN,
    packageName: '@deepseek-ai/dsh-root',
    packageVersion: baseline.release,
  }

  it('searches outside the independent plugin and accepts an enclosing exact official identity', async () => {
    const inspected: string[] = []
    const checkout = await discoverOfficialCheckout({
      pluginRoot,
      baseline,
      async inspect(candidate) {
        inspected.push(candidate)
        if (candidate === dirname(pluginRoot)) return officialFacts
        throw new Error('not a git worktree')
      },
    })
    expect(checkout).toBe(officialRoot)
    expect(inspected).toEqual([dirname(pluginRoot)])
    expect(enclosingCheckoutCandidates(pluginRoot)[0]).toBe(dirname(pluginRoot))
  })

  it('rejects an enclosing git root with a non-official package identity', async () => {
    await expect(discoverOfficialCheckout({
      pluginRoot,
      baseline,
      async inspect() {
        return { ...officialFacts, packageName: 'unrelated-monorepo' }
      },
    })).rejects.toThrow('enclosing repositories did not identify the pinned official DSH checkout')
  })

  it('rejects an official-looking root at the wrong commit or release', async () => {
    let call = 0
    await expect(discoverOfficialCheckout({
      pluginRoot,
      baseline,
      async inspect() {
        call += 1
        return call === 1
          ? { ...officialFacts, head: UNRELATED }
          : { ...officialFacts, packageVersion: '0.1.0-rc.7' }
      },
    })).rejects.toThrow('enclosing repositories did not identify the pinned official DSH checkout')
  })

  it('fails closed when git or the package identity cannot be inspected', async () => {
    await expect(discoverOfficialCheckout({
      pluginRoot,
      baseline,
      async inspect() {
        throw new Error('unverifiable')
      },
    })).rejects.toThrow('enclosing repositories did not identify the pinned official DSH checkout')
  })

  it('does not fall back when an explicit override is invalid', async () => {
    const override = resolve(join('fixture', 'wrong-override'))
    const inspected: string[] = []
    await expect(discoverOfficialCheckout({
      pluginRoot,
      override,
      baseline,
      async inspect(candidate) {
        inspected.push(candidate)
        return candidate === override ? { ...officialFacts, head: UNRELATED } : officialFacts
      },
    })).rejects.toThrow('DSH_OFFICIAL_CHECKOUT did not identify the pinned official DSH checkout')
    expect(inspected).toEqual([override])
  })

  it.each(['', ' ', '\t\r\n'])('treats an explicitly empty override as authoritative and invalid (%j)', async (override) => {
    let inspected = false
    await expect(discoverOfficialCheckout({
      pluginRoot,
      override,
      baseline,
      async inspect() {
        inspected = true
        return officialFacts
      },
    })).rejects.toThrow('DSH_OFFICIAL_CHECKOUT is empty')
    expect(inspected).toBe(false)
  })
})

describe('official checkout read-only boundary', () => {
  const officialRoot = resolve(join('fixture', 'official'))
  const evidenceRoot = resolve(join('fixture', 'temporary-bare-evidence'))

  it('runs all reachability writes in a temporary bare repository and cleans it', async () => {
    const trace: Array<{ args: string[], cwd: string | undefined }> = []
    const removed: string[] = []
    const reachable = await verifyReleaseReachability({
      repository: 'https://example.invalid/official.git',
      pin: PIN,
      commit: NEWER_TIP,
      async runGit(args, cwd) {
        trace.push({ args, cwd })
        return ''
      },
      async createEvidenceRepository() {
        return evidenceRoot
      },
      async removeEvidenceRepository(directory) {
        removed.push(directory)
      },
    })
    expect(reachable).toBe(true)
    expect(trace.map(call => call.args[0])).toEqual(['init', 'fetch', 'merge-base'])
    expect(trace.some(call => call.args.includes('--no-optional-locks'))).toBe(false)
    expect(trace.every(call => call.cwd === evidenceRoot)).toBe(true)
    expect(trace.some(call => call.args[0] === 'fetch' && call.args.includes(`${PIN}:refs/evidence/pin`))).toBe(true)
    expect(removed).toEqual([evidenceRoot])
  })

  it('cleans the temporary repository when remote history cannot be fetched', async () => {
    const removed: string[] = []
    const reachable = await verifyReleaseReachability({
      repository: 'https://example.invalid/official.git',
      pin: PIN,
      commit: NEWER_TIP,
      async runGit(args) {
        if (args[0] === 'fetch') throw new Error('offline')
        return ''
      },
      async createEvidenceRepository() {
        return evidenceRoot
      },
      async removeEvidenceRepository(directory) {
        removed.push(directory)
      },
    })
    expect(reachable).toBeNull()
    expect(removed).toEqual([evidenceRoot])
  })

  it('limits the official checkout to read-only git commands', async () => {
    const trace: Array<{ args: string[], cwd: string | undefined }> = []
    const runGit = async (args: string[], cwd?: string): Promise<string> => {
      trace.push({ args, cwd })
      expect(args[0]).toBe('--no-optional-locks')
      const command = args.slice(1)
      if (command.join(' ') === 'rev-parse --show-toplevel') return officialRoot
      if (command.join(' ') === 'rev-parse HEAD') return PIN
      if (command.join(' ') === 'show HEAD:package.json') {
        return JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.1.0-rc.8' })
      }
      if (command.join(' ') === 'status --porcelain') return ''
      if (command[0] === 'show') return JSON.stringify({ name: '@deepseek-ai/example' })
      throw new Error(`unexpected command ${command.join(' ')}`)
    }
    await inspectOfficialCheckout(officialRoot, runGit)
    const local = await verifyLocalCheckout({
      baseline: {
        commit: PIN,
        release: '0.1.0-rc.8',
        packages: [{ path: 'packages/example', name: '@deepseek-ai/example', visibility: 'public' }],
      },
      checkout: officialRoot,
      runGit,
    })
    expect(local.failures).toEqual([])
    expect(trace.every(call => call.cwd === officialRoot)).toBe(true)
    expect(trace.every(call => call.args[0] === '--no-optional-locks')).toBe(true)
    expect(new Set(trace.map(call => call.args[1]))).toEqual(new Set(['rev-parse', 'show', 'status']))
    expect(trace.some(call => call.args[1] === 'status' && call.args[0] === '--no-optional-locks')).toBe(true)
  })

  it('rejects a mutating command before invoking git against the official checkout', async () => {
    let invoked = false
    await expect(officialCheckoutReadGit(['fetch', 'origin'], officialRoot, async () => {
      invoked = true
      return ''
    })).rejects.toThrow('not read-only')
    expect(invoked).toBe(false)
  })
})

describe('official evidence aggregation', () => {
  const remotePass = { failures: [], warnings: [], notes: [], anchorDetail: 'remote pass' }
  const localPass = { failures: [] }

  it('fails when remote evidence passes but local evidence fails', async () => {
    const result = await collectOfficialBaselineEvidence({
      async discover() { return 'official' },
      async verifyRemote() { return remotePass },
      async verifyLocal() { return { failures: ['local failed'] } },
    })
    expect(result.failures).toEqual(['local failed'])
  })

  it('still evaluates local evidence when remote evidence fails', async () => {
    let localCalled = false
    const result = await collectOfficialBaselineEvidence({
      async discover() { return 'official' },
      async verifyRemote() { return { ...remotePass, failures: ['remote failed'] } },
      async verifyLocal() {
        localCalled = true
        return localPass
      },
    })
    expect(localCalled).toBe(true)
    expect(result.failures).toEqual(['remote failed'])
  })

  it('preserves both failures when remote and local evidence fail together', async () => {
    const result = await collectOfficialBaselineEvidence({
      async discover() { return 'official' },
      async verifyRemote() { return { ...remotePass, failures: ['remote failed'] } },
      async verifyLocal() { return { failures: ['local failed'] } },
    })
    expect(result.failures).toEqual(['remote failed', 'local failed'])
  })

  it('passes only when discovery and both evidence sides pass', async () => {
    const result = await collectOfficialBaselineEvidence({
      async discover() { return 'official' },
      async verifyRemote() { return remotePass },
      async verifyLocal() { return localPass },
    })
    expect(result.failures).toEqual([])
    expect(result.anchorDetail).toBe('remote pass')
  })

  it('does not probe either evidence side after discovery fails', async () => {
    let remoteCalled = false
    let localCalled = false
    const result = await collectOfficialBaselineEvidence({
      async discover() { throw new Error('missing') },
      async verifyRemote() {
        remoteCalled = true
        return remotePass
      },
      async verifyLocal() {
        localCalled = true
        return localPass
      },
    })
    expect(result.failures.join(' ')).toContain('cannot discover official checkout')
    expect(remoteCalled).toBe(false)
    expect(localCalled).toBe(false)
  })
})
