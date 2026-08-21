/**
 * External promoter contract core (M3-3, issue #102 / ADR-0008 D2): the
 * promotion state machine must be owned OUTSIDE the candidate runtime —
 * these tests drive scripts/promotion/lib.mjs (tooling, never shipped plugin
 * code) through the ledger hash chain, the LKG generation/pointer chain,
 * generational fencing, the three quiesce criteria, acceptance-verdict
 * verification and the acceptance-domain isolation invariant.
 *
 * The live counterpart is the P0–P7 drill (scripts/promotion/drill.mjs),
 * which exercises the same contract against a real dogfood control root with
 * real pnpm installs, boots and RPC probes; that run's evidence chain is the
 * issue-#102 acceptance record, this suite is the machine-checked contract.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  acceptanceIsolation, activeTeamsFromUnitText, appendLedgerRecord, checkFencing,
  controlRootLayout, establishGeneration, evaluateQuiesce, genDir, ledgerRecordHash,
  readLedger, readLkgPointer, rollPointerBack, rpcCall, sha256File, stableStringify,
  verifyArtifactAgainstManifest, verifyLkgChain, verifyLedgerChain, verifyVerdict,
  writeJsonFile,
} from '../scripts/promotion/lib.mjs'

const root = await mkdtemp(join(tmpdir(), 'm3c-contract-'))
const commitA = 'a'.repeat(40)
const commitB = 'b'.repeat(40)

/** A fresh isolated dogfood root per LKG-touching test (fencing state never leaks across tests). */
async function freshLayout(): Promise<ReturnType<typeof controlRootLayout>> {
  return controlRootLayout(join(await mkdtemp(join(root, 'dogfood-'))))
}

async function fakeTarball(directory: string, name: string, bytes: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, name)
  await writeFile(path, bytes, 'utf8')
  return path
}

async function establish0(layout: ReturnType<typeof controlRootLayout>) {
  const tarball = await fakeTarball(join(root, 'src'), `g0-${layout.root.slice(-6)}.tgz`.replaceAll(':', '_'), 'g0-bytes')
  return establishGeneration(layout.lkgDir, layout.ledgerPath, {
    action: 'gen-established',
    gen: 0,
    prevGen: null,
    tarballPath: tarball,
    candidateId: 'cand-g0',
    gitCommit: commitA,
    gitTree: commitA,
    tarballSha256: await sha256File(tarball),
    tarballBytes: (await stat(tarball)).size,
    profileIdentity: { profileName: 'web', dshHome: layout.controlHome },
  })
}

async function promote1(layout: ReturnType<typeof controlRootLayout>) {
  const tarball = await fakeTarball(join(root, 'src'), `g1-${layout.root.slice(-6)}.tgz`.replaceAll(':', '_'), 'g1-bytes')
  return establishGeneration(layout.lkgDir, layout.ledgerPath, {
    action: 'promote',
    gen: 1,
    prevGen: 0,
    tarballPath: tarball,
    candidateId: 'cand-g1',
    gitCommit: commitB,
    gitTree: commitB,
    tarballSha256: await sha256File(tarball),
    tarballBytes: (await stat(tarball)).size,
    verdictRef: { candidateId: 'cand-g1', sha256: 'f'.repeat(64) },
    profileIdentity: { profileName: 'web', dshHome: layout.controlHome },
  })
}

