// M3-3 acceptance lane (issue #102, design §2.3): run the controlled
// acceptance of one frozen candidate in a THROWAWAY drill domain — never the
// stable control home, never ~/.dsh (red line 14).
//
// A0 freeze discipline → A1 source-level floor verify in an isolated
// verification root (a fresh detached worktree of the frozen commit) →
// A2 artifact-level digest + packed-entry + artifact-gate checks in the SAME
// verification root → A3 assembly in the drill home (+ the fail-closed
// negative probe) → A4 boot/load → A5 RPC health loop over the official
// apiproxy (no model turn: ADR-0008's acceptance face receives only the
// candidate artifact and dedicated temporary state, never credentials) →
// A6 reload/recovery/teardown subset → A7 verdict.
//
// The verdict is PURE EVIDENCE: it carries no promotion verb (verifyVerdict
// refuses one) — promotion is the external promoter's exclusive action.
// Any failed gate settles the whole run as `rejected` (ledger record +
// preserved evidence) and leaves the stable plane untouched by construction.
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  acceptanceIsolation, appendLedgerRecord, controlRootLayout, readJsonFile,
  rpcCall, sha256File, verifyArtifactAgainstManifest, verifyVerdict, writeJsonFile,
} from './lib.mjs'
import { bootPlane, run, stopPlane, waitPortFree, withDetachedWorktree } from './runner.mjs'
import { FLOOR_LANES, FULL_LANES } from './freeze.mjs'

function parseArgs(argv) {
  const args = { lanes: 'full', port: 47930, profile: 'web' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`missing value for ${argument}`)
      return argv[index]
    }
    if (argument === '--dogfood-root') args.dogfoodRoot = resolve(next())
    else if (argument === '--repo') args.repo = resolve(next())
    else if (argument === '--candidate') args.candidate = next()
    else if (argument === '--cli') args.cli = resolve(next())
    else if (argument === '--lanes') args.lanes = next()
    else if (argument === '--port') args.port = Number(next())
    else throw new Error(`unknown argument ${argument}`)
  }
  for (const required of ['dogfoodRoot', 'repo', 'candidate', 'cli']) {
    if (args[required] === undefined) throw new Error(`--${required.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required`)
  }
  if (!['full', 'floor'].includes(args.lanes)) throw new Error(`--lanes must be full or floor, got ${args.lanes}`)
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) throw new Error('--port must be a valid TCP port')
  return args
}

function forwardSlashes(path) {
  return path.replaceAll('\\', '/')
}

