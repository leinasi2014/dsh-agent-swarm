// M3-3 external promoter (issue #102, design §3.1; ADR-0008 promotion rule):
// the ONLY writer of lkg/, ledger/ and the stable control Profile. Runs from
// the stable main checkout as an external process — the candidate plugin can
// never promote itself, and the promoter is never loaded from the candidate
// artifact (it lives in scripts/, outside the shipped package).
//
// promote sequence: read manifest+verdict → digest/verdict verification
// (issue #122 F4: eight-gate vocabulary + per-gate evidence triple presence +
// accepted-ledger verdictRef/drillDir cross-check) → generational fencing →
// quiesce (three criteria, fail-loud, never wait) → remove+add the tarball
// into the stable Profile → write lkg/g<N> + pointer + ledger record →
// health probe → probe failure triggers the bounded AUTO-ROLLBACK to the
// previous generation (failed generation directory is preserved as immutable
// evidence, never deleted) → anchor the ledger chain tail as a local
// annotated git tag `d2-ledger-<gen>` (issue #122 F5, OQ-11 reversal).
//
// Half-applied state (issue #122 F3): if establishGeneration fails AFTER the
// stable Profile install, the previous generation's tarball is re-installed
// as compensation so the installed bytes match the untouched pointer again.
//
// `--establish` bootstraps generation g0 (the current main as
// last-known-good) without an acceptance verdict — the design's P0 form.
import { join, resolve } from 'node:path'
import {
  anchorLedgerTail, checkFencing, controlRootLayout, crossCheckAcceptedVerdict,
  establishGeneration, evaluateQuiesce, genDir, listNodeProcessesWindows,
  readJsonFile, readLedger, readLkgPointer, rollPointerBack, sha256File,
  verifyArtifactAgainstManifest, verifyLkgChain,
} from './lib.mjs'
import { installIntoStableProfile, probeStablePlane } from './plane-ops.mjs'

function parseArgs(argv) {
  const args = { port: 47830, quiesceWindowMs: 120_000, establish: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`missing value for ${argument}`)
      return argv[index]
    }
    if (argument === '--dogfood-root') args.dogfoodRoot = resolve(next())
    else if (argument === '--candidate') args.candidate = next()
    else if (argument === '--cli') args.cli = resolve(next())
    else if (argument === '--repo') args.repo = resolve(next())
    else if (argument === '--port') args.port = Number(next())
    else if (argument === '--expect-gen') args.expectGen = Number(next())
    else if (argument === '--quiesce-window-ms') args.quiesceWindowMs = Number(next())
    else if (argument === '--establish') args.establish = true
    else throw new Error(`unknown argument ${argument}`)
  }
  for (const required of ['dogfoodRoot', 'candidate', 'cli', 'repo']) {
    if (args[required] === undefined) throw new Error(`--${required.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required`)
  }
  return args
}

