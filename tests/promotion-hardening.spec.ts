/**
 * Control-plane security hardening contract (issue #122, D2 precondition —
 * the CONDITIONAL D2 security review's blocking findings): the env seal (F2),
 * the strict verdict form + accepted-record cross-check (F4), the ledger
 * chain-tail git anchors (F5) and the installed-bytes reconciliation +
 * pointer/ledger repair (F3). Split out of promotion-contract.spec.ts at the
 * 600-line source limit; the underlying contract is the same
 * scripts/promotion/lib.mjs (+ runner.mjs / repair.mjs), never shipped plugin
 * code. Each adversarial test was driven RED against the pre-hardening
 * implementation (see the PR evidence) and is GREEN here.
 */
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  anchorLedgerTail, appendLedgerRecord, checkFencing, controlRootLayout,
  crossCheckAcceptedVerdict, directoryContentDigest, establishGeneration,
  ledgerAnchorTagNames, ledgerRecordHash, readLedger, readLkgPointer,
  reconcileInstalledProfile, REQUIRED_VERDICT_GATES, sha256File,
  verifyLedgerAnchors, verifyLedgerChain, verifyLkgChain, verifyVerdict, writeJsonFile,
} from '../scripts/promotion/lib.mjs'
import type { AcceptanceVerdict, CandidateManifest, VerdictGate } from '../scripts/promotion/lib.mjs'
import { git, laneEnv, run } from '../scripts/promotion/runner.mjs'
import { runRepair } from '../scripts/promotion/repair.mjs'

const root = await mkdtemp(join(tmpdir(), 'd2-harden-'))
const commitA = 'a'.repeat(40)

const manifest: CandidateManifest = {
  schemaVersion: 1 as const,
  candidateId: 'cand-1',
  gitCommit: commitA,
  gitTree: commitA,
  tarballSha256: 'a'.repeat(64),
  tarballBytes: 3,
  builtBy: 'freeze-lane@test',
  builtAt: '2026-08-22T00:00:00.000Z',
  buildCommand: ['pnpm build'],
  packageVersion: '0.1.0',
  peerPins: {},
  acceptanceFloor: ['test'],
}

/** A fresh isolated dogfood root per LKG-touching test. */
async function freshLayout(): Promise<ReturnType<typeof controlRootLayout>> {
  return controlRootLayout(join(await mkdtemp(join(root, 'dogfood-'))))
}

async function fakeTarball(directory: string, name: string, bytes: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, name)
  await writeFile(path, bytes, 'utf8')
  return path
}

/** A FULL eight-vocabulary (seven evidence-carrying) passing verdict — the only form verifyVerdict accepts (F4). */
async function fullPassingVerdict(evidenceDir: string): Promise<AcceptanceVerdict> {
  await mkdir(evidenceDir, { recursive: true })
  const gates: VerdictGate[] = []
  for (const name of REQUIRED_VERDICT_GATES) {
    const file = `${name}.json`
    await writeFile(join(evidenceDir, file), JSON.stringify({ gate: name, ok: true }), 'utf8')
    gates.push({ gate: name, status: 'pass', evidencePath: file, evidenceSha256: await sha256File(join(evidenceDir, file)) })
  }
  return { schemaVersion: 1, candidateId: 'cand-1', tarballSha256: 'a'.repeat(64), overall: 'pass', gates, run: { drillDir: join(root, 'drill-1'), lanes: 'floor' } }
}

describe('promotion-lane environment seal (issue #122 F2)', () => {
  it('keeps the PM session environment out of lane children while PATH/TEMP flow', async () => {
    const sentinel = 'DSH_DRILL_SENTINEL_F2'
    process.env[sentinel] = 'pm-secret-material'
    try {
      // laneEnv: the sentinel is dropped, injections win, allowlisted vars pass
      const env = laneEnv({ DSH_HOME: 'D:/drill/home' })
      expect(env.DSH_HOME).toBe('D:/drill/home')
      expect(sentinel in env).toBe(false)
      expect(env.USERPROFILE).toBeUndefined()
      expect(typeof env.PATH).toBe('string')
      // the REAL spawn path (run) seals a live child: the child must not see
      // the PM sentinel, and node itself must still resolve (PATH alive)
      const probe = await run(process.execPath, ['-e', `console.log(process.env.${sentinel} === undefined ? 'sealed' : 'LEAKED', process.env.PATH === undefined ? 'no-path' : 'path-ok', process.env.TEMP === undefined ? 'no-temp' : 'temp-ok')`])
      expect(probe.code).toBe(0)
      expect(probe.stdout.trim()).toBe('sealed path-ok temp-ok')
    } finally {
      delete process.env[sentinel]
    }
  })
})

