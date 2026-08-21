// M3-3 external rollback (issue #102, design §3.3): reinstall a previous
// LKG generation's frozen tarball into the stable control Profile and roll
// the numeric pointer back. Historical generation directories are immutable
// evidence — rollback never deletes or rewrites them; the failed generation
// stays on disk (design: "失败代目录转 evidence 归档").
//
// Sequence: quiesce → target integrity (digest recheck against the target's
// own immutable record) → remove+add → pointer rollback + ledger record →
// health re-probe. A failed re-probe reports loudly WITHOUT further
// automatic action (no rollback loops).
import { join, resolve } from 'node:path'
import {
  checkFencing, controlRootLayout, evaluateQuiesce, genDir, listNodeProcessesWindows,
  readJsonFile, readLedger, readLkgPointer, rollPointerBack, sha256File,
  verifyLkgChain,
} from './lib.mjs'
import { installIntoStableProfile, probeStablePlane } from './plane-ops.mjs'

function parseArgs(argv) {
  const args = { port: 47830, quiesceWindowMs: 120_000 }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`missing value for ${argument}`)
      return argv[index]
    }
    if (argument === '--dogfood-root') args.dogfoodRoot = resolve(next())
    else if (argument === '--cli') args.cli = resolve(next())
    else if (argument === '--port') args.port = Number(next())
    else if (argument === '--to-gen') args.toGen = Number(next())
    else if (argument === '--reason') args.reason = next()
    else if (argument === '--quiesce-window-ms') args.quiesceWindowMs = Number(next())
    else throw new Error(`unknown argument ${argument}`)
  }
  for (const required of ['dogfoodRoot', 'cli']) {
    if (args[required] === undefined) throw new Error(`--${required.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required`)
  }
  return args
}

export async function runRollback(args) {
  const layout = controlRootLayout(args.dogfoodRoot)
  const result = { steps: [] }
  const step = (name, outcome, detail) => result.steps.push({ name, outcome, detail })
  const ledgerRecords = await readLedger(layout.ledgerPath)
  const pointer = await readLkgPointer(layout.lkgDir)
  if (pointer === undefined) throw new Error('no LKG pointer exists — nothing to roll back')
  const chain = await verifyLkgChain(layout.lkgDir, ledgerRecords)
  if (!chain.ok) throw new Error(`LKG chain unhealthy before rollback — refusing: ${chain.failures.join('; ')}`)
  const target = args.toGen ?? pointer.prevGen
  const fencing = checkFencing(pointer, ledgerRecords, { action: 'rollback', toGen: target })
  if (!fencing.ok) throw new Error(`rollback fencing refused: ${fencing.reason}`)
  step('fencing', 'ok', fencing.reason)
  const quiesce = await evaluateQuiesce(
    { storageRoot: layout.controlStorage, sessionsRoot: layout.controlSessions, home: layout.controlHome },
    { windowMs: args.quiesceWindowMs, listNodeProcesses: listNodeProcessesWindows },
  )
  result.quiesce = quiesce
  if (!quiesce.quiet) {
    throw new Error(`quiesce refused: ${quiesce.criteria.filter(criterion => !criterion.pass).map(criterion => `${criterion.criterion}: ${criterion.detail}`).join('; ')}`)
  }
  step('quiesce', 'ok', quiesce.criteria.map(criterion => criterion.criterion).join('+'))
  const targetRecord = await readJsonFile(join(genDir(layout.lkgDir, target), 'lkg.json'))
  if (targetRecord === undefined) throw new Error(`rollback target lkg/g${target}/lkg.json missing (incomplete generation)`)
  const targetTarball = join(genDir(layout.lkgDir, target), 'dsh-agent-swarm.tgz')
  const digest = await sha256File(targetTarball).catch(() => undefined)
  if (digest === undefined || digest !== targetRecord.tarballSha256) {
    throw new Error(`rollback target g${target} tarball digest mismatch or missing — evidence tampered, refusing`)
  }
  step('target-integrity', 'ok', `g${target} tarball digest ${digest.slice(0, 16)}… matches its immutable record`)
  const install = await installIntoStableProfile({ cli: args.cli, layout, tarballPath: targetTarball })
  if (!install.ok) throw new Error(`stable Profile reinstall of g${target} failed at ${install.step}`)
  step('install-stable', 'ok', `g${target} remove+add + storage patch + dump-config identity green`)
  const record = await rollPointerBack(layout.lkgDir, layout.ledgerPath, target, {
    reason: args.reason ?? `rollback to previous generation g${target} (from g${pointer.currentGen})`,
    context: { fromGen: pointer.currentGen, failedGenPreserved: pointer.currentGen },
    profileIdentity: { profileName: 'web', dshHome: layout.controlHome },
  })
  step('pointer-rollback', 'ok', `currentGen ${pointer.currentGen} → ${target}, ledger record seq ${record.seq}; historical generations untouched`)
  const probe = await probeStablePlane({ cli: args.cli, layout, port: args.port })
  result.probe = probe.evidence
  if (!probe.ok) {
    step('health-probe', 'fail', 'stable plane unhealthy after rollback — MANUAL recovery required (no further automatic action)')
    console.log(JSON.stringify({ rolledBack: false, ...result }, null, 2))
    process.exitCode = 1
    return result
  }
  step('health-probe', 'ok', `stable plane healthy on g${target}`)
  const chainAfter = await verifyLkgChain(layout.lkgDir, await readLedger(layout.ledgerPath))
  if (!chainAfter.ok) throw new Error(`LKG chain unhealthy after rollback: ${chainAfter.failures.join('; ')}`)
  step('verify-chain-after', 'ok', `pointer g${chainAfter.pointer.currentGen}, chain + ledger fencing consistent`)
  console.log(JSON.stringify({ rolledBack: true, toGen: target, ...result }, null, 2))
  return result
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/promotion/rollback.mjs')) {
  try {
    await runRollback(parseArgs(process.argv.slice(2)))
  } catch (error) {
    console.error(`rollback failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
