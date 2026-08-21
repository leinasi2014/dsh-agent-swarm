// D2 hardening repair lane (issue #122, F3): detect and — only with explicit
// confirmation — repair control-plane state divergences left by a crash
// window or a half-applied promote:
//
//   1. pointer/ledger generational divergence (a promote that died between
//      the pointer write and the ledger append leaves `checkFencing`
//      refusing EVERY later action — promote and rollback both — with no
//      recovery tool). The hash-chained ledger is the authority; the numeric
//      pointer is derived state. Repair re-anchors the pointer onto the
//      ledger tail's generation and appends a `repair` ledger record
//      documenting the divergent pointer it replaced.
//   2. installed-bytes divergence (stable Profile bytes ≠ the pointer's
//      generation tarball — the F3 half-apply face status reconciles). With
//      --reinstall (plus --cli), the pointer generation's frozen tarball is
//      re-installed into the stable Profile.
//
// Without --yes repair is a DRY RUN: it reports every divergence and the
// exact actions it would take, and exits 1 when any divergence exists. It
// always REFUSES to operate on a ledger whose chain does not verify — that
// is evidence tampering (see the F5 git anchors), not a crash window.
import { join, resolve } from 'node:path'
import {
  appendLedgerRecord, controlRootLayout, genDir, ledgerGenState, readJsonFile,
  readLedger, readLkgPointer, reconcileInstalledProfile, sha256File,
  verifyLedgerChain, writeJsonFile,
} from './lib.mjs'
import { extractTarball } from './runner.mjs'
import { installIntoStableProfile } from './plane-ops.mjs'

function parseArgs(argv) {
  const args = { yes: false, reinstall: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`missing value for ${argument}`)
      return argv[index]
    }
    if (argument === '--dogfood-root') args.dogfoodRoot = resolve(next())
    else if (argument === '--cli') args.cli = resolve(next())
    else if (argument === '--yes') args.yes = true
    else if (argument === '--reinstall') args.reinstall = true
    else throw new Error(`unknown argument ${argument}`)
  }
  if (args.dogfoodRoot === undefined) throw new Error('--dogfood-root is required')
  if (args.reinstall && args.cli === undefined) throw new Error('--reinstall requires --cli (the official CLI to install with)')
  return args
}

export async function runRepair(args) {
  const layout = controlRootLayout(args.dogfoodRoot)
  const result = { confirmed: args.yes === true, actions: [] }
  const ledgerRecords = await readLedger(layout.ledgerPath)
  const chain = verifyLedgerChain(ledgerRecords)
  if (!chain.ok) {
    throw new Error(`promotion ledger chain does not verify — this is evidence tampering, not a crash window; refuse to repair: ${chain.failures.join('; ')}`)
  }
  const ledgerGen = ledgerGenState(ledgerRecords).currentGen
  const pointer = await readLkgPointer(layout.lkgDir)
  const pointerGen = pointer?.currentGen
  const diverged = pointerGen !== ledgerGen
  const installed = pointer === undefined
    ? { checked: false, reason: 'no LKG pointer — nothing to reconcile against' }
    : await reconcileInstalledProfile({ layout, pointer, extract: extractTarball })
  result.divergences = {
    pointerGen: pointerGen ?? null,
    ledgerGen,
    pointerLedgerDiverged: diverged,
    installedProfile: installed,
  }

  if (diverged) {
    const targetGen = ledgerGen
    if (targetGen === null) {
      throw new Error('ledger tail asserts no generation while a pointer exists — refusing: this needs manual investigation, not pointer re-anchoring')
    }
    const targetRecord = await readJsonFile(join(genDir(layout.lkgDir, targetGen), 'lkg.json'))
    if (targetRecord === undefined) throw new Error(`ledger tail generation lkg/g${targetGen}/lkg.json is missing — refusing to re-anchor onto a nonexistent generation`)
    const targetTarball = join(genDir(layout.lkgDir, targetGen), 'dsh-agent-swarm.tgz')
    const digest = await sha256File(targetTarball).catch(() => undefined)
    if (digest === undefined || digest !== targetRecord.tarballSha256) {
      throw new Error(`ledger tail generation g${targetGen} tarball digest mismatch — evidence tampered, refusing`)
    }
    if (!args.yes) {
      result.actions.push({ action: 're-anchor-pointer', fromGen: pointerGen ?? null, toGen: targetGen, detail: 'dry run — pass --yes to re-anchor lkg/lkg.json onto the ledger tail generation and append a repair ledger record' })
    } else {
      await writeJsonFile(join(layout.lkgDir, 'lkg.json'), {
        schemaVersion: 1,
        currentGen: targetGen,
        prevGen: targetRecord.prevGen ?? null,
        currentTarballSha256: digest,
        updatedAt: new Date().toISOString(),
      })
      const record = await appendLedgerRecord(layout.ledgerPath, {
        action: 'repair',
        actor: 'repair.mjs',
        candidateId: null,
        gitCommit: null,
        gitTree: null,
        tarballSha256: digest,
        tarballBytes: targetRecord.tarballBytes ?? null,
        fromGen: pointerGen ?? null,
        toGen: targetGen,
        record: { reason: 'pointer/ledger generational divergence repair (issue #122 F3): re-anchored the pointer onto the hash-chained ledger tail after an explicit confirmation', repairedFromPointer: pointer ?? null, currentGenAfter: targetGen },
        profileIdentity: { profileName: 'web', dshHome: layout.controlHome },
        verdictRef: null,
      })
      result.actions.push({ action: 're-anchor-pointer', fromGen: pointerGen ?? null, toGen: targetGen, ledgerSeq: record.seq })
    }
  }

  const installedMismatch = installed.checked === true && installed.matches === false
  if (installedMismatch) {
    if (!args.reinstall) {
      result.actions.push({ action: 'reinstall-stable-profile', detail: `installed Profile bytes do not match lkg/g${pointer.currentGen} (${installed.reason ?? 'content digest mismatch'}) — pass --reinstall (with --cli) to re-install the pointer generation's frozen tarball` })
    } else if (!args.yes) {
      result.actions.push({ action: 'reinstall-stable-profile', detail: 'dry run — pass --yes together with --reinstall to re-install the pointer generation\'s tarball' })
    } else {
      const tarball = join(genDir(layout.lkgDir, pointer.currentGen), 'dsh-agent-swarm.tgz')
      const reinstallResult = await installIntoStableProfile({ cli: args.cli, layout, tarballPath: tarball })
      if (!reinstallResult.ok) throw new Error(`stable Profile reinstall failed at ${reinstallResult.step} — manual recovery required`)
      result.actions.push({ action: 'reinstall-stable-profile', gen: pointer.currentGen, outcome: 'ok' })
    }
  }

  const reAnchored = diverged && args.yes && result.actions.some(action => action.action === 're-anchor-pointer' && action.detail === undefined)
  const reinstalled = installedMismatch && args.reinstall && args.yes && result.actions.some(action => action.action === 'reinstall-stable-profile' && action.detail === undefined)
  const unfixed = (diverged && !reAnchored) || (installedMismatch && !reinstalled)
  result.ok = !unfixed
  console.log(JSON.stringify(result, null, 2))
  return result
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/promotion/repair.mjs')) {
  try {
    const result = await runRepair(parseArgs(process.argv.slice(2)))
    if (result.ok !== true) process.exitCode = 1
  } catch (error) {
    console.error(`repair failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