export async function runPromote(args) {
  const layout = controlRootLayout(args.dogfoodRoot)
  const candidateDir = join(layout.candidatesDir, args.candidate)
  const manifest = await readJsonFile(join(candidateDir, 'manifest.json'))
  const tarballPath = join(candidateDir, 'dsh-agent-swarm.tgz')
  const result = { candidateId: args.candidate, steps: [] }
  const step = (name, outcome, detail) => result.steps.push({ name, outcome, detail })
  const artifact = await verifyArtifactAgainstManifest(manifest, tarballPath)
  if (!artifact.ok) throw new Error(`candidate artifact verification failed: ${artifact.failures.join('; ')}`)
  step('verify-manifest', 'ok', `digest ${manifest.tarballSha256.slice(0, 16)}… matches`)
  const ledgerRecords = await readLedger(layout.ledgerPath)
  let verdictDigest = null
  if (!args.establish) {
    // F4: the verdict is promotion input ONLY as the recorded evidence of the
    // acceptance lane — full gate vocabulary + evidence digests re-verified
    // against the accepted ledger record's drill evidence tree.
    const verdict = await readJsonFile(join(candidateDir, 'acceptance-verdict.json'))
    verdictDigest = await sha256File(join(candidateDir, 'acceptance-verdict.json'))
    const cross = await crossCheckAcceptedVerdict({
      verdict, manifest, verdictDigest, ledgerRecords, drillsDir: layout.drillsDir,
    })
    if (!cross.ok) throw new Error(`acceptance verdict refused: ${cross.failures.join('; ')}`)
    step('verify-verdict', 'ok', `full gate set + evidence digests verified against the accepted ledger record (seq ${cross.acceptedSeq}, drill ${cross.drillDir}), verdict digest ${verdictDigest.slice(0, 16)}…`)
  }
  const pointer = await readLkgPointer(layout.lkgDir)
  const chainBefore = await verifyLkgChain(layout.lkgDir, ledgerRecords)
  if (pointer !== undefined && !chainBefore.ok) {
    throw new Error(`LKG chain unhealthy before promote — refusing: ${chainBefore.failures.join('; ')}`)
  }
  const fencing = checkFencing(pointer, ledgerRecords, { action: args.establish ? 'establish' : 'promote', expectGen: args.expectGen })
  if (!fencing.ok) throw new Error(`generational fencing refused: ${fencing.reason}`)
  step('fencing', 'ok', fencing.reason)
  const quiesce = await evaluateQuiesce(
    { storageRoot: layout.controlStorage, sessionsRoot: layout.controlSessions, home: layout.controlHome },
    { windowMs: args.quiesceWindowMs, listNodeProcesses: listNodeProcessesWindows },
  )
  result.quiesce = quiesce
  if (!quiesce.quiet) {
    throw new Error(`quiesce refused (stage boundary not still): ${quiesce.criteria.filter(criterion => !criterion.pass).map(criterion => `${criterion.criterion}: ${criterion.detail}`).join('; ')}`)
  }
  step('quiesce', 'ok', quiesce.criteria.map(criterion => criterion.criterion).join('+'))
  const install = await installIntoStableProfile({ cli: args.cli, layout, tarballPath })
  if (!install.ok) {
    throw new Error(`stable Profile install failed at ${install.step}: ${(install.addResult ?? install.dump)?.stderr?.slice(0, 800) ?? 'see steps'}`)
  }
  step('install-stable', 'ok', 'remove+add + storage patch + dump-config identity green')
  const gen = args.establish ? 0 : pointer.currentGen + 1
  let established
  try {
    established = await establishGeneration(layout.lkgDir, layout.ledgerPath, {
      action: args.establish ? 'gen-established' : 'promote',
      gen,
      prevGen: args.establish ? null : pointer.currentGen,
      tarballPath,
      candidateId: manifest.candidateId,
      gitCommit: manifest.gitCommit,
      gitTree: manifest.gitTree,
      tarballSha256: manifest.tarballSha256,
      tarballBytes: manifest.tarballBytes,
      verdictRef: verdictDigest === null ? null : { candidateId: manifest.candidateId, sha256: verdictDigest },
      reason: args.establish ? 'g0 establishment: current main observed as last-known-good (design P0)' : undefined,
      profileIdentity: { profileName: 'web', dshHome: layout.controlHome },
      expectPrevGen: args.establish ? undefined : pointer.currentGen,
    })
  } catch (error) {
    // F3 half-applied compensation: the stable Profile already carries the
    // candidate bytes while the pointer/ledger transition failed — re-install
    // the PREVIOUS generation's frozen tarball so installed bytes match the
    // (unchanged) pointer again. The failure itself stays loud.
    step('establish-generation', 'fail', error instanceof Error ? error.message : String(error))
    if (args.establish || pointer === undefined) {
      throw new Error(`g0 establishment failed mid-apply with no previous generation to compensate: ${error instanceof Error ? error.message : String(error)} — run status (installed-bytes reconciliation) and repair manually`)
    }
    const previousTarball = join(genDir(layout.lkgDir, pointer.currentGen), 'dsh-agent-swarm.tgz')
    const compensate = await installIntoStableProfile({ cli: args.cli, layout, tarballPath: previousTarball })
    if (compensate.ok) {
      step('compensate-reinstall', 'ok', `stable Profile re-installed from lkg/g${pointer.currentGen} after the failed generation establish — pointer/ledger untouched, installed bytes reconciled`)
    } else {
      step('compensate-reinstall', 'fail', `COMPENSATION FAILED at ${compensate.step} — stable Profile left on candidate bytes with the pointer at g${pointer.currentGen}; run status (installed-bytes reconciliation) and repair/rollback manually`)
    }
    // The half-apply evidence (steps) must survive the throw — drill/tooling
    // introspects `error.promoteResult` to assert the compensation ran.
    throw Object.assign(error, { promoteResult: result })
  }
  step('establish-generation', 'ok', `lkg/g${gen} + pointer + ledger record seq ${established.ledgerRecord.seq}`)
  const probe = await probeStablePlane({ cli: args.cli, layout, port: args.port })
  result.probe = probe.evidence
  if (!probe.ok) {
    step('health-probe', 'fail', `stable plane unhealthy after promote: dump=${probe.evidence.dumpConfigOk} boot=${probe.evidence.bootReady} describe=${probe.evidence.describe?.ok} portFree=${probe.evidence.portFreeAfterTeardown}`)
    if (args.establish) {
      throw new Error(`g0 establishment health probe failed — no previous generation to roll back to; probe evidence: ${JSON.stringify(probe.evidence).slice(0, 800)}`)
    }
    const previousTarball = join(genDir(layout.lkgDir, pointer.currentGen), 'dsh-agent-swarm.tgz')
    const reinstall = await installIntoStableProfile({ cli: args.cli, layout, tarballPath: previousTarball })
    if (!reinstall.ok) throw new Error(`AUTO-ROLLBACK FAILED at reinstall — stable Profile left on the failed generation; manual recovery required (${reinstall.step})`)
    const rollbackRecord = await rollPointerBack(layout.lkgDir, layout.ledgerPath, pointer.currentGen, {
      reason: `health-probe failed after promote of ${manifest.candidateId} — auto-rollback (failed g${gen} directory preserved as evidence)`,
      context: { probe: { dumpConfigOk: probe.evidence.dumpConfigOk, bootReady: probe.evidence.bootReady, describeOk: probe.evidence.describe?.ok, portFreeAfterTeardown: probe.evidence.portFreeAfterTeardown } },
      profileIdentity: { profileName: 'web', dshHome: layout.controlHome },
    })
    const reprobe = await probeStablePlane({ cli: args.cli, layout, port: args.port })
    result.autoRollback = { rollbackLedgerSeq: rollbackRecord.seq, reprobeOk: reprobe.ok }
    result.autoRolledBack = true
    step('auto-rollback', reprobe.ok ? 'rolled-back' : 'rollback-probe-failed', `pointer back to g${pointer.currentGen}, ledger seq ${rollbackRecord.seq}, reprobe=${reprobe.ok}`)
    console.log(JSON.stringify({ promoted: false, autoRolledBack: true, ...result }, null, 2))
    process.exitCode = 1
    return result
  }
  step('health-probe', 'ok', `stable plane healthy on g${gen} (dump-config + boot + host.describe home identity)`)
  const chainAfter = await verifyLkgChain(layout.lkgDir, await readLedger(layout.ledgerPath))
  if (!chainAfter.ok) throw new Error(`LKG chain unhealthy after promote: ${chainAfter.failures.join('; ')}`)
  step('verify-chain-after', 'ok', `pointer g${chainAfter.pointer.currentGen}, chain + ledger fencing consistent`)
  // F5: anchor the chain tail of THIS promotion as a local annotated tag. A
  // failure here does not un-promote a healthy generation (the ledger record
  // already exists); it marks the run failed and status keeps flagging the
  // missing anchor until it is repaired.
  try {
    const anchor = await anchorLedgerTail({
      repo: args.repo,
      gen,
      seq: established.ledgerRecord.seq,
      tailRecordSha256: established.ledgerRecord.recordSha256,
      action: established.ledgerRecord.action,
    })
    result.anchorTag = anchor.tagName
    step('anchor-ledger-tail', 'ok', `tag ${anchor.tagName} ${anchor.alreadyAnchored ? 'already carries' : 'now carries'} tail ${established.ledgerRecord.recordSha256.slice(0, 16)}… (OQ-11 reversal, issue #122 F5)`)
  } catch (error) {
    step('anchor-ledger-tail', 'fail', `${error instanceof Error ? error.message : String(error)} — promotion stands, but status will flag the missing chain-tail anchor until repaired`)
    result.anchorFailed = true
  }
  const anchorFailed = result.anchorFailed === true
  console.log(JSON.stringify({ promoted: true, gen, ...result }, null, 2))
  if (anchorFailed) process.exitCode = 1
  return result
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/promotion/promote.mjs')) {
  try {
    await runPromote(parseArgs(process.argv.slice(2)))
  } catch (error) {
    console.error(`promote failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