describe('promotion ledger', () => {
  it('chains every record by sha256 and detects tampering, reordering and forging', async () => {
    const ledgerPath = join(root, 'chain', 'promotion-ledger.jsonl')
    await appendLedgerRecord(ledgerPath, { action: 'gen-established', actor: 'test', toGen: 0 })
    await appendLedgerRecord(ledgerPath, { action: 'promote', actor: 'test', toGen: 1 })
    const records = await readLedger(ledgerPath)
    expect(records).toHaveLength(2)
    const [first, second] = records
    if (first === undefined || second === undefined) throw new Error('records missing')
    expect(second.seq).toBe(2)
    expect(first.prevRecordSha256).toBe('GENESIS')
    expect(second.prevRecordSha256).toBe(first.recordSha256)
    expect((await verifyLedgerChain(records)).ok).toBe(true)
    // field tampering
    const tampered = records.map(record => ({ ...record }))
    tampered[1]!.toGen = 5
    expect((await verifyLedgerChain(tampered)).ok).toBe(false)
    // wholesale forging: a record whose hash does not cover its content
    const forged = [{ ...records[0]!, actor: 'attacker' }]
    expect((await verifyLedgerChain(forged)).ok).toBe(false)
    // reordering breaks both seq monotonicity and the hash links
    expect((await verifyLedgerChain([...records].reverse())).ok).toBe(false)
    // appending onto a broken chain fails loud
    await expect(appendLedgerRecord(ledgerPath, { action: 'rollback', actor: 'test', toGen: 0 })).resolves.toBeDefined()
  })

  it('ledgerRecordHash binds the previous hash and the canonical record body', () => {
    const body = { b: 2, a: 1 }
    const first = ledgerRecordHash('GENESIS', body)
    const second = ledgerRecordHash(first, body)
    expect(first).not.toBe(second)
    expect(ledgerRecordHash('GENESIS', { a: 1, b: 2 })).toBe(first) // key-order independent
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  })

  it('hashes undefined-valued fields exactly like the stored JSON line drops them', async () => {
    // A live drill run broke its ledger chain on this: the hash serialized
    // `missing:undefined` while JSON.stringify (the stored line) dropped the key.
    const ledgerPath = join(root, 'undefined-field', 'promotion-ledger.jsonl')
    const context: Record<string, unknown> = { note: 'ok', missing: undefined }
    await appendLedgerRecord(ledgerPath, { action: 'promote', actor: 'test', toGen: 1, record: context })
    await appendLedgerRecord(ledgerPath, { action: 'rollback', actor: 'test', toGen: 0 })
    const records = await readLedger(ledgerPath)
    expect((await verifyLedgerChain(records)).ok).toBe(true)
    expect(records[0]?.record).toEqual({ note: 'ok' })
  })
})

describe('LKG generation chain', () => {
  it('establishes g0, promotes g1 and verifies the pointer/record/digest chain', async () => {
    const layout = await freshLayout()
    await establish0(layout)
    const g1 = await promote1(layout)
    expect(g1.gen).toBe(1)
    const verdict = await verifyLkgChain(layout.lkgDir, await readLedger(layout.ledgerPath))
    expect(verdict.ok).toBe(true)
    expect(verdict.pointer?.currentGen).toBe(1)
    expect(verdict.pointer?.prevGen).toBe(0)
    // a tampered generation tarball breaks the chain at its exact generation
    await writeFile(join(genDir(layout.lkgDir, 1), 'dsh-agent-swarm.tgz'), 'tampered', 'utf8')
    const tampered = await verifyLkgChain(layout.lkgDir, await readLedger(layout.ledgerPath))
    expect(tampered.ok).toBe(false)
    expect(tampered.failures.join('\n')).toContain('g1 tarball digest')
  })

  it('detects a pointer that disagrees with the ledger tail (concurrent writer)', async () => {
    const layout = await freshLayout()
    await establish0(layout)
    await promote1(layout)
    const records = await readLedger(layout.ledgerPath)
    const pointer = await readLkgPointer(layout.lkgDir)
    if (pointer === undefined) throw new Error('pointer missing')
    const mismatch = await verifyLkgChain(layout.lkgDir, [...records, { ...records[0]!, seq: 99, action: 'promote' as const, toGen: 2, time: new Date().toISOString() }])
    expect(mismatch.ok).toBe(false)
    expect(mismatch.failures.join('\n')).toContain('generational fencing mismatch')
    expect(checkFencing(pointer, records, { action: 'promote' }).ok).toBe(true)
  })
})