describe('acceptance verdict strict form and accepted-record cross-check (issue #122 F4)', () => {
  const evidenceDir = join(root, 'f4-evidence')

  it('refuses the P4b-style bare verdict (single gate, no evidence) even when bound to the candidate', async () => {
    // scenario-evidence: 35 — the exact forged-verdict form the pre-F4 promoter accepted: overall=pass,
    // one non-vocabulary gate, no evidence files. The three-fold presence rule
    // (name + status + digest) and the fixed vocabulary refuse it.
    const bare = await verifyVerdict({ schemaVersion: 1, candidateId: 'cand-1', tarballSha256: 'a'.repeat(64), overall: 'pass', gates: [{ gate: 'injected', status: 'pass', detail: 'P4b forged verdict' }], run: {} }, manifest, evidenceDir)
    expect(bare.ok).toBe(false)
    expect(bare.failures.join('\n')).toContain('unknown gate name')
    expect(bare.failures.join('\n')).toContain('required gate missing')
    expect(bare.failures.join('\n')).toContain('evidencePath missing')
    // every required gate must be present with evidence — dropping the evidence of one breaks it
    const verdict = await fullPassingVerdict(evidenceDir)
    const stripped: AcceptanceVerdict = { ...verdict, gates: verdict.gates.map(gate => (gate.gate === 'a5-rpc-health' ? { gate: gate.gate, status: 'pass' as const } : gate)) }
    const missingEvidence = await verifyVerdict(stripped, manifest, evidenceDir)
    expect(missingEvidence.ok).toBe(false)
    expect(missingEvidence.failures.join('\n')).toContain('a5-rpc-health: evidencePath missing')
    // a duplicated gate entry is refused
    const duplicated: AcceptanceVerdict = { ...verdict, gates: [...verdict.gates, verdict.gates[0]!] }
    const dup = await verifyVerdict(duplicated, manifest, evidenceDir)
    expect(dup.ok).toBe(false)
    expect(dup.failures.join('\n')).toContain('appears 2 times')
    // skipping evidence re-verification is not allowed
    const noBase = await verifyVerdict(verdict, manifest)
    expect(noBase.ok).toBe(false)
    expect(noBase.failures.join('\n')).toContain('evidenceBaseDir is required')
  })

  it('cross-checks the verdict against the accepted ledger record and its drill evidence tree', async () => {
    const layout = await freshLayout()
    const drillDir = join(layout.drillsDir, '20260822T000000-accept-cand')
    const drillEvidence = join(drillDir, 'evidence')
    await mkdir(drillEvidence, { recursive: true })
    const gates: VerdictGate[] = []
    for (const name of REQUIRED_VERDICT_GATES) {
      const file = `${name}.json`
      await writeFile(join(drillEvidence, file), JSON.stringify({ gate: name, ok: true }), 'utf8')
      gates.push({ gate: name, status: 'pass', evidencePath: file, evidenceSha256: await sha256File(join(drillEvidence, file)) })
    }
    const verdict: AcceptanceVerdict = { schemaVersion: 1, candidateId: 'cand-1', tarballSha256: 'a'.repeat(64), overall: 'pass', gates, run: { drillDir, lanes: 'floor' } }
    // no accepted record → refused (the silent-promotion third form)
    const none = await crossCheckAcceptedVerdict({ verdict, manifest, verdictDigest: 'e'.repeat(64), ledgerRecords: [], drillsDir: layout.drillsDir })
    expect(none.ok).toBe(false)
    expect(none.failures.join('\n')).toContain('no \'accepted\' ledger record')
    // an accepted record binding a DIFFERENT verdict digest → refused
    await appendLedgerRecord(layout.ledgerPath, { action: 'accepted', actor: 'test', candidateId: 'cand-1', tarballSha256: 'a'.repeat(64), fromGen: null, toGen: null, record: { drillDir }, verdictRef: { candidateId: 'cand-1', sha256: 'f'.repeat(64) } })
    const wrongRef = await crossCheckAcceptedVerdict({ verdict, manifest, verdictDigest: 'e'.repeat(64), ledgerRecords: await readLedger(layout.ledgerPath), drillsDir: layout.drillsDir })
    expect(wrongRef.ok).toBe(false)
    expect(wrongRef.failures.join('\n')).toContain('verdictRef')
    // a foreign drillDir (outside the drills domain) → refused
    await appendLedgerRecord(layout.ledgerPath, { action: 'accepted', actor: 'test', candidateId: 'cand-1', tarballSha256: 'a'.repeat(64), fromGen: null, toGen: null, record: { drillDir: 'D:/elsewhere/drill' }, verdictRef: { candidateId: 'cand-1', sha256: 'e'.repeat(64) } })
    const foreign = await crossCheckAcceptedVerdict({ verdict, manifest, verdictDigest: 'e'.repeat(64), ledgerRecords: await readLedger(layout.ledgerPath), drillsDir: layout.drillsDir })
    expect(foreign.ok).toBe(false)
    expect(foreign.failures.join('\n')).toContain('not inside the drills domain')
    // the fully-bound form → accepted
    await appendLedgerRecord(layout.ledgerPath, { action: 'accepted', actor: 'test', candidateId: 'cand-1', tarballSha256: 'a'.repeat(64), fromGen: null, toGen: null, record: { drillDir }, verdictRef: { candidateId: 'cand-1', sha256: 'e'.repeat(64) } })
    const ok = await crossCheckAcceptedVerdict({ verdict, manifest, verdictDigest: 'e'.repeat(64), ledgerRecords: await readLedger(layout.ledgerPath), drillsDir: layout.drillsDir })
    expect(ok.ok).toBe(true)
    expect(ok.acceptedSeq).toBe(3)
  })
})

