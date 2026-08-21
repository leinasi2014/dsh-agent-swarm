// M3-3 promoter status (issue #102, design §3.1): print the LKG pointer, the
// promotion-ledger tail, the chain-integrity verdict over both, the
// four-domain health of one dogfood control root, the INSTALLED-BYTES
// reconciliation against the pointer's generation tarball (issue #122, F3)
// and — when --repo names the anchor repository — the ledger chain-tail git
// anchor check (issue #122, F5). Read-only; exit 1 on any failed face.
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  controlRootLayout, readLedger, readLkgPointer, reconcileInstalledProfile,
  verifyLkgChain, verifyLedgerAnchors,
} from './lib.mjs'
import { extractTarball } from './runner.mjs'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`missing value for ${argument}`)
      return argv[index]
    }
    if (argument === '--dogfood-root') args.dogfoodRoot = resolve(next())
    else if (argument === '--repo') args.repo = resolve(next())
    else throw new Error(`unknown argument ${argument}`)
  }
  if (args.dogfoodRoot === undefined) throw new Error('--dogfood-root is required')
  return args
}

export async function runStatus(dogfoodRoot, options = {}) {
  const layout = controlRootLayout(dogfoodRoot)
  const ledgerRecords = await readLedger(layout.ledgerPath)
  const pointer = await readLkgPointer(layout.lkgDir)
  const chain = await verifyLkgChain(layout.lkgDir, ledgerRecords)
  const stableManifest = await readFile(join(layout.controlProfileDir, 'package.json'), 'utf8').then(text => JSON.parse(text), () => undefined)
  const status = {
    dogfoodRoot: layout.root,
    pointer,
    chainOk: chain.ok,
    chainFailures: chain.failures,
    ledgerRecords: ledgerRecords.length,
    ledgerTail: ledgerRecords.slice(-5).map(record => ({ seq: record.seq, action: record.action, fromGen: record.fromGen, toGen: record.toGen, candidateId: record.candidateId, reason: record.record?.reason ?? null, recordSha256: record.recordSha256.slice(0, 16) })),
    domains: {
      controlHomePresent: stableManifest !== undefined,
      stableProfileBundles: stableManifest?.dsh?.profile?.bundles ?? null,
      stableProfileHasCandidate: stableManifest?.dependencies?.['dsh-agent-swarm'] ?? null,
      candidates: [],
    },
  }
  if (pointer !== undefined && status.domains !== undefined) {
    status.currentGenRecord = { gen: pointer.currentGen, dir: join(layout.lkgDir, `g${pointer.currentGen}`), tarballSha256: pointer.currentTarballSha256 }
  }
  // F3 machine check: the stable Profile's installed bytes must match the
  // pointer's generation tarball — a promote that died between install and
  // establishGeneration (or any direct Profile tampering) shows up here. An
  // unchecked face (fresh root, no Profile) is reported, not failed.
  if (pointer !== undefined) {
    status.installedProfile = await reconcileInstalledProfile({ layout, pointer, extract: options.extract ?? extractTarball })
    if (status.installedProfile.checked === true && status.installedProfile.matches !== true) {
      const detail = status.installedProfile.reason
        ?? `installed digest ${String(status.installedProfile.installedContentSha256).slice(0, 16)}… vs tarball digest ${String(status.installedProfile.expectedContentSha256).slice(0, 16)}…`
      status.chainFailures = [...status.chainFailures, `installed Profile bytes do not match lkg/g${pointer.currentGen} (${detail}) — half-applied or tampered stable Profile (F3 reconciliation)`]
    }
  }
  // F5: the latest promotion's chain tail must be anchored in git (when the
  // anchor repository is named). A mismatch means the ledger was recomputed
  // after anchoring; a missing tag after the anchor era began means an
  // unanchored promotion.
  status.anchors = options.repo !== undefined
    ? await verifyLedgerAnchors({ repo: options.repo, records: ledgerRecords })
    : { checked: false, reason: '--repo not provided — ledger chain-tail git anchors not verified' }
  const anchorBroken = status.anchors.checked === true && status.anchors.ok !== true
  if (anchorBroken) {
    status.chainFailures = [...(status.chainFailures ?? []), ...status.anchors.failures.map(failure => `anchor: ${failure}`)]
  }
  status.ok = chain.ok && (status.installedProfile?.checked !== true || status.installedProfile.matches === true) && !anchorBroken
  console.log(JSON.stringify(status, null, 2))
  if (!status.ok) process.exitCode = 1
  return status
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/promotion/status.mjs')) {
  try {
    const args = parseArgs(process.argv.slice(2))
    await runStatus(args.dogfoodRoot, { repo: args.repo })
  } catch (error) {
    console.error(`status failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
