// M3-3 promoter status (issue #102, design §3.1): print the LKG pointer, the
// promotion-ledger tail, the chain-integrity verdict over both, and the
// four-domain health of one dogfood control root. Read-only.
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  controlRootLayout, readLedger, readLkgPointer, verifyLkgChain,
} from './lib.mjs'

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
    else throw new Error(`unknown argument ${argument}`)
  }
  if (args.dogfoodRoot === undefined) throw new Error('--dogfood-root is required')
  return args
}

export async function runStatus(dogfoodRoot) {
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
  console.log(JSON.stringify(status, null, 2))
  if (!chain.ok) process.exitCode = 1
  return status
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/promotion/status.mjs')) {
  try {
    await runStatus(parseArgs(process.argv.slice(2)).dogfoodRoot)
  } catch (error) {
    console.error(`status failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