describe('ledger chain-tail git anchors (issue #122 F5)', () => {
  it('anchors each promotion tail locally and detects whole-chain recomputation', async () => {
    const repo = join(root, 'anchor-repo')
    await mkdir(repo, { recursive: true })
    expect((await git(repo, ['init', '-q'])).code).toBe(0)
    expect((await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '--allow-empty', '-q', '-m', 'init'])).code).toBe(0)
    // a two-record ledger whose promote record is the anchor target
    const ledgerPath = join(root, 'anchor-ledger', 'promotion-ledger.jsonl')
    await appendLedgerRecord(ledgerPath, { action: 'gen-established', actor: 'test', toGen: 0 })
    await appendLedgerRecord(ledgerPath, { action: 'promote', actor: 'test', toGen: 1 })
    const records = await readLedger(ledgerPath)
    const promoteRecord = records.find(record => record.action === 'promote')
    if (promoteRecord === undefined) throw new Error('fixture: no promote record')
    const anchor = await anchorLedgerTail({ repo, gen: 1, seq: promoteRecord.seq, tailRecordSha256: promoteRecord.recordSha256, action: 'promote' })
    expect(anchor.tagName).toBe('d2-ledger-1')
    expect(anchor.alreadyAnchored).toBe(false)
    expect(ledgerAnchorTagNames(1, promoteRecord.seq)).toEqual(['d2-ledger-1', `d2-ledger-1.${promoteRecord.seq}`])
    // re-anchoring the same record is a no-op
    const again = await anchorLedgerTail({ repo, gen: 1, seq: promoteRecord.seq, tailRecordSha256: promoteRecord.recordSha256, action: 'promote' })
    expect(again.alreadyAnchored).toBe(true)
    // the untampered lineage verifies
    const ok = await verifyLedgerAnchors({ repo, records })
    expect(ok.ok).toBe(true)
    expect(ok.anchorTag).toBe('d2-ledger-1')
    // whole-chain recomputation (the F5 forgery face): tamper a body field and
    // recompute every hash — internally self-consistent, but the immutable
    // tag still carries the ORIGINAL tail, so the anchor check fails
    const tampered = records.map(record => ({ ...record }))
    tampered[1]!.candidateId = 'forged-by-write-access'
    let previousHash = 'GENESIS'
    const recomputed = tampered.map(record => {
      const { seq, time, recordSha256: _oldHash, prevRecordSha256: _oldPrev, ...body } = record
      const hash = ledgerRecordHash(previousHash, { ...body, seq, time })
      const next = { ...record, prevRecordSha256: previousHash, recordSha256: hash }
      previousHash = hash
      return next
    })
    expect(verifyLedgerChain(recomputed).ok).toBe(true)
    const detected = await verifyLedgerAnchors({ repo, records: recomputed })
    expect(detected.ok).toBe(false)
    expect(detected.failures.join('\n')).toContain('recomputed after anchoring')
    // re-promoting the same generation number takes the seq-suffixed name
    await appendLedgerRecord(ledgerPath, { action: 'rollback', actor: 'test', toGen: 0 })
    await appendLedgerRecord(ledgerPath, { action: 'promote', actor: 'test', toGen: 1 })
    const records2 = await readLedger(ledgerPath)
    const second = records2.find(record => record.action === 'promote' && record.seq === 4)
    if (second === undefined) throw new Error('fixture: no second promote record')
    const secondAnchor = await anchorLedgerTail({ repo, gen: 1, seq: second.seq, tailRecordSha256: second.recordSha256, action: 'promote' })
    expect(secondAnchor.tagName).toBe(`d2-ledger-1.${second.seq}`)
    const ok2 = await verifyLedgerAnchors({ repo, records: records2 })
    expect(ok2.ok).toBe(true)
    expect(ok2.anchorTag).toBe(`d2-ledger-1.${second.seq}`)
  })

  it('reports a pre-anchor-era lineage informationally and an unanchored promotion as a failure once the era began', async () => {
    const repo = join(root, 'anchor-repo-era')
    await mkdir(repo, { recursive: true })
    await git(repo, ['init', '-q'])
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '--allow-empty', '-q', '-m', 'init'])
    const ledgerPath = join(root, 'anchor-ledger-era', 'promotion-ledger.jsonl')
    await appendLedgerRecord(ledgerPath, { action: 'gen-established', actor: 'test', toGen: 0 })
    const legacy = await readLedger(ledgerPath)
    const preEra = await verifyLedgerAnchors({ repo, records: legacy })
    expect(preEra.ok).toBe(true)
    expect(preEra.preAnchorEra).toBe(true)
    // once ANY d2-ledger tag exists, a latest promotion without one fails
    await anchorLedgerTail({ repo, gen: 5, seq: 1, tailRecordSha256: 'c'.repeat(64), action: 'gen-established' })
    const flagged = await verifyLedgerAnchors({ repo, records: legacy })
    expect(flagged.ok).toBe(false)
    expect(flagged.failures.join('\n')).toContain('no matching anchor tag')
  })
})