export async function runAcceptance(input) {
  // Programmatic callers (drill.mjs) may omit CLI-parse defaults; normalize.
  const args = { lanes: 'full', port: 47930, profile: 'web', ...input }
  const layout = controlRootLayout(args.dogfoodRoot)
  const candidateDir = join(layout.candidatesDir, args.candidate)
  const manifest = await readJsonFile(join(candidateDir, 'manifest.json'))
  if (manifest === undefined) throw new Error(`candidate manifest missing: ${candidateDir}/manifest.json`)
  const tarballPath = join(candidateDir, 'dsh-agent-swarm.tgz')
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const drillSlug = `${stamp}-accept-${args.candidate}`
  const drillDir = join(layout.drillsDir, drillSlug)
  const gates = []
  const gate = (name, status, detail, evidencePath) => gates.push({ gate: name, status, detail, ...(evidencePath !== undefined ? { evidencePath, evidenceSha256: 'pending' } : {}) })
  const failed = () => gates.some(entry => entry.status === 'fail')
  let isolation
  try {
    // ── A0: freeze discipline ─────────────────────────────────────────────
    const artifact = await verifyArtifactAgainstManifest(manifest, tarballPath)
    isolation = acceptanceIsolation(drillDir, layout)
    if (!isolation.ok) throw new Error(`drill isolation violated: ${isolation.violations.join('; ')}`)
    if (await stat(drillDir).then(() => true, () => false)) {
      throw new Error(`drill domain already exists (acceptance requires a fresh domain per run): ${drillDir}`)
    }
    for (const dir of Object.values(isolation.domains)) await mkdir(dir, { recursive: true })
    await writeJsonFile(join(isolation.domains.evidence, 'a0-freeze-discipline.json'), { artifact, isolation: { ok: isolation.ok, domains: isolation.domains }, manifest })
    gate('a0-freeze-discipline', artifact.ok && isolation.ok ? 'pass' : 'fail', artifact.ok ? 'manifest + digest + fresh drill domain verified' : `artifact verification failed: ${artifact.failures.join('; ')}`, 'a0-freeze-discipline.json')

    // ── A1 + A2: isolated verification root (source floor + artifact gates) ──
    const lanes = args.lanes === 'full' ? FULL_LANES : FLOOR_LANES
    const laneResults = []
    let artifactCheck = { exitCode: null, note: 'not reached' }
    let packedEntries = []
    const listing = await run('tar', ['--force-local', '-tzf', tarballPath.replaceAll('\\', '/')])
    if (listing.code === 0) packedEntries = listing.stdout.split('\n').filter(Boolean)
    const entryOk = packedEntries.some(entry => entry.endsWith('package/lib/index.mjs')) && packedEntries.some(entry => entry.endsWith('package/cordis.patch.yml'))
    await withDetachedWorktree(args.repo, manifest.gitCommit, async verifyRoot => {
      // Issue #122 F1: the verification root is the CANDIDATE's tree — its
      // dependency lifecycle scripts must not execute with PM authority. This
      // source-root hardening is distinct from Profile tarball installation,
      // which runs the published package's normal lifecycle scripts below.
      const install = await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: verifyRoot })
      await writeFile(join(isolation.domains.evidence, 'a1-install.log'), install.stdout + install.stderr, 'utf8')
      if (install.code !== 0) {
        laneResults.push({ lane: 'install', exitCode: install.code, durationMs: install.durationMs })
        return
      }
      for (const lane of lanes) {
        // One evidenced retry per lane: the composition suites carry a known
        // intermittent `.dsh-mkdir-*` ENOENT race (observed in two different
        // suites under load, both green on re-run) — a deterministic failure
        // (the P4a injected defect) stays red through the retry, a flake
        // recovers, and BOTH attempts land in the evidence log.
        let result = await run('pnpm', [lane], { cwd: verifyRoot })
        let attempts = 1
        if (result.code !== 0) {
          const retry = await run('pnpm', [lane], { cwd: verifyRoot })
          attempts = 2
          await writeFile(join(isolation.domains.evidence, `a1-lane-${lane.replace(/:/g, '_')}.retry.log`), retry.stdout + retry.stderr, 'utf8')
          result = retry
        }
        await writeFile(join(isolation.domains.evidence, `a1-lane-${lane.replace(/:/g, '_')}.log`), result.stdout + result.stderr, 'utf8')
        laneResults.push({ lane, exitCode: result.code, durationMs: result.durationMs, attempts })
        if (result.code !== 0) break
      }
      // The artifact gate needs lib/ — build it when the lane loop broke
      // before the build lane (or on retry paths); idempotent otherwise.
      const build = await run('pnpm', ['build'], { cwd: verifyRoot })
      if (build.code !== 0) {
        await writeFile(join(isolation.domains.evidence, 'a2-build.log'), build.stdout + build.stderr, 'utf8')
        artifactCheck = { exitCode: build.code, note: 'pnpm build failed in the verification root' }
      } else {
        artifactCheck = await run(process.execPath, ['scripts/verify-package-artifact.mjs'], { cwd: verifyRoot })
      }
    }, 'agent-swarm-accept-verify')
    const a1Ok = laneResults.length === lanes.length && laneResults.every(result => result.exitCode === 0)
    await writeJsonFile(join(isolation.domains.evidence, 'a1-lanes.json'), { lanes, verificationRootCommit: manifest.gitCommit, laneResults })
    gate('a1-source-floor', a1Ok ? 'pass' : 'fail', a1Ok ? `all ${lanes.length} lanes green (${lanes.join(', ')})` : `failed lanes: ${laneResults.filter(result => result.exitCode !== 0).map(result => `${result.lane}(${result.exitCode})`).join(', ')}`, 'a1-lanes.json')
    const tarballDigest = await sha256File(tarballPath)
    const a2Ok = tarballDigest === manifest.tarballSha256 && entryOk && artifactCheck.code === 0
    await writeJsonFile(join(isolation.domains.evidence, 'a2-artifact-integrity.json'), { tarballDigest, digestMatchesManifest: tarballDigest === manifest.tarballSha256, packedEntryCheck: entryOk, packedEntries, verifyPackageArtifact: { exitCode: artifactCheck.code, stdout: artifactCheck.stdout, stderr: artifactCheck.stderr } })
    gate('a2-artifact-integrity', a2Ok ? 'pass' : 'fail', `digest=${tarballDigest === manifest.tarballSha256} entries=${entryOk} artifactGate=${artifactCheck.code}`, 'a2-artifact-integrity.json')

    // ── A3: assembly in the drill home + fail-closed negative probe ──────
    const drillHome = isolation.domains.home
    const env = { DSH_HOME: drillHome }
    const version = await run(process.execPath, [args.cli, '--version'], { env })
    const pluginAdd = await run(process.execPath, [args.cli, 'plugin', '--profile', args.profile, 'add', '-w', tarballPath], { env, timeoutMs: 10 * 60_000 })
    await writeFile(join(drillHome, 'profiles', args.profile, 'cordis.patch.yml'), [
      `# M3-3 acceptance-domain storage isolation (issue #102): the web template's`,
      `# storage rows are re-rooted into THIS drill domain's dedicated roots — the`,
      `# stable control roots and ~/.dsh are never touched (red line 14).`,
      `- id: storage-json`,
      `  config:`,
      `    root: '${forwardSlashes(isolation.domains.storageRoot)}'`,
      `- id: session-persistence-jsonl`,
      `  config:`,
      `    root: '${forwardSlashes(isolation.domains.sessionsRoot)}'`,
      ``,
    ].join('\n'), 'utf8')
    const dump = await run(process.execPath, [args.cli, '--profile', args.profile, '--dump-config'], { env })
    const dumpOk = dump.code === 0 && dump.stdout.includes('dsh-agent-swarm') && dump.stdout.includes(forwardSlashes(isolation.domains.storageRoot)) && dump.stdout.includes(forwardSlashes(isolation.domains.sessionsRoot))
    const failClosedProfile = 'm3c-failclosed'
    await run(process.execPath, [args.cli, 'plugin', '--profile', failClosedProfile, 'add', '-w', tarballPath], { env, timeoutMs: 10 * 60_000 })
    await writeFile(join(drillHome, 'profiles', failClosedProfile, 'cordis.patch.yml'), [
      `# M3-3 fail-closed negative probe (M1D-1 §4 form): storage stack WITHOUT`,
      `# storage-domain — the plugin must stay pending and the boot must exit 1.`,
      `- insert:`,
      `    - id: storage`,
      `      name: '@deepseek-ai/dsh-storage'`,
      `    - id: storage-json`,
      `      name: '@deepseek-ai/dsh-storage-json'`,
      `      config:`,
      `        root: '${forwardSlashes(isolation.domains.storageRoot)}'`,
      ``,
    ].join('\n'), 'utf8')
    const failClosed = await run(process.execPath, [args.cli, '--profile', failClosedProfile], { env, timeoutMs: 120_000 })
    const failClosedOk = failClosed.code !== 0 && (failClosed.stdout + failClosed.stderr).includes('dsh-agent-swarm: pending')
    await writeFile(join(isolation.domains.evidence, 'a3-plugin-add.log'), pluginAdd.stdout + pluginAdd.stderr, 'utf8')
    await writeFile(join(isolation.domains.evidence, 'a3-dump-config.txt'), dump.stdout, 'utf8')
    await writeJsonFile(join(isolation.domains.evidence, 'a3-assembly-fail-closed.json'), { cliVersion: version.stdout.trim(), pluginAddExit: pluginAdd.code, dumpConfigExit: dump.code, dumpOk, failClosedExit: failClosed.code, failClosedOk, failClosedOutput: (failClosed.stdout + failClosed.stderr).slice(0, 4_000) })
    gate('a3-assembly-fail-closed', version.code === 0 && pluginAdd.code === 0 && dumpOk && failClosedOk ? 'pass' : 'fail', `version=${version.code} add=${pluginAdd.code} dump=${dump.code}/${dumpOk} failClosed=${failClosed.code}/${failClosedOk}`, 'a3-assembly-fail-closed.json')

    // ── A4: boot + load (survival proves every entry ACTIVE) ─────────────
    const boot = await bootPlane({ cli: args.cli, home: drillHome, profile: args.profile, port: args.port })
    const describe = boot.ready ? await rpcCall(args.port, 'host.describe', {}) : { ok: false }
    // host.describe's `home` is the host account home by contract, NOT
    // DSH_HOME; the acceptance-identity evidence is the dump-config assembly
    // (storage roots inside THIS drill domain) plus the in-domain storage-root
    // materialization in A5. The identity fields are recorded either way.
    const a4 = { ready: boot.ready, bootMs: boot.bootMs, describe: describe.body, dshHome: drillHome, stdoutExcerpt: boot.stdout().slice(0, 2_000), stderrExcerpt: boot.stderr().slice(0, 2_000) }
    await writeJsonFile(join(isolation.domains.evidence, 'a4-boot-load.json'), a4)
    gate('a4-boot-load', boot.ready && describe.ok ? 'pass' : 'fail', boot.ready ? `plane healthy on port ${args.port} with DSH_HOME=${drillHome} (assembly identity proven by the dump-config rows in a3)` : `plane did not become healthy in the bound; stderr: ${a4.stderrExcerpt.slice(0, 400)}`, 'a4-boot-load.json')
    await stopPlane(boot)

    // ── A5: RPC health loop (fresh boot; no model turn — no credentials in the acceptance face) ──
    const boot2 = await bootPlane({ cli: args.cli, home: drillHome, profile: args.profile, port: args.port })
    const created = boot2.ready ? await rpcCall(args.port, 'session.create', {}) : { ok: false }
    const sessionId = created.body?.result?.value?.sessionId
    const history = sessionId !== undefined ? await rpcCall(args.port, 'session.history', { sessionId }) : { ok: false }
    await stopPlane(boot2)
    const storageRootPresent = await stat(isolation.domains.storageRoot).then(() => true, () => false)
    const storageUnitOpened = await stat(join(isolation.domains.storageRoot, 'agent_swarm.json')).then(() => true, () => false)
    await writeJsonFile(join(isolation.domains.evidence, 'a5-rpc-health.json'), { sessionCreate: created, sessionHistory: { ok: history.ok, httpStatus: history.httpStatus }, storageRootPresent, storageUnitOpened, note: 'no model prompt: ADR-0008 security boundary — the acceptance Profile receives only the candidate artifact and dedicated temporary state, never credentials' })
    gate('a5-rpc-health', created.ok && history.ok && storageRootPresent ? 'pass' : 'fail', `session.create=${created.ok} session.history=${history.ok} storageRootOpenedInDomain=${storageRootPresent} storageUnitFile=${storageUnitOpened}`, 'a5-rpc-health.json')

    // ── A6: reload/recovery subset + bounded teardown ─────────────────────
    const boot3 = await bootPlane({ cli: args.cli, home: drillHome, profile: args.profile, port: args.port })
    const describe3 = boot3.ready ? await rpcCall(args.port, 'host.describe', {}) : { ok: false }
    const stopResult = await stopPlane(boot3)
    const free = await waitPortFree(args.port, 15_000, '127.0.0.1', { reclaim: true })
    await writeJsonFile(join(isolation.domains.evidence, 'a6-reload-recovery-teardown.json'), { reloadBootReady: boot3.ready, reloadDescribeOk: describe3.ok, teardown: stopResult, portFreeAfterTeardown: free })
    gate('a6-reload-recovery-teardown', boot3.ready && describe3.ok && stopResult.exited && free ? 'pass' : 'fail', `reloadBoot=${boot3.ready} teardownExited=${stopResult.exited} portFree=${free}`, 'a6-reload-recovery-teardown.json')
  } catch (error) {
    gate('acceptance-run', 'fail', error instanceof Error ? error.message : String(error))
  }

  // ── A7: verdict (pure evidence — no promotion verb) ──────────────────────
  const overall = failed() ? 'fail' : 'pass'
  for (const entry of gates) {
    if (entry.evidencePath !== undefined && isolation !== undefined) {
      entry.evidenceSha256 = await sha256File(join(isolation.domains.evidence, entry.evidencePath)).catch(() => 'missing')
    }
  }
  const verdict = {
    schemaVersion: 1,
    candidateId: args.candidate,
    tarballSha256: manifest.tarballSha256,
    overall,
    gates,
    run: { drillDir, lanes: args.lanes, laneList: args.lanes === 'full' ? FULL_LANES : FLOOR_LANES, cli: args.cli, port: args.port, profile: args.profile, finishedAt: new Date().toISOString() },
  }
  let verdictDigest = 'missing'
  if (isolation !== undefined) {
    await writeJsonFile(join(isolation.domains.evidence, 'acceptance-verdict.json'), verdict)
    await copyFile(join(isolation.domains.evidence, 'acceptance-verdict.json'), join(candidateDir, 'acceptance-verdict.json')).catch(() => {})
    verdictDigest = await sha256File(join(candidateDir, 'acceptance-verdict.json')).catch(() => 'missing')
  }
  const selfCheck = await verifyVerdict(verdict, manifest, isolation?.domains.evidence)
  await appendLedgerRecord(layout.ledgerPath, {
    action: overall === 'pass' ? 'accepted' : 'reject',
    actor: 'accept-check.mjs',
    candidateId: args.candidate,
    gitCommit: manifest.gitCommit,
    gitTree: manifest.gitTree,
    tarballSha256: manifest.tarballSha256,
    tarballBytes: manifest.tarballBytes,
    fromGen: null,
    toGen: null,
    record: { reason: overall === 'pass' ? 'acceptance verdict pass (evidence record; promotion is the external promoter action)' : 'acceptance verdict fail — candidate rejected, evidence preserved', failedGates: gates.filter(entry => entry.status === 'fail').map(entry => entry.gate), drillDir },
    profileIdentity: null,
    verdictRef: { candidateId: args.candidate, sha256: verdictDigest },
  })
  console.log(JSON.stringify({ acceptance: overall, candidateId: args.candidate, drillDir, gates: gates.map(entry => ({ gate: entry.gate, status: entry.status })), verdictDigest, verdictSelfCheck: selfCheck }, null, 2))
  if (overall !== 'pass') process.exitCode = 1
  return { verdict, drillDir, isolation, verdictDigest }
}

// CLI entry: export the drill's disposable halves (home/workspace) on BOTH
// outcomes — the evidence stays under drills/<slug>/evidence and the verdict
// under candidates/<id>/ (the design's P7 discipline).
if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/promotion/accept-check.mjs')) {
  const args = parseArgs(process.argv.slice(2))
  const result = await runAcceptance(args)
  if (result.isolation !== undefined) {
    for (const dir of ['home', 'workspace']) {
      await rm(result.isolation.domains[dir], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
    }
  }
}
