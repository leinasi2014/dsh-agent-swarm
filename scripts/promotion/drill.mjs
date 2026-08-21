// M3-3 end-to-end drill (issue #102, design §4): ONE controlled dogfood of
// the whole candidate lifecycle — g0 baseline freeze → candidate freeze →
// acceptance (A0–A7, first drill on the FULL lane set) → external promote to
// g1 → BOTH failure injections (acceptance-rejection type on a deliberately
// defective commit; post-promotion-survival type on a drill-only stable copy
// with a corrupted artifact) → rollback → evidence packaging → zero-residue
// assertion.
//
// Issue #122 adds the H-phase hardening injections between P6 and P7, one per
// newly closed adversarial path, all live against the hardened code: H1 env
// seal sentinel (F2), H3 whole-chain ledger recomputation vs the git anchor
// (F5), H4 pointer/ledger divergence repair (F3), H5 installed-bytes
// reconciliation + status CLI (F3), H6 pruned-authority fail-safe (F6), H7
// half-applied promote compensation (F3). The P4b survival injection was
// upgraded by F4: the bare single-gate verdict is now refused first (live
// proof), then the strongest full forgery drives the probe-failure path.
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
  activeTeamsFromUnitText, appendLedgerRecord, checkFencing, controlRootLayout,
  ledgerRecordHash, ledgerGenState, listNodeProcessesWindows, readLedger,
  readLkgPointer, reconcileInstalledProfile, REQUIRED_VERDICT_GATES, sha256File,
  verifyLedgerAnchors, verifyLedgerChain, verifyLkgChain, writeJsonFile,
} from './lib.mjs'
import { extractTarball, git, run, waitPortFree } from './runner.mjs'
import { probeStablePlane } from './plane-ops.mjs'
import { FLOOR_LANES } from './freeze.mjs'
import { runAcceptance } from './accept-check.mjs'
import { runPromote } from './promote.mjs'
import { runRepair } from './repair.mjs'
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
  const promoteCli = extraArgs => runPromote({ dogfoodRoot: args.dogfoodRoot, repo: args.repo, cli: args.cli, port: args.controlPort, quiesceWindowMs: args.quiesceWindowMs, ...extraArgs })
  const stableProbe = async label => {
    const probe = await probeStablePlane({ cli: args.cli, layout, port: args.controlPort })
    await writeJsonEvidence(`stable-probe-${label}.json`, probe.evidence)
    if (!probe.ok) throw new Error(`stable plane probe ${label} failed`)
    return probe.evidence
  }
  /** Copy the lkg/ + ledger/ lineage into a fresh drill-only root (P4b/H-injection lineage). */
  const copyLineage = async dstRoot => {
    const dstLayout = controlRootLayout(dstRoot)
    for (const dir of [dstLayout.controlHome, dstLayout.controlStorage, dstLayout.controlSessions, dstLayout.candidatesDir, dstLayout.drillsDir, dirname(dstLayout.ledgerPath), dstLayout.lkgDir]) {
      await mkdir(dir, { recursive: true })
    }
    await copyFile(join(layout.lkgDir, 'lkg.json'), join(dstLayout.lkgDir, 'lkg.json'))
    for (const entry of await readdir(layout.lkgDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await mkdir(join(dstLayout.lkgDir, entry.name), { recursive: true })
        for (const file of await readdir(join(layout.lkgDir, entry.name))) {
          await copyFile(join(layout.lkgDir, entry.name, file), join(dstLayout.lkgDir, entry.name, file))
        }
      }
    }
    await copyFile(layout.ledgerPath, dstLayout.ledgerPath)
    return dstLayout
  }
  /**
   * The strongest acceptance forgery kit (issue #122 F4 closes the bare form;
   * this simulates a forger holding candidates/ + ledger write access): full
   * eight-gate vocabulary verdict with digest-consistent evidence files inside
   * the copy root's drills domain + an `accepted` ledger record whose
   * verdictRef/drillDir bind it. Containment is then the health probe +
   * auto-rollback, not the verdict check.
   */
  const forgeAcceptedKit = async (root, candidateId) => {
    const kitLayout = controlRootLayout(root)
    const candidateDir = join(kitLayout.candidatesDir, candidateId)
    const manifest = JSON.parse(await readFile(join(candidateDir, 'manifest.json'), 'utf8'))
    const drillSlug = `${stamp}-forge-${candidateId}`
    const forgedDrillDir = join(kitLayout.drillsDir, drillSlug)
    const forgedEvidence = join(forgedDrillDir, 'evidence')
    await mkdir(forgedEvidence, { recursive: true })
    const gates = []
    for (const name of REQUIRED_VERDICT_GATES) {
      const file = `${name}.json`
      await writeFile(join(forgedEvidence, file), JSON.stringify({ gate: name, forged: true }, null, 2))
      gates.push({ gate: name, status: 'pass', evidencePath: file, evidenceSha256: await sha256File(join(forgedEvidence, file)) })
    }
    const verdict = {
      schemaVersion: 1, candidateId, tarballSha256: manifest.tarballSha256, overall: 'pass', gates,
      run: { drillDir: forgedDrillDir, lanes: 'floor', laneList: FLOOR_LANES, cli: args.cli, port: args.acceptPort, profile: 'web', injected: true, finishedAt: new Date().toISOString() },
    }
    await writeJsonFile(join(candidateDir, 'acceptance-verdict.json'), verdict)
    const verdictDigest = await sha256File(join(candidateDir, 'acceptance-verdict.json'))
    const record = await appendLedgerRecord(kitLayout.ledgerPath, {
      action: 'accepted', actor: 'drill-injection', candidateId,
      gitCommit: manifest.gitCommit, gitTree: manifest.gitTree,
      tarballSha256: manifest.tarballSha256, tarballBytes: manifest.tarballBytes,
      fromGen: null, toGen: null,
      record: { reason: 'drill full-forgery kit: eight-gate verdict + digest-consistent evidence + verdictRef binding — the strongest form a candidates/+ledger write-access forger can build; contained downstream by the health probe + auto-rollback (issue #122 F4/H7)', drillDir: forgedDrillDir },
      profileIdentity: null, verdictRef: { candidateId, sha256: verdictDigest },
    })
    return { forgedDrillDir, verdictDigest, ledgerSeq: record.seq }
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
  // Issue #122 F4 changed this phase: the OLD bare single-gate forged verdict
  // (the review's own demonstration of the promoter's weak check) is now
  // REFUSED, so the phase first injects it to prove the refusal live, then
  // upgrades the forgery to the strongest form (eight-gate vocabulary +
  // digest-consistent evidence + a bound `accepted` ledger record) to drive
  // the promoter into its probe-failure path exactly as before.
  const copyRoot = join(drillDir, 'stable-copy-root')
  const copyLayout = await copyLineage(copyRoot)
  const corruptedId = `${candidateId}-corrupted`
  const corruptedDir = join(copyLayout.candidatesDir, corruptedId)
  await mkdir(corruptedDir, { recursive: true })
  const corruptedTarball = await createCorruptedTarball(join(layout.candidatesDir, candidateId, 'dsh-agent-swarm.tgz'), copyRoot)
  await copyFile(corruptedTarball, join(corruptedDir, 'dsh-agent-swarm.tgz'))
  const corruptedDigest = await sha256File(join(corruptedDir, 'dsh-agent-swarm.tgz'))
  const corruptedBytes = (await stat(join(corruptedDir, 'dsh-agent-swarm.tgz'))).size
  const sourceManifest = JSON.parse(await readFile(join(layout.candidatesDir, candidateId, 'manifest.json'), 'utf8'))
  await writeFile(join(corruptedDir, 'manifest.json'), `${JSON.stringify({ ...sourceManifest, candidateId: corruptedId, tarballSha256: corruptedDigest, tarballBytes: corruptedBytes, builtBy: 'drill-injection@p4b', injected: 'P4(b) post-promotion survival injection: plugin entry throws on import; digests are self-consistent so promote reaches the health-probe step by design' }, null, 2)}\n`, 'utf8')
  // (1) BARE verdict + bound accepted record — the F4 refusal, live.
  await writeFile(join(corruptedDir, 'acceptance-verdict.json'), `${JSON.stringify({ schemaVersion: 1, candidateId: corruptedId, tarballSha256: corruptedDigest, overall: 'pass', gates: [{ gate: 'injected', status: 'pass', detail: 'P4(b) bare forged verdict: single unnamed-vocabulary gate, no evidence — the pre-F4 promoter accepted exactly this form' }], run: { injected: true, finishedAt: new Date().toISOString() } }, null, 2)}\n`, 'utf8')
  const bareDigest = await sha256File(join(corruptedDir, 'acceptance-verdict.json'))
  await appendLedgerRecord(copyLayout.ledgerPath, {
    action: 'accepted', actor: 'drill-injection', candidateId: corruptedId,
    gitCommit: sourceManifest.gitCommit, gitTree: sourceManifest.gitTree,
    tarballSha256: corruptedDigest, tarballBytes: corruptedBytes,
    fromGen: null, toGen: null,
    record: { reason: 'P4(b) bare-verdict injection layer: binds the bare verdict so the refusal must come from the gate-vocabulary/evidence rules, not the missing record', drillDir: join(copyLayout.drillsDir, `${stamp}-forge-bare-${corruptedId}`) },
    profileIdentity: null, verdictRef: { candidateId: corruptedId, sha256: bareDigest },
  })
  const bareRefusal = await promoteCli({ dogfoodRoot: copyRoot, candidate: corruptedId, quiesceWindowMs: 100 }).catch(error => ({ refused: String(error) }))
  process.exitCode = 0
  const bareRefused = typeof bareRefusal?.refused === 'string'
    && /acceptance verdict refused/.test(bareRefusal.refused)
    && /required gate missing|evidencePath missing|unknown gate name/.test(bareRefusal.refused)
  if (!bareRefused) throw new Error(`P4(b) FAILED: the bare single-gate verdict was not refused by the F4 rules (${String(bareRefusal?.refused ?? bareRefusal?.autoRolledBack).slice(0, 400)}`)
  // (2) FULL forgery kit — reaches the probe by design.
  const forged = await forgeAcceptedKit(copyRoot, corruptedId)
  const pointerBeforeP4b = await readLkgPointer(layout.lkgDir)
  const p4b = await runPromote({ dogfoodRoot: copyRoot, repo: args.repo, candidate: corruptedId, cli: args.cli, port: args.controlPort, quiesceWindowMs: 100 }).catch(error => ({ thrown: String(error) }))
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
  await drillRecord('P4b', 'pass', 'F4 live: the bare single-gate verdict (bound to an accepted ledger record) is REFUSED by the gate-vocabulary/evidence rules; the upgraded full eight-gate forgery then reached the health probe inside the drill-only stable COPY lineage, failed it, and the bounded auto-rollback restored g1 (failed g2 directory preserved as evidence); the REAL root pointer and lineage untouched', {
    injection: {
      type: 'post-promotion-survival',
      mechanism: 'tarball repacked with an import-throwing plugin entry + self-consistent manifest, driven twice: (1) bare single-gate verdict + bound accepted record → refused by F4 rules; (2) full eight-gate forgery + digest-consistent evidence + bound accepted record → probe red → auto-rollback',
      expected: '(1) refusal naming the gate/evidence rules; (2) auto-rollback to previous generation → failed generation kept as evidence → real root untouched',
      actual: `(1) refused: ${String(bareRefusal.refused).slice(0, 300)}; (2) autoRolledBack=true, reprobeOk=${p4b.autoRollback?.reprobeOk}, copy pointer g${copyPointer.currentGen}, g2 preserved=${g2Preserved}`,
    },
    bareRefusal: String(bareRefusal.refused).slice(0, 500),
    forgedKit: { forgedDrillDir: forged.forgedDrillDir, verdictDigest: forged.verdictDigest, acceptedLedgerSeq: forged.ledgerSeq },
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

  // ── H1..H7: hardening injections (issue #122) — each newly closed adversarial ──
  // path injected once against the hardened code, live. All copy lineages stay
  // inside the drill domain; the REAL root's pointer/ledger are never inputs.

  // H1 (F2): a PM-session sentinel env var must be invisible inside
  // promotion-lane children (the same spawn path the acceptance lanes use).
  const sentinel = 'DSH_DRILL_SENTINEL_F2'
  process.env[sentinel] = 'pm-secret-material'
  try {
    const probe = await run(process.execPath, ['-e', `console.log(process.env.${sentinel} === undefined ? 'sealed' : 'LEAKED', process.env.PATH === undefined ? 'no-path' : 'path-ok', process.env.TEMP === undefined ? 'no-temp' : 'temp-ok')`])
    const sealed = probe.code === 0 && probe.stdout.trim() === 'sealed path-ok temp-ok'
    if (!sealed) throw new Error(`H1 FAILED: promotion-lane child saw the PM session env (${probe.stdout.trim().slice(0, 200)})`)
    await drillRecord('H1', 'pass', 'F2: PM-session sentinel env is invisible inside promotion-lane children (allowlist env), PATH/TEMP still flow', { laneProbe: probe.stdout.trim() })
  } finally {
    delete process.env[sentinel]
  }

  // H3 (F5): a whole-chain recomputation of the ledger (self-consistent
  // hashes) must be exposed by the git chain-tail anchor; the untampered
  // lineage must verify against its anchor.
  const h3Root = join(drillDir, 'stable-copy-root-h3')
  const h3Layout = await copyLineage(h3Root)
  const h3Records = await readLedger(h3Layout.ledgerPath)
  const anchorsOk = await verifyLedgerAnchors({ repo: args.repo, records: h3Records })
  if (!anchorsOk.ok || anchorsOk.anchorTag === undefined) {
    throw new Error(`H3 FAILED: the untampered lineage does not verify against its git anchor (${JSON.stringify(anchorsOk).slice(0, 300)})`)
  }
  const tampered = h3Records.map(record => ({ ...record }))
  const promoteIndex = tampered.map(record => record.action).lastIndexOf('promote')
  if (promoteIndex < 0) throw new Error('H3 FAILED: no promote record to tamper')
  tampered[promoteIndex].candidateId = 'forged-by-write-access'
  let h3PreviousHash = 'GENESIS'
  const recomputed = tampered.map(record => {
    const { seq, time, recordSha256: _oldHash, prevRecordSha256: _oldPrev, ...body } = record
    const hash = ledgerRecordHash(h3PreviousHash, { ...body, seq, time })
    const next = { ...record, prevRecordSha256: h3PreviousHash, recordSha256: hash }
    h3PreviousHash = hash
    return next
  })
  const chainSelfConsistent = verifyLedgerChain(recomputed).ok
  const anchorsBroken = await verifyLedgerAnchors({ repo: args.repo, records: recomputed })
  if (chainSelfConsistent !== true) throw new Error('H3 FAILED: fixture error — the recomputed chain is not even internally consistent')
  if (anchorsBroken.ok !== false) throw new Error('H3 FAILED: a whole-chain recomputation was NOT exposed by the git chain-tail anchor')
  await drillRecord('H3', 'pass', `F5: whole-chain ledger recomputation (internally self-consistent, forged candidateId on the seq-${tampered[promoteIndex].seq} promote record) is detected by the chain-tail anchor ${anchorsOk.anchorTag}; the untampered lineage verifies against it`, {
    untamperedAnchor: { tag: anchorsOk.anchorTag, latest: anchorsOk.latest },
    recomputedDetection: anchorsBroken.failures,
  })

  // H4 (F3): pointer/ledger generational divergence (crash between pointer
  // write and ledger append) fences everything; repair re-anchors the pointer
  // onto the ledger tail after explicit confirmation.
  const h4Root = join(drillDir, 'stable-copy-root-h4')
  const h4Layout = await copyLineage(h4Root)
  const h4Ledger = await readLedger(h4Layout.ledgerPath)
  const h4LedgerGen = ledgerGenState(h4Ledger).currentGen
  const h4DivergentPointer = { ...(await readLkgPointer(h4Layout.lkgDir)), currentGen: h4LedgerGen + 2, prevGen: h4LedgerGen, currentTarballSha256: '0'.repeat(64), updatedAt: new Date().toISOString() }
  await writeJsonFile(join(h4Layout.lkgDir, 'lkg.json'), h4DivergentPointer)
  const fenced = checkFencing(await readLkgPointer(h4Layout.lkgDir), h4Ledger, { action: 'promote' })
  const fencedRollback = checkFencing(await readLkgPointer(h4Layout.lkgDir), h4Ledger, { action: 'rollback', toGen: h4LedgerGen })
  if (fenced.ok || fencedRollback.ok) throw new Error('H4 FAILED: fixture error — the divergent pointer did not fence promote/rollback')
  const repairDryRun = await runRepair({ dogfoodRoot: h4Root })
  const dryRunLeftDivergence = repairDryRun.divergences.pointerLedgerDiverged === true
    && repairDryRun.actions.some(action => action.action === 're-anchor-pointer' && typeof action.detail === 'string')
    && (await readLkgPointer(h4Layout.lkgDir)).currentGen === h4DivergentPointer.currentGen
  if (!dryRunLeftDivergence) throw new Error('H4 FAILED: repair dry-run did not report the divergence untouched')
  const repairRun = await runRepair({ dogfoodRoot: h4Root, yes: true })
  const h4PointerAfter = await readLkgPointer(h4Layout.lkgDir)
  const h4LedgerAfter = await readLedger(h4Layout.ledgerPath)
  const repairRecord = h4LedgerAfter.find(record => record.action === 'repair')
  const fencedAfter = checkFencing(h4PointerAfter, h4LedgerAfter, { action: 'promote' })
  if (h4PointerAfter.currentGen !== h4LedgerGen || repairRecord === undefined || !fencedAfter.ok || !(await verifyLkgChain(h4Layout.lkgDir, h4LedgerAfter)).ok) {
    throw new Error(`H4 FAILED: repair did not re-anchor cleanly (pointer g${h4PointerAfter?.currentGen} vs ledger g${h4LedgerGen}, repairRecord=${repairRecord !== undefined}, fencedAfter=${fencedAfter.ok})`)
  }
  await drillRecord('H4', 'pass', `F3: pointer/ledger divergence fenced both promote and rollback; repair dry-run reported without touching state; --yes re-anchored the pointer onto the ledger tail g${h4LedgerGen} with a repair ledger record (seq ${repairRecord.seq}); fencing passes again`, {
    divergentPointerGen: h4DivergentPointer.currentGen,
    reanchoredToGen: h4PointerAfter.currentGen,
    repairLedgerSeq: repairRecord.seq,
  })

  // H5 (F3): the LIVE stable Profile's installed bytes reconcile with the
  // pointer generation's tarball; a mutated expected tree must NOT reconcile
  // (the comparison is not vacuous); the status CLI face exits green.
  const reconcileLive = await reconcileInstalledProfile({ layout, pointer: await readLkgPointer(layout.lkgDir), extract: extractTarball })
  if (reconcileLive.checked !== true || reconcileLive.matches !== true) {
    throw new Error(`H5 FAILED: healthy stable Profile bytes do not reconcile with the pointer generation tarball (${JSON.stringify(reconcileLive).slice(0, 400)})`)
  }
  const reconcileNegative = await reconcileInstalledProfile({
    layout, pointer: await readLkgPointer(layout.lkgDir),
    extract: async (tarball, destDir) => {
      await extractTarball(tarball, destDir)
      const indexFile = join(destDir, 'package', 'lib', 'index.mjs')
      await writeFile(indexFile, `${await readFile(indexFile, 'utf8')}\n// H5 mutation: a half-applied or tampered install\n`)
    },
  })
  if (reconcileNegative.checked !== true || reconcileNegative.matches !== false) {
    throw new Error('H5 FAILED: a mutated expected tree still reconciled — the comparison is vacuous')
  }
  const statusRun = await run(process.execPath, [join(import.meta.dirname, 'status.mjs'), '--dogfood-root', args.dogfoodRoot, '--repo', args.repo], { timeoutMs: 5 * 60_000 })
  let statusParsed = null
  try { statusParsed = JSON.parse(statusRun.stdout) } catch { /* reported below */ }
  if (statusRun.code !== 0 || statusParsed?.ok !== true || statusParsed?.installedProfile?.matches !== true || statusParsed?.anchors?.anchorTag === undefined) {
    throw new Error(`H5 FAILED: status CLI not green (exit ${statusRun.code}, ok=${statusParsed?.ok}, installedMatches=${statusParsed?.installedProfile?.matches}, anchor=${statusParsed?.anchors?.anchorTag}): ${(statusParsed?.chainFailures ?? statusRun.stderr).slice?.(0, 400) ?? String(statusParsed).slice(0, 400)}`)
  }
  await drillRecord('H5', 'pass', `F3: installed-bytes reconciliation matches live (installed digest ${reconcileLive.installedContentSha256.slice(0, 16)}… == g${reconcileLive.pointerGen} tarball tree); mutated-tree negative probe mismatches; status CLI exit 0 with chainOk + anchors (${statusParsed.anchors.anchorTag})`, {
    live: { pointerGen: reconcileLive.pointerGen, installedContentSha256: reconcileLive.installedContentSha256, expectedContentSha256: reconcileLive.expectedContentSha256 },
    negativeProbeMatches: reconcileNegative.matches,
    statusExit: statusRun.code,
  })

  // H6 (F6): a pruned/empty agent_swarm authority unit fails safe as ACTIVE;
  // an absent file (fresh root) still reads quiet.
  const h6MissingTable = activeTeamsFromUnitText(JSON.stringify({ tables: {} }))
  const h6EmptyFile = activeTeamsFromUnitText('')
  const h6Absent = activeTeamsFromUnitText(undefined)
  if (h6MissingTable.length === 0 || h6EmptyFile.length === 0 || h6Absent.length !== 0) {
    throw new Error(`H6 FAILED: fail-safe faces wrong (missing-table=${h6MissingTable.length}, empty=${h6EmptyFile.length}, absent=${h6Absent.length})`)
  }
  await drillRecord('H6', 'pass', 'F6: parseable unit with tables.teams pruned and an empty unit file both read ACTIVE (fail-safe); an absent unit (fresh root) still reads quiet', {
    missingTable: h6MissingTable, emptyFile: h6EmptyFile, absent: h6Absent,
  })

  // H7 (F3): a promote whose establishGeneration fails AFTER the stable
  // Profile install must compensate by re-installing the previous
  // generation's tarball — injected live via an unwritable gen-record path.
  const h7Root = join(drillDir, 'stable-copy-root-h7')
  const h7Layout = await copyLineage(h7Root)
  await mkdir(join(h7Layout.candidatesDir, candidateId), { recursive: true })
  for (const file of ['manifest.json', 'dsh-agent-swarm.tgz']) {
    await copyFile(join(layout.candidatesDir, candidateId, file), join(h7Layout.candidatesDir, candidateId, file))
  }
  const h7Kit = await forgeAcceptedKit(h7Root, candidateId)
  const h7PointerBefore = await readLkgPointer(h7Layout.lkgDir)
  const h7LedgerBefore = await readLedger(h7Layout.ledgerPath)
  // The copy lineage sits at g0 (post-P5 rollback), so this promote targets
  // g1: make the g1 generation-record path UNWRITABLE (a directory) so
  // establishGeneration fails AFTER the stable Profile install.
  await rm(join(h7Layout.lkgDir, 'g1', 'lkg.json'), { force: true, maxRetries: 5, retryDelay: 100 })
  await mkdir(join(h7Layout.lkgDir, 'g1', 'lkg.json'), { recursive: true })
  const h7 = await runPromote({ dogfoodRoot: h7Root, repo: args.repo, candidate: candidateId, cli: args.cli, port: args.controlPort, quiesceWindowMs: 100 })
    .catch(error => ({ thrown: String(error), promoteResult: error?.promoteResult }))
  process.exitCode = 0
  const h7Compensated = h7.thrown !== undefined
    && h7.promoteResult?.steps?.some(step => step.name === 'compensate-reinstall' && step.outcome === 'ok') === true
  const h7PointerAfter = await readLkgPointer(h7Layout.lkgDir)
  const h7Reconcile = await reconcileInstalledProfile({ layout: h7Layout, pointer: h7PointerAfter, extract: extractTarball })
  const h7LedgerAfter = await readLedger(h7Layout.ledgerPath)
  const h7NoLedgerMove = h7LedgerAfter.length === h7LedgerBefore.length
    && h7LedgerAfter.at(-1)?.seq === h7LedgerBefore.at(-1)?.seq
  if (!h7Compensated || h7PointerAfter.currentGen !== h7PointerBefore.currentGen || h7PointerAfter.updatedAt !== h7PointerBefore.updatedAt || !h7NoLedgerMove || h7Reconcile.matches !== true) {
    throw new Error(`H7 FAILED: compensated=${h7Compensated} pointer g${h7PointerAfter?.currentGen}@${h7PointerAfter?.updatedAt} (was g${h7PointerBefore.currentGen}@${h7PointerBefore.updatedAt}) noLedgerMove=${h7NoLedgerMove} reconcileMatches=${h7Reconcile.matches} thrown=${String(h7.thrown).slice(0, 200)}`)
  }
  await drillRecord('H7', 'pass', `F3: establishGeneration failure after the stable install (injected: unwritable g1 gen-record path) left the copy pointer/ledger untouched and the promoter COMPENSATED by re-installing the previous generation g${h7PointerBefore.currentGen}; installed bytes reconcile with the pointer again`, {
    injectedFailure: 'lkg/g1/lkg.json pre-created as a directory — the generation-record write fails after the Profile install',
    thrown: String(h7.thrown).slice(0, 300),
    compensateStep: h7.promoteResult?.steps?.find(step => step.name === 'compensate-reinstall'),
    pointerGenAfter: h7PointerAfter.currentGen,
    reconcileMatches: h7Reconcile.matches,
    forgedKit: { forgedDrillDir: h7Kit.forgedDrillDir, verdictDigest: h7Kit.verdictDigest },
  })

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
      for (const copyRootName of ['stable-copy-root', 'stable-copy-root-h3', 'stable-copy-root-h4', 'stable-copy-root-h7']) {
        await rm(join(path, copyRootName), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
      }
    }
    for (const disposable of ['home', 'workspace', 'storage-root', 'sessions-root']) {
      await rm(join(path, disposable), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
    }
  }
  await drillRecord('P7', 'pass', `zero process residue (${residue.length} external processes reference the dogfood root), both drill ports free, disposable drill halves + hardening copy lineages cleaned (evidence + ledger + lkg + candidates preserved)`, { residuePids: residue.map(item => item.pid), controlPortFree, acceptPortFree })
  const finalStatus = { pointer: await readLkgPointer(layout.lkgDir), chainOk: (await verifyLkgChain(layout.lkgDir, await readLedger(layout.ledgerPath))).ok, ledgerRecords: (await readLedger(layout.ledgerPath)).length, anchors: await verifyLedgerAnchors({ repo: args.repo, records: await readLedger(layout.ledgerPath) }) }
  await writeJsonEvidence('drill-summary.json', { phases: ['P0', 'P1', 'P2', 'P3', 'P4a', 'P4b', 'P5', 'P6', 'H1', 'H3', 'H4', 'H5', 'H6', 'H7', 'P7'], finalStatus, drillLedger: drillLedgerPath })
  console.log(JSON.stringify({ drill: 'pass', drillDir, ledgerPath: drillLedgerPath, finalStatus }, null, 2))
}

main().catch(error => {
  console.error(`drill failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