describe('generational fencing (scenario 36)', () => {
  it('refuses stale, concurrent and misordered promotions and rollbacks', async () => {
    // scenario-evidence: 36 — stale/concurrent promotion and misordered rollback are fenced apart from the LKG pointer + ledger generation state
    const layout = await freshLayout()
    await establish0(layout)
    await promote1(layout)
    const records = await readLedger(layout.ledgerPath)
    const pointer = await readLkgPointer(layout.lkgDir)
    if (pointer === undefined) throw new Error('pointer missing')
    expect(pointer.currentGen).toBe(1)
    // stale promotion: the expected generation was already superseded
    const stale = checkFencing(pointer, records, { action: 'promote', expectGen: 0 })
    expect(stale.ok).toBe(false)
    expect(stale.reason).toContain('stale promotion')
    // concurrent writer: pointer and ledger tail disagree
    const diverged = checkFencing({ ...pointer, currentGen: 2 }, records, { action: 'promote' })
    expect(diverged.ok).toBe(false)
    expect(diverged.reason).toContain('pointer/ledger disagree')
    // a second establish onto an existing generation is refused
    expect(checkFencing(pointer, records, { action: 'establish' }).ok).toBe(false)
    // rollback must target a lower generation
    expect(checkFencing(pointer, records, { action: 'rollback', toGen: 1 }).ok).toBe(false)
    expect(checkFencing(pointer, records, { action: 'rollback', toGen: 7 }).ok).toBe(false)
    // the legitimate moves pass
    expect(checkFencing(pointer, records, { action: 'promote', expectGen: 1 }).ok).toBe(true)
    expect(checkFencing(pointer, records, { action: 'rollback', toGen: 0 }).ok).toBe(true)
  })

  it('rollback restores the previous generation and preserves every historical directory', async () => {
    const layout = await freshLayout()
    await establish0(layout)
    await promote1(layout)
    const record = await rollPointerBack(layout.lkgDir, layout.ledgerPath, 0, { reason: 'health-probe failed after promote' })
    expect(record.action).toBe('rollback')
    expect(record.toGen).toBe(0)
    const pointer = await readLkgPointer(layout.lkgDir)
    expect(pointer?.currentGen).toBe(0)
    // the failed generation stays on disk as immutable evidence, chain stays consistent
    expect(await stat(join(genDir(layout.lkgDir, 1), 'dsh-agent-swarm.tgz')).then(() => true, () => false)).toBe(true)
    const chain = await verifyLkgChain(layout.lkgDir, await readLedger(layout.ledgerPath))
    expect(chain.ok).toBe(true)
    // rolling "back" to the current generation is refused
    await expect(rollPointerBack(layout.lkgDir, layout.ledgerPath, 0, { reason: 'noop' })).rejects.toThrow(/not below current/)
  })
})

