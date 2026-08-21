// M3-3 end-to-end drill (issue #102, design §4): ONE controlled dogfood of
// the whole candidate lifecycle — g0 baseline freeze → candidate freeze →
// acceptance (A0–A7, first drill on the FULL lane set) → external promote to
// g1 → BOTH failure injections (acceptance-rejection type on a deliberately
// defective commit; post-promotion-survival type on a drill-only stable copy
// with a corrupted artifact) → rollback → evidence packaging → zero-residue
// assertion.
//
// Every domain touched lives under the dogfood control root. ~/.dsh, the
// host's running stable Profile and the real root's g0/g1 lineage are never
// inputs to any injection: the survival injection targets a COPY root (lkg +
// ledger lineage only, fresh control home) inside the drill domain. Each
// phase appends a hash-chained record to the drill ledger with sha256
// digests of the evidence tree.
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  controlRootLayout, ledgerRecordHash, listNodeProcessesWindows, readLedger,
  readLkgPointer, sha256File, verifyLkgChain,
} from './lib.mjs'
import { git, run, waitPortFree } from './runner.mjs'
import { probeStablePlane } from './plane-ops.mjs'
import { runAcceptance } from './accept-check.mjs'
import { runPromote } from './promote.mjs'
import { runRollback } from './rollback.mjs'

function parseArgs(argv) {
  const args = { controlPort: 47830, acceptPort: 47930, quiesceWindowMs: 3_000, lanes: 'full' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`missing value for ${argument}`)
      return argv[index]
    }
    if (argument === '--dogfood-root') args.dogfoodRoot = resolve(next())
    else if (argument === '--repo') args.repo = resolve(next())
    else if (argument === '--cli') args.cli = resolve(next())
    else if (argument === '--main-commit') args.mainCommit = next()
    else if (argument === '--candidate-commit') args.candidateCommit = next()
    else if (argument === '--control-port') args.controlPort = Number(next())
    else if (argument === '--accept-port') args.acceptPort = Number(next())
    else if (argument === '--quiesce-window-ms') args.quiesceWindowMs = Number(next())
    else if (argument === '--lanes') args.lanes = next()
    else throw new Error(`unknown argument ${argument}`)
  }
  for (const required of ['dogfoodRoot', 'repo', 'cli']) {
    if (args[required] === undefined) throw new Error(`--${required.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required`)
  }
  return args
}

async function digestTree(directory) {
  const files = {}
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else files[entry.name] = await sha256File(path).catch(() => 'unreadable')
    }
  }
  await walk(directory)
  return files
}