describe('installed-bytes reconciliation and pointer/ledger repair (issue #122 F3)', () => {
  /** A fake extractor: materializes "package/" from a source directory (no tar binary — the real extractor runs in the drill). */
  const fakeExtractFrom = (sourceDir: string) => async (_tarball: string, destDir: string): Promise<void> => {
    await cp(sourceDir, join(destDir, 'package'), { recursive: true })
  }

  it('reconciles the installed Profile bytes against the pointer generation and flags divergence', async () => {
    const layout = await freshLayout()
    // an "installed" profile dir + a matching generation tarball (content via fake extractor)
    const installedDir = join(layout.controlProfileDir, 'node_modules', 'dsh-agent-swarm')
    const sourceDir = join(root, 'reconcile-src')
    await mkdir(join(installedDir, 'lib'), { recursive: true })
    await mkdir(join(sourceDir, 'lib'), { recursive: true })
    await writeFile(join(layout.controlProfileDir, 'package.json'), '{"name":"web-profile"}', 'utf8')
    await writeFile(join(installedDir, 'package.json'), '{"name":"dsh-agent-swarm"}', 'utf8')
    await writeFile(join(installedDir, 'lib', 'index.mjs'), 'export {}', 'utf8')
    await writeFile(join(sourceDir, 'package.json'), '{"name":"dsh-agent-swarm"}', 'utf8')
    await writeFile(join(sourceDir, 'lib', 'index.mjs'), 'export {}', 'utf8')
    const tarball = await fakeTarball(join(root, 'src'), 'reconcile-g0.tgz', 'tarball-bytes')
    await establishGeneration(layout.lkgDir, layout.ledgerPath, {
      action: 'gen-established', gen: 0, prevGen: null, tarballPath: tarball, candidateId: 'cand-g0',
      gitCommit: commitA, gitTree: commitA, tarballSha256: await sha256File(tarball), tarballBytes: (await stat(tarball)).size,
    })
    const pointer = await readLkgPointer(layout.lkgDir)
    if (pointer === undefined) throw new Error('pointer missing')
    const matching = await reconcileInstalledProfile({ layout, pointer, extract: fakeExtractFrom(sourceDir) })
    expect(matching.checked).toBe(true)
    expect(matching.matches).toBe(true)
    expect(matching.installedContentSha256).toBe(await directoryContentDigest(installedDir))
    // a half-applied state (installed bytes ≠ pointer generation) is machine-detected
    await writeFile(join(installedDir, 'lib', 'index.mjs'), 'export {} // tampered', 'utf8')
    const divergent = await reconcileInstalledProfile({ layout, pointer, extract: fakeExtractFrom(sourceDir) })
    expect(divergent.checked).toBe(true)
    expect(divergent.matches).toBe(false)
    // no stable Profile at all is reported unchecked, not a divergence
    const emptyLayout = await freshLayout()
    const none = await reconcileInstalledProfile({ layout: emptyLayout, pointer, extract: fakeExtractFrom(sourceDir) })
    expect(none.checked).toBe(false)
  })

  it('repairs pointer/ledger generational divergence only after explicit confirmation', async () => {
    const layout = await freshLayout()
    const g0Tarball = await fakeTarball(join(root, 'src'), `repair-g0-${layout.root.slice(-6)}.tgz`.replaceAll(':', '_'), 'g0-bytes')
    await establishGeneration(layout.lkgDir, layout.ledgerPath, {
      action: 'gen-established', gen: 0, prevGen: null, tarballPath: g0Tarball, candidateId: 'cand-g0',
      gitCommit: commitA, gitTree: commitA, tarballSha256: await sha256File(g0Tarball), tarballBytes: (await stat(g0Tarball)).size,
    })
    const g1Tarball = await fakeTarball(join(root, 'src'), `repair-g1-${layout.root.slice(-6)}.tgz`.replaceAll(':', '_'), 'g1-bytes')
    await establishGeneration(layout.lkgDir, layout.ledgerPath, {
      action: 'promote', gen: 1, prevGen: 0, tarballPath: g1Tarball, candidateId: 'cand-g1',
      gitCommit: commitA, gitTree: commitA, tarballSha256: await sha256File(g1Tarball), tarballBytes: (await stat(g1Tarball)).size,
    })
    const ledgerRecords = await readLedger(layout.ledgerPath)
    // crash window: the pointer moved to g2 but the ledger never recorded it
    await writeJsonFile(join(layout.lkgDir, 'lkg.json'), { schemaVersion: 1, currentGen: 2, prevGen: 1, currentTarballSha256: '0'.repeat(64), updatedAt: new Date().toISOString() })
    const divergentPointer = await readLkgPointer(layout.lkgDir)
    expect(checkFencing(divergentPointer, ledgerRecords, { action: 'promote' }).ok).toBe(false)
    expect(checkFencing(divergentPointer, ledgerRecords, { action: 'rollback', toGen: 0 }).ok).toBe(false)
    // dry run: reports, touches nothing
    const dryRun = await runRepair({ dogfoodRoot: layout.root })
    expect(dryRun.divergences.pointerLedgerDiverged).toBe(true)
    expect(dryRun.actions.some(action => action.action === 're-anchor-pointer' && action.detail !== undefined)).toBe(true)
    expect(dryRun.ok).toBe(false)
    expect((await readLkgPointer(layout.lkgDir))?.currentGen).toBe(2)
    // confirmed repair: re-anchors onto the ledger tail (g1) and records it
    const repairRun = await runRepair({ dogfoodRoot: layout.root, yes: true })
    expect(repairRun.ok).toBe(true)
    const pointerAfter = await readLkgPointer(layout.lkgDir)
    const ledgerAfter = await readLedger(layout.ledgerPath)
    expect(pointerAfter?.currentGen).toBe(1)
    expect(ledgerAfter.at(-1)?.action).toBe('repair')
    expect((await verifyLkgChain(layout.lkgDir, ledgerAfter)).ok).toBe(true)
    expect(checkFencing(pointerAfter, ledgerAfter, { action: 'promote' }).ok).toBe(true)
    // a broken ledger chain is evidence tampering, never auto-repaired
    const brokenRoot = join(root, 'dogfood-broken')
    const brokenLayout = controlRootLayout(brokenRoot)
    await mkdir(dirname(brokenLayout.ledgerPath), { recursive: true })
    await appendLedgerRecord(brokenLayout.ledgerPath, { action: 'gen-established', actor: 'test', toGen: 0 })
    const brokenRecords = await readLedger(brokenLayout.ledgerPath)
    await writeFile(brokenLayout.ledgerPath, `${brokenRecords.map(record => JSON.stringify({ ...record, actor: 'tamperer' })).join('\n')}\n`, 'utf8')
    await writeJsonFile(join(brokenLayout.lkgDir, 'lkg.json'), { schemaVersion: 1, currentGen: 2, prevGen: 0, currentTarballSha256: '0'.repeat(64), updatedAt: new Date().toISOString() })
    await expect(runRepair({ dogfoodRoot: brokenRoot, yes: true })).rejects.toThrow(/chain does not verify/)
  })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})