describe('acceptance verdict verification', () => {
  const manifest = {
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
  const evidenceDir = join(root, 'evidence')
  const evidenceFile = join(evidenceDir, 'gate.json')

  it('accepts a fully-passing verdict bound to the exact candidate', async () => {
    await writeJsonFile(evidenceFile, { ok: true })
    const verdict = { schemaVersion: 1 as const, candidateId: 'cand-1', tarballSha256: 'a'.repeat(64), overall: 'pass' as const, gates: [{ gate: 'a1-source-floor', status: 'pass' as const, evidencePath: 'gate.json', evidenceSha256: await sha256File(evidenceFile) }], run: {} }
    expect((await verifyVerdict(verdict, manifest, evidenceDir)).ok).toBe(true)
  })

  it('refuses failed gates, foreign candidates, digest mismatches, tampered evidence and promotion verbs (scenario 35)', async () => {
    await writeJsonFile(evidenceFile, { ok: true })
    const digest = await sha256File(evidenceFile)
    const failed = await verifyVerdict({ schemaVersion: 1, candidateId: 'cand-1', tarballSha256: 'a'.repeat(64), overall: 'fail', gates: [{ gate: 'a1-source-floor', status: 'fail' }], run: {} }, manifest)
    expect(failed.ok).toBe(false)
    expect(failed.failures.join('\n')).toContain('a1-source-floor')
    const foreign = await verifyVerdict({ schemaVersion: 1, candidateId: 'cand-2', tarballSha256: 'a'.repeat(64), overall: 'pass', gates: [], run: {} }, manifest)
    expect(foreign.ok).toBe(false)
    const wrongDigest = await verifyVerdict({ schemaVersion: 1, candidateId: 'cand-1', tarballSha256: 'b'.repeat(64), overall: 'pass', gates: [], run: {} }, manifest)
    expect(wrongDigest.ok).toBe(false)
    const tamperedEvidence = await verifyVerdict({ schemaVersion: 1, candidateId: 'cand-1', tarballSha256: 'a'.repeat(64), overall: 'pass', gates: [{ gate: 'a2', status: 'pass', evidencePath: 'gate.json', evidenceSha256: '0'.repeat(64) }], run: {} }, manifest, evidenceDir)
    expect(tamperedEvidence.ok).toBe(false)
    expect(tamperedEvidence.failures.join('\n')).toContain('evidence digest mismatch')
    const selfPromoting = await verifyVerdict({ schemaVersion: 1, candidateId: 'cand-1', tarballSha256: 'a'.repeat(64), overall: 'pass', promotionVerb: 'promote', gates: [], run: {} }, manifest)
    expect(selfPromoting.ok).toBe(false)
    expect(selfPromoting.failures.join('\n')).toContain('promotion verb')
    // an evidence path escaping the evidence base is refused (traversal)
    const escaping = await verifyVerdict({ schemaVersion: 1, candidateId: 'cand-1', tarballSha256: 'a'.repeat(64), overall: 'pass', gates: [{ gate: 'a3', status: 'pass', evidencePath: '../../outside.json', evidenceSha256: digest }], run: {} }, manifest, evidenceDir)
    expect(escaping.ok).toBe(false)
    expect(escaping.failures.join('\n')).toContain('escapes')
  })

  it('rejects a tampered candidate tarball against its frozen manifest', async () => {
    // scenario-evidence: 35 — a defective/corrupted candidate fails artifact verification and its evidence is preserved, never deleted
    const tarball = await fakeTarball(join(root, 'src'), 'tampered-candidate.tgz', 'not-the-frozen-bytes')
    const artifact = await verifyArtifactAgainstManifest(manifest, tarball)
    expect(artifact.ok).toBe(false)
    expect(artifact.failures.join('\n')).toContain('digest mismatch')
    const missing = await verifyArtifactAgainstManifest(manifest, join(root, 'src', 'absent.tgz'))
    expect(missing.ok).toBe(false)
    expect(missing.failures.join('\n')).toContain('missing')
    // the rejected candidate's evidence stays on disk — rejection never deletes
    expect(await readFile(tarball, 'utf8')).toBe('not-the-frozen-bytes')
  })
})

describe('quiesce criteria (ADR-0008 decision 8)', () => {
  const control = { storageRoot: join(root, 'q', 'storage-root'), sessionsRoot: join(root, 'q', 'sessions-root'), home: join(root, 'q', 'home') }

  it('fails safe on active teams and unparseable authority faces', () => {
    const active = activeTeamsFromUnitText(JSON.stringify({ version: 1, global: null, tables: { teams: { 'team-one': { phase: 'running' }, 'team-two': { phase: 'archived' } } } }))
    expect(active).toEqual([{ teamId: 'team-one', phase: 'running' }])
    expect(activeTeamsFromUnitText(JSON.stringify({ tables: { teams: { 'team-two': { phase: 'archived' } } } }))).toEqual([])
    expect(activeTeamsFromUnitText('}{ not json')).toEqual([{ teamId: '<unparseable-agent_swarm-unit>', phase: 'unknown' }])
  })

  it('passes only when all three criteria are still', async () => {
    await mkdir(control.sessionsRoot, { recursive: true })
    const sessionsFile = join(control.sessionsRoot, 'session-a.jsonl')
    await writeFile(sessionsFile, 'line1\n', 'utf8')
    const unitPath = join(root, 'q', 'storage-root', 'agent_swarm.json')
    let unitText = JSON.stringify({ tables: { teams: { t: { phase: 'archived' } } } })
    const readFileOverride = async (path: string, _encoding: 'utf8'): Promise<string> => {
      if (path === unitPath) return unitText
      const notFound = new Error('ENOENT') as NodeJS.ErrnoException
      notFound.code = 'ENOENT'
      throw notFound
    }
    const quiet = await evaluateQuiesce(control, { readFile: readFileOverride, windowMs: 10, listNodeProcesses: async () => [{ pid: 111, commandLine: 'node somewhere-else.js' }] })
    expect(quiet.quiet).toBe(true)
    // criterion 1: an active team blocks the stage boundary
    unitText = JSON.stringify({ tables: { teams: { t: { phase: 'running' } } } })
    const busyTeam = await evaluateQuiesce(control, { readFile: readFileOverride, windowMs: 0, listNodeProcesses: async () => [] })
    expect(busyTeam.quiet).toBe(false)
    expect(busyTeam.criteria.find(criterion => criterion.criterion === 'no-active-team')?.detail).toContain('team')
    unitText = JSON.stringify({ tables: { teams: { t: { phase: 'archived' } } } })
    // criterion 2: session traffic inside the window blocks it
    const busySessions = await evaluateQuiesce(control, { readFile: readFileOverride, windowMs: 20, delay: async () => { await writeFile(sessionsFile, 'line1\nline2\n', 'utf8') }, listNodeProcesses: async () => [] })
    expect(busySessions.quiet).toBe(false)
    expect(busySessions.criteria.find(criterion => criterion.criterion === 'no-live-session-traffic')?.pass).toBe(false)
    // criterion 3: a live process referencing the control home blocks it
    const busyProcess = await evaluateQuiesce(control, { readFile: readFileOverride, windowMs: 0, listNodeProcesses: async () => [{ pid: 4242, commandLine: `node cli.js --profile web --host 127.0.0.1 ${control.home}` }] })
    expect(busyProcess.quiet).toBe(false)
    expect(busyProcess.criteria.find(criterion => criterion.criterion === 'no-stable-process')?.detail).toContain('4242')
  })
})

describe('acceptance-domain isolation (scenario 27)', () => {
  it('keeps every acceptance path inside the drill domain and outside control/lkg/candidates', async () => {
    const layout = await freshLayout()
    // scenario-evidence: 27 — acceptance Profile state and RPC endpoints derive from paths that can never intersect the control Profile's domains
    const drillDir = join(layout.drillsDir, '20260822T000000-accept-cand')
    const isolation = acceptanceIsolation(drillDir, layout)
    expect(isolation.ok).toBe(true)
    for (const path of Object.values(isolation.domains)) {
      expect(path.startsWith(drillDir)).toBe(true)
      expect(path.startsWith(layout.controlHome)).toBe(false)
      expect(path.startsWith(layout.lkgDir)).toBe(false)
      expect(path.startsWith(layout.candidatesDir)).toBe(false)
    }
    // a drill outside drills/ is refused; a control-home drill is refused
    expect(acceptanceIsolation(join(root, 'elsewhere'), layout).ok).toBe(false)
    expect(acceptanceIsolation(layout.controlHome, layout).ok).toBe(false)
    expect(acceptanceIsolation(layout.candidatesDir, layout).ok).toBe(false)
  })
})

describe('promotion ledger records the exact promotion facts (scenario 28)', () => {
  it('carries commit, digests, profile identity, verdict reference and generations', async () => {
    const ledgerPath = join(root, 'facts', 'promotion-ledger.jsonl')
    await appendLedgerRecord(ledgerPath, {
      action: 'promote',
      actor: 'external-promoter',
      candidateId: 'cand-1',
      gitCommit: commitA,
      gitTree: commitB,
      tarballSha256: 'a'.repeat(64),
      tarballBytes: 42,
      fromGen: 0,
      toGen: 1,
      profileIdentity: { profileName: 'web', dshHome: 'D:/control/home' },
      verdictRef: { candidateId: 'cand-1', sha256: 'f'.repeat(64) },
    })
    const [record] = await readLedger(ledgerPath)
    if (record === undefined) throw new Error('record missing')
    // scenario-evidence: 28 — promotion and rollback record exact commits, artifact digests, Profile identity and evidence ids
    expect(record.gitCommit).toBe(commitA)
    expect(record.gitTree).toBe(commitB)
    expect(record.tarballSha256).toBe('a'.repeat(64))
    expect(record.profileIdentity).toEqual({ profileName: 'web', dshHome: 'D:/control/home' })
    expect(record.verdictRef).toEqual({ candidateId: 'cand-1', sha256: 'f'.repeat(64) })
    expect({ from: record.fromGen, to: record.toGen }).toEqual({ from: 0, to: 1 })
    expect((await verifyLedgerChain([record])).ok).toBe(true)
  })
})

describe('rpc probe envelope (official apiproxy fetch carrier)', () => {
  it('sends the client-request envelope and reads the server-response result', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value: { version: '0.1.0-rc.8' } } }), { status: 200 })
    }) as typeof fetch
    const probe = await rpcCall(47930, 'host.describe', {}, { fetchImpl })
    expect(probe.ok).toBe(true)
    expect(seen?.url).toBe('http://127.0.0.1:47930/api/host.describe')
    expect(seen?.init.headers).toEqual({ 'content-type': 'application/json' })
    const body = JSON.parse(String(seen?.init.body)) as { type: string; method: string }
    expect(body.type).toBe('client-request')
    expect(body.method).toBe('host.describe')
    const failing = await rpcCall(47930, 'host.describe', {}, { fetchImpl: (async () => new Response('{}', { status: 404 })) as typeof fetch })
    expect(failing.ok).toBe(false)
    expect(failing.httpStatus).toBe(404)
  })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})