/** Create a one-commit child of `base` carrying a deliberately failing test. */
async function createDefectiveCommit(repo, base) {
  const branch = `drill/p4a-defect-${Date.now()}`
  const scratch = await mkdtemp(join(tmpdir(), 'm3c-defect-'))
  const worktree = join(scratch, 'wt')
  const add = await git(repo, ['worktree', 'add', '--detach', worktree, base])
  if (add.code !== 0) throw new Error(`defect worktree failed: ${add.stderr}`)
  try {
    await writeFile(join(worktree, 'tests', 'zz-drill-injected-defect.spec.ts'), [
      `// M3-3 drill P4(a) failure injection (issue #102): a deliberately`,
      `// defective candidate commit. The acceptance floor MUST catch this and`,
      `// settle the candidate as rejected with evidence preserved.`,
      `import { expect, it } from 'vitest'`,
      ``,
      `it('drill-injected defect: deterministic floor failure', () => {`,
      `  expect('drill-defect-marker').toBe('drill-defect-EXPECTED-FAILURE')`,
      `})`,
      ``,
    ].join('\n'), 'utf8')
    const addFile = await git(worktree, ['add', 'tests/zz-drill-injected-defect.spec.ts'])
    if (addFile.code !== 0) throw new Error(`defect add failed: ${addFile.stderr}`)
    const commit = await git(worktree, ['-c', 'user.name=m3c-drill', '-c', 'user.email=drill@m3c.invalid', 'commit', '-m', 'drill(M3C-P4a): inject a deterministic floor failure for acceptance-rejection evidence'])
    if (commit.code !== 0) throw new Error(`defect commit failed: ${commit.stderr}`)
    const sha = await git(worktree, ['rev-parse', 'HEAD'])
    const branchResult = await git(repo, ['branch', branch, sha.stdout.trim()])
    if (branchResult.code !== 0) throw new Error(`defect branch failed: ${branchResult.stderr}`)
    return { sha: sha.stdout.trim(), branch }
  } finally {
    await git(repo, ['worktree', 'remove', '--force', worktree])
    await git(repo, ['worktree', 'prune'])
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
}

/** Corrupt one packed copy of the candidate tarball: the plugin entry throws on import. */
async function createCorruptedTarball(sourceTarball, scratchDir) {
  const extractDir = join(scratchDir, 'x')
  await mkdir(extractDir, { recursive: true })
  // Only one absolute path per tar invocation, spelled with forward slashes,
  // and directory context via cwd — the msys GNU tar on PATH mangles
  // backslash drive-letter args (live: 'D\:\\...' Cannot open) and -C
  // positioning is operand-order-dependent.
  const posix = value => value.replaceAll('\\', '/')
  const extract = await run('tar', ['--force-local', '-xzf', posix(sourceTarball)], { cwd: extractDir })
  if (extract.code !== 0) throw new Error(`tar extract failed: ${extract.stderr}`)
  const entry = join(extractDir, 'package', 'lib', 'index.mjs')
  const original = await readFile(entry, 'utf8')
  await writeFile(entry, `${original}\nthrow new Error('M3C drill-injected defect (P4b): the post-promotion health probe MUST fail on this artifact')\n`, 'utf8')
  const packed = join(scratchDir, 'dsh-agent-swarm-corrupted.tgz')
  const pack = await run('tar', ['--force-local', '-czf', posix(packed), 'package'], { cwd: extractDir })
  if (pack.code !== 0) throw new Error(`tar pack failed: ${pack.stderr}`)
  return packed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const layout = controlRootLayout(args.dogfoodRoot)
  for (const dir of [layout.controlHome, layout.controlStorage, layout.controlSessions, layout.candidatesDir, layout.drillsDir, dirname(layout.ledgerPath)]) {
    await mkdir(dir, { recursive: true })
  }
  const mainCommit = args.mainCommit ?? (await git(args.repo, ['rev-parse', 'origin/main'])).stdout.trim()
  const candidateCommit = args.candidateCommit ?? (await git(args.repo, ['rev-parse', 'HEAD'])).stdout.trim()
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const drillDir = join(layout.drillsDir, `${stamp}-m3c`)
  const evidenceDir = join(drillDir, 'evidence')
  await mkdir(evidenceDir, { recursive: true })
  const drillLedgerPath = join(evidenceDir, 'drill-ledger.jsonl')
  let previousHash = 'GENESIS'
  const drillRecord = async (phase, status, detail, extra = {}) => {
    const evidenceFiles = await digestTree(evidenceDir)
    const body = { phase, status, detail, time: new Date().toISOString(), evidenceFiles, ...extra }
    const recordSha256 = ledgerRecordHash(previousHash, body)
    const record = { ...body, prevRecordSha256: previousHash, recordSha256 }
    previousHash = recordSha256
    await writeFile(drillLedgerPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
    console.error(`[drill] ${phase}: ${status} — ${detail}`)
    return record
  }
  const writeJsonEvidence = async (name, value) => {
    await mkdir(evidenceDir, { recursive: true })
    await writeFile(join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }
  const freeze = async (commit, candidateId) => {
    const result = await run(process.execPath, [join(import.meta.dirname, 'freeze.mjs'), '--repo', args.repo, '--commit', commit, '--dogfood-root', args.dogfoodRoot, '--candidate-id', candidateId], { timeoutMs: 30 * 60_000 })
    if (result.code !== 0) throw new Error(`freeze of ${candidateId} failed: ${(result.stderr || result.stdout).slice(0, 800)}`)
    return JSON.parse(result.stdout)
  }
  const promoteCli = extraArgs => runPromote({ dogfoodRoot: args.dogfoodRoot, cli: args.cli, port: args.controlPort, quiesceWindowMs: args.quiesceWindowMs, ...extraArgs })
  const stableProbe = async label => {
    const probe = await probeStablePlane({ cli: args.cli, layout, port: args.controlPort })
    await writeJsonEvidence(`stable-probe-${label}.json`, probe.evidence)
    if (!probe.ok) throw new Error(`stable plane probe ${label} failed`)
    return probe.evidence
  }

  // ── P0: baseline — freeze main as g0, establish, stable health ──────────
  const g0Id = `${stamp}-g0-${mainCommit.slice(0, 8)}`
  const g0Freeze = await freeze(mainCommit, g0Id)
  const g0Promote = await promoteCli({ candidate: g0Id, establish: true })
  const g0Probe = await stableProbe('g0')
  await drillRecord('P0', 'pass', `main ${mainCommit.slice(0, 8)} frozen as ${g0Id} and established as lkg/g0; stable plane healthy`, { g0Freeze, g0PromoteSteps: g0Promote.steps, g0Probe: { bootMs: g0Probe.bootMs, dumpConfigOk: g0Probe.dumpConfigOk } })

  // ── P1: candidate freeze ────────────────────────────────────────────────
  const candidateId = `${stamp}-cand-${candidateCommit.slice(0, 8)}`
  const candidateFreeze = await freeze(candidateCommit, candidateId)
  await drillRecord('P1', 'pass', `candidate ${candidateCommit.slice(0, 8)} frozen as ${candidateId} (digest ${candidateFreeze.tarballSha256.slice(0, 16)}…)`, { candidateFreeze })

  // ── P2: acceptance (first drill runs the FULL lane set) ─────────────────
  const acceptance = await runAcceptance({ dogfoodRoot: args.dogfoodRoot, repo: args.repo, candidate: candidateId, cli: args.cli, port: args.acceptPort, lanes: args.lanes })
  if (acceptance.verdict.overall !== 'pass') {
    await drillRecord('P2', 'fail', `acceptance verdict FAILED — drill stops (rejected evidence preserved in candidates/${candidateId} and the drill domain)`, { gates: acceptance.verdict.gates })
    throw new Error('P2 acceptance failed — drill aborted')
  }
  await drillRecord('P2', 'pass', `acceptance A0–A7 pass on ${candidateId} (verdict digest ${acceptance.verdictDigest.slice(0, 16)}…, evidence ${acceptance.drillDir}`, { gates: acceptance.verdict.gates.map(gate => ({ gate: gate.gate, status: gate.status })), acceptanceDrillDir: acceptance.drillDir })

  // ── P3: external promote to g1 ──────────────────────────────────────────
  const g1Promote = await promoteCli({ candidate: candidateId })
  const chainP3 = await verifyLkgChain(layout.lkgDir, await readLedger(layout.ledgerPath))
  const pointerP3 = await readLkgPointer(layout.lkgDir)
  const g1Probe = await stableProbe('g1')
  if (!chainP3.ok || pointerP3.currentGen !== 1) throw new Error(`P3 verification failed: ${chainP3.failures.join('; ')}`)
  await drillRecord('P3', 'pass', `promoted ${candidateId} to lkg/g1; chain + fencing consistent; stable plane healthy`, { promoteSteps: g1Promote.steps })

  // ── P4(a): acceptance-rejection injection (real candidates/, real acceptance lane) ──
  const defect = await createDefectiveCommit(args.repo, candidateCommit)
  const defectId = `${stamp}-p4a-defect-${defect.sha.slice(0, 8)}`
  const defectFreeze = await freeze(defect.sha, defectId)
  const defectAcceptance = await runAcceptance({ dogfoodRoot: args.dogfoodRoot, repo: args.repo, candidate: defectId, cli: args.cli, port: args.acceptPort, lanes: 'floor' }).catch(error => ({ error: String(error) }))
  process.exitCode = 0 // the defective run settles exit 1 BY DESIGN; the drill continues
  const defectVerdict = defectAcceptance?.verdict
  const defectRejected = defectVerdict?.overall === 'fail'
  if (!defectRejected) throw new Error('P4(a) FAILED: the defective candidate was not rejected by the acceptance floor')
  const ledgerAfterP4a = await readLedger(layout.ledgerPath)
  const rejectRecord = ledgerAfterP4a.find(record => record.action === 'reject' && record.candidateId === defectId)
  if (rejectRecord === undefined) throw new Error('P4(a) FAILED: no reject ledger record for the defective candidate')
  const stableAfterP4a = await stableProbe('after-p4a')
  const chainAfterP4a = await verifyLkgChain(layout.lkgDir, ledgerAfterP4a)
  const pointerAfterP4a = await readLkgPointer(layout.lkgDir)
  if (!chainAfterP4a.ok || pointerAfterP4a.currentGen !== 1) throw new Error('P4(a) FAILED: stable lineage disturbed by the rejected candidate')
  await drillRecord('P4a', 'pass', `defective commit ${defect.sha.slice(0, 8)} (branch ${defect.branch}) rejected at the floor; rejected evidence preserved; stable plane still healthy on g1 — zero disturbance`, {
    injection: {
      type: 'acceptance-rejection',
      mechanism: 'one-commit child of the candidate adding a deterministically failing vitest case',
      expected: 'A1 source-floor red → verdict fail → ledger reject record → stable untouched',
      actual: `failed gates: ${defectVerdict.gates.filter(gate => gate.status === 'fail').map(gate => gate.gate).join(', ')}`,
    },
    defectFreeze,
    defectAcceptanceDrillDir: defectAcceptance.drillDir ?? null,
    stableAfterP4a: { bootMs: stableAfterP4a.bootMs },
  })
  await git(args.repo, ['branch', '-D', defect.branch])

  // ── P4(b): post-promotion survival injection (drill-only stable COPY lineage) ──
  const copyRoot = join(drillDir, 'stable-copy-root')
  const copyLayout = controlRootLayout(copyRoot)
  for (const dir of [copyLayout.controlHome, copyLayout.controlStorage, copyLayout.controlSessions, copyLayout.candidatesDir, copyLayout.drillsDir, dirname(copyLayout.ledgerPath), copyLayout.lkgDir]) {
    await mkdir(dir, { recursive: true })
  }
  await copyFile(join(layout.lkgDir, 'lkg.json'), join(copyLayout.lkgDir, 'lkg.json'))
  for (const entry of await readdir(layout.lkgDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await mkdir(join(copyLayout.lkgDir, entry.name), { recursive: true })
      for (const file of await readdir(join(layout.lkgDir, entry.name))) {
        await copyFile(join(layout.lkgDir, entry.name, file), join(copyLayout.lkgDir, entry.name, file))
      }
    }
  }
  await copyFile(layout.ledgerPath, copyLayout.ledgerPath)
  const corruptedId = `${candidateId}-corrupted`
  const corruptedDir = join(copyLayout.candidatesDir, corruptedId)
  await mkdir(corruptedDir, { recursive: true })
  const corruptedTarball = await createCorruptedTarball(join(layout.candidatesDir, candidateId, 'dsh-agent-swarm.tgz'), copyRoot)
  await copyFile(corruptedTarball, join(corruptedDir, 'dsh-agent-swarm.tgz'))
  const corruptedDigest = await sha256File(join(corruptedDir, 'dsh-agent-swarm.tgz'))
  const corruptedBytes = (await stat(join(corruptedDir, 'dsh-agent-swarm.tgz'))).size
  const sourceManifest = JSON.parse(await readFile(join(layout.candidatesDir, candidateId, 'manifest.json'), 'utf8'))
  await writeFile(join(corruptedDir, 'manifest.json'), `${JSON.stringify({ ...sourceManifest, candidateId: corruptedId, tarballSha256: corruptedDigest, tarballBytes: corruptedBytes, builtBy: 'drill-injection@p4b', injected: 'P4(b) post-promotion survival injection: plugin entry throws on import; digests are self-consistent so promote reaches the health-probe step by design' }, null, 2)}\n`, 'utf8')
  await writeFile(join(corruptedDir, 'acceptance-verdict.json'), `${JSON.stringify({ schemaVersion: 1, candidateId: corruptedId, tarballSha256: corruptedDigest, overall: 'pass', gates: [{ gate: 'injected', status: 'pass', detail: 'P4(b) forged verdict: the drill deliberately bypasses acceptance to drive the promoter into its probe-failure path' }], run: { injected: true, finishedAt: new Date().toISOString() } }, null, 2)}\n`, 'utf8')
  const pointerBeforeP4b = await readLkgPointer(layout.lkgDir)
  const p4b = await runPromote({ dogfoodRoot: copyRoot, candidate: corruptedId, cli: args.cli, port: args.controlPort, quiesceWindowMs: 100 }).catch(error => ({ thrown: String(error) }))
  process.exitCode = 0 // the failed promote settles exit 1 BY DESIGN; the drill continues
  const copyLedger = await readLedger(copyLayout.ledgerPath)
  const copyPointer = await readLkgPointer(copyLayout.lkgDir)
  const copyChain = await verifyLkgChain(copyLayout.lkgDir, copyLedger)
  const g2Preserved = await stat(join(copyLayout.lkgDir, 'g2', 'dsh-agent-swarm.tgz')).then(() => true, () => false)
  const pointerAfterP4b = await readLkgPointer(layout.lkgDir)
  if (p4b.autoRolledBack !== true || copyPointer.currentGen !== 1 || !copyChain.ok || !g2Preserved) {
    throw new Error(`P4(b) FAILED: autoRolledBack=${p4b.autoRolledBack} copyPointer=g${copyPointer?.currentGen} chainOk=${copyChain.ok} g2Preserved=${g2Preserved}`)
  }
  if (pointerAfterP4b.currentGen !== 1 || pointerAfterP4b.updatedAt !== pointerBeforeP4b.updatedAt) {
    throw new Error('P4(b) FAILED: the REAL root pointer was disturbed by the copy-root injection')
  }
  const stableAfterP4b = await stableProbe('after-p4b')
  await drillRecord('P4b', 'pass', 'corrupted artifact promoted inside the drill-only stable COPY lineage reached the health probe, failed it, and the bounded auto-rollback restored g1 (failed g2 directory preserved as evidence); the REAL root pointer and lineage untouched', {
    injection: {
      type: 'post-promotion-survival',
      mechanism: 'tarball repacked with an import-throwing plugin entry + self-consistent manifest/verdict (marked injected), promoted against a copied lkg/ledger lineage with a fresh control home',
      expected: 'probe red → auto-rollback to previous generation → failed generation kept as evidence → real root untouched',
      actual: `autoRolledBack=true, reprobeOk=${p4b.autoRollback?.reprobeOk}, copy pointer g${copyPointer.currentGen}, g2 preserved=${g2Preserved}`,
    },
    copyLedgerTail: copyLedger.slice(-3).map(record => ({ seq: record.seq, action: record.action, fromGen: record.fromGen, toGen: record.toGen, reason: record.record?.reason ?? null })),
    realRootPointerUntouched: { currentGen: pointerAfterP4b.currentGen, updatedAt: pointerAfterP4b.updatedAt },
    stableAfterP4b: { bootMs: stableAfterP4b.bootMs },
  })

  // ── P5: rollback the REAL root to the previous generation ──────────────
  const rollbackRun = await runRollback({ dogfoodRoot: args.dogfoodRoot, cli: args.cli, port: args.controlPort, quiesceWindowMs: args.quiesceWindowMs, toGen: 0, reason: 'M3-3 drill P5: deterministic rollback to the previous generation after P3/P4' })
  const pointerP5 = await readLkgPointer(layout.lkgDir)
  const chainP5 = await verifyLkgChain(layout.lkgDir, await readLedger(layout.ledgerPath))
  const g1StillThere = await stat(join(layout.lkgDir, 'g1', 'dsh-agent-swarm.tgz')).then(() => true, () => false)
  const rollbackProbe = await stableProbe('after-rollback-g0')
  if (pointerP5.currentGen !== 0 || !chainP5.ok || !g1StillThere) throw new Error('P5 FAILED: rollback did not restore g0 with history intact')
  await drillRecord('P5', 'pass', 'rollback restored the stable plane to g0; pointer currentGen 1→0; g1 directory preserved as immutable evidence; stable plane healthy', { rollbackSteps: rollbackRun.steps })

  // ── P6: evidence packaging (digest every evidence artifact) ─────────────
  const evidenceManifest = { generatedAt: new Date().toISOString(), drillDir, realLedger: await readLedger(layout.ledgerPath), realPointer: await readLkgPointer(layout.lkgDir), drillEvidence: await digestTree(evidenceDir), acceptanceEvidence: {}, candidates: {} }
  for (const entry of await readdir(layout.drillsDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !entry.name.endsWith('-m3c')) evidenceManifest.acceptanceEvidence[entry.name] = await digestTree(join(layout.drillsDir, entry.name, 'evidence'))
  }
  for (const entry of await readdir(layout.candidatesDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) evidenceManifest.candidates[entry.name] = await digestTree(join(layout.candidatesDir, entry.name))
  }
  await writeJsonEvidence('evidence-manifest.json', evidenceManifest)
  await drillRecord('P6', 'pass', `evidence manifest written (${Object.keys(evidenceManifest.drillEvidence).length} drill files, ${Object.keys(evidenceManifest.acceptanceEvidence).length} acceptance runs, ${Object.keys(evidenceManifest.candidates).length} candidate directories digested)`)

  // ── P7: zero-residue assertion + drill-domain cleanup ───────────────────
  const processes = await listNodeProcessesWindows()
  const marker = args.dogfoodRoot.replaceAll('\\', '/').toLowerCase()
  const residue = processes.filter(item => item.pid !== process.pid && item.commandLine.replaceAll('\\', '/').toLowerCase().includes(marker))
  const controlPortFree = await waitPortFree(args.controlPort, 20_000, '127.0.0.1', { reclaim: true })
  const acceptPortFree = await waitPortFree(args.acceptPort, 20_000, '127.0.0.1', { reclaim: true })
  if (residue.length !== 0 || !controlPortFree || !acceptPortFree) {
    throw new Error(`P7 FAILED: residue=${residue.map(item => `pid ${item.pid}`).join(', ')} controlPortFree=${controlPortFree} acceptPortFree=${acceptPortFree}`)
  }
  for (const entry of await readdir(layout.drillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(layout.drillsDir, entry.name)
    if (entry.name.endsWith('-m3c')) {
      await rm(join(path, 'stable-copy-root'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
    }
    for (const disposable of ['home', 'workspace', 'storage-root', 'sessions-root']) {
      await rm(join(path, disposable), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
    }
  }
  await drillRecord('P7', 'pass', `zero process residue (${residue.length} external processes reference the dogfood root), both drill ports free, disposable drill halves cleaned (evidence + ledger + lkg + candidates preserved)`, { residuePids: residue.map(item => item.pid), controlPortFree, acceptPortFree })
  const finalStatus = { pointer: await readLkgPointer(layout.lkgDir), chainOk: (await verifyLkgChain(layout.lkgDir, await readLedger(layout.ledgerPath))).ok, ledgerRecords: (await readLedger(layout.ledgerPath)).length }
  await writeJsonEvidence('drill-summary.json', { phases: ['P0', 'P1', 'P2', 'P3', 'P4a', 'P4b', 'P5', 'P6', 'P7'], finalStatus, drillLedger: drillLedgerPath })
  console.log(JSON.stringify({ drill: 'pass', drillDir, ledgerPath: drillLedgerPath, finalStatus }, null, 2))
}

main().catch(error => {
  console.error(`drill failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
