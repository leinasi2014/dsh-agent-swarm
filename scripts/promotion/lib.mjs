// M3-3 external promoter contract core (issue #102, ADR-0008 D2).
//
// This module is the SINGLE contract implementation shared by the promotion
// lane CLIs (freeze/accept-check/promote/rollback/status/drill) and by the
// vitest contract suite in tests/promotion-contract.spec.ts. It lives in
// scripts/ — verification tooling, deliberately NOT shipped in the plugin
// tarball: ADR-0008's promotion rule requires a controller "not loaded from
// the candidate artifact", so the promotion state machine must never become
// plugin source.
//
// Four-domain topology (docs/13-self-hosting-dogfood.md):
// <dogfood-root>/{control,lkg,candidates,drills} plus ledger/. The
// running stable Profile under control/home, per-generation immutable
// snapshots under lkg/g<N>/ (tarball + record) with a numeric pointer at
// lkg/lkg.json (never a symlink), frozen candidate staging under
// candidates/<id>/, and throwaway acceptance domains under drills/<slug>/.
// Nothing here ever touches ~/.dsh: every path derives from the dogfood root.
import { createHash } from 'node:crypto'
import { access, appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Ledger action vocabulary (the candidate lifecycle's external transitions). */
export const LEDGER_ACTIONS = ['gen-established', 'accepted', 'promote', 'rollback', 'reject', 'repair']

/** Canonical four-domain layout of one dogfood control root. */
export function controlRootLayout(root) {
  const base = resolve(root)
  return {
    root: base,
    controlHome: join(base, 'control', 'home'),
    controlStorage: join(base, 'control', 'storage-root'),
    controlSessions: join(base, 'control', 'sessions-root'),
    controlProfileDir: join(base, 'control', 'home', 'profiles', 'web'),
    lkgDir: join(base, 'lkg'),
    lkgPointerPath: join(base, 'lkg', 'lkg.json'),
    candidatesDir: join(base, 'candidates'),
    drillsDir: join(base, 'drills'),
    ledgerPath: join(base, 'ledger', 'promotion-ledger.jsonl'),
  }
}

/** Directory for one LKG generation's immutable snapshot. */
export function genDir(lkgDir, gen) {
  return join(lkgDir, `g${gen}`)
}

/**
 * Deterministic JSON encoding for hashing (key-sorted, no ambient spacing).
 * Undefined handling matches JSON.stringify exactly — properties with the
 * value undefined are DROPPED (array slots become null) — so a record's
 * stored line and its recomputed hash agree even when a caller passed an
 * undefined field (a live drill run broke its ledger chain on exactly that).
 */
export function stableStringify(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item) ?? 'null').join(',')}]`
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/** SHA-256 hex digest of a string or buffer. */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/** SHA-256 hex digest of one file's bytes. */
export async function sha256File(path) {
  return sha256Hex(await readFile(path))
}

/** Parse a JSON file; returns undefined when absent, throws on corrupt content. */
export async function readJsonFile(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text)
}

/** Write JSON with a trailing newline through a same-directory rename. */
export async function writeJsonFile(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const temporary = join(dirname(path), `.${Math.random().toString(36).slice(2)}.tmp`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, path)
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Whether `child` lies inside `parent` (equal paths count as inside). */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`) && !isAbsoluteLike(rel))
}
function isAbsoluteLike(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

/** Verify a tarball on disk against its frozen manifest identity fields. */
export async function verifyArtifactAgainstManifest(manifest, tarballPath) {
  const failures = []
  if (manifest?.schemaVersion !== 1) failures.push('manifest.schemaVersion must be 1')
  if (typeof manifest?.candidateId !== 'string' || manifest.candidateId === '') failures.push('manifest.candidateId missing')
  if (typeof manifest?.gitCommit !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.gitCommit)) failures.push('manifest.gitCommit must be a full sha')
  if (typeof manifest?.tarballSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.tarballSha256)) failures.push('manifest.tarballSha256 missing/invalid')
  if (failures.length > 0) return { ok: false, failures }
  const info = await stat(tarballPath).catch(() => undefined)
  if (info === undefined) return { ok: false, failures: [`tarball missing: ${tarballPath}`] }
  const digest = await sha256File(tarballPath)
  if (digest !== manifest.tarballSha256) failures.push(`tarball digest mismatch: manifest ${manifest.tarballSha256}, actual ${digest}`)
  if (typeof manifest.tarballBytes === 'number' && manifest.tarballBytes !== info.size) {
    failures.push(`tarball size mismatch: manifest ${manifest.tarballBytes}, actual ${info.size}`)
  }
  return { ok: failures.length === 0, failures }
}

// ── promotion ledger (append-only JSONL with a sha256 hash chain) ────────────

/** Compute the chained record hash: sha256(prevHash + '\n' + canonical record). */
export function ledgerRecordHash(previousHash, recordBody) {
  return sha256Hex(`${previousHash}\n${stableStringify(recordBody)}`)
}

/**
 * Append one promotion-ledger record. Sequencing, the previous-record hash
 * link and this record's hash are computed here — callers pass only the
 * business fields. Fails loud when the existing chain does not verify.
 */
export async function appendLedgerRecord(ledgerPath, body) {
  const records = await readLedger(ledgerPath)
  const chain = verifyLedgerChain(records)
  if (!chain.ok) {
    throw new Error(`promotion ledger chain broken before append: ${chain.failures.join('; ')}`)
  }
  const previous = records.at(-1)
  const recordBody = {
    ...body,
    seq: (previous?.seq ?? 0) + 1,
    time: new Date().toISOString(),
  }
  const record = {
    ...recordBody,
    prevRecordSha256: previous?.recordSha256 ?? 'GENESIS',
    recordSha256: ledgerRecordHash(previous?.recordSha256 ?? 'GENESIS', recordBody),
  }
  await mkdir(dirname(ledgerPath), { recursive: true })
  await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8')
  return record
}

/** Read the whole ledger; an absent file is an empty ledger. */
export async function readLedger(ledgerPath) {
  let text
  try {
    text = await readFile(ledgerPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

/** Verify the hash chain and monotone sequencing of ledger records. */
export function verifyLedgerChain(records) {
  const failures = []
  let previousHash = 'GENESIS'
  let previousSeq = 0
  let index = 0
  for (const record of records) {
    index += 1
    const { seq, time, recordSha256, prevRecordSha256, ...body } = record
    if (typeof seq !== 'number' || seq !== previousSeq + 1) failures.push(`record ${index}: seq ${seq} does not follow ${previousSeq}`)
    if (prevRecordSha256 !== previousHash) failures.push(`record ${index}: prevRecordSha256 does not link the previous record`)
    if (typeof time !== 'string') failures.push(`record ${index}: time missing`)
    if (ledgerRecordHash(previousHash, { ...body, seq, time }) !== recordSha256) failures.push(`record ${index}: recordSha256 does not match its content (tampered or forged record)`)
    previousHash = recordSha256
    previousSeq = seq
  }
  return { ok: failures.length === 0, failures }
}

/**
 * The generation state the ledger's tail asserts: the last gen-affecting
 * action (`gen-established`/`promote` move toGen, `rollback` moves toGen of
 * its restated target). Cross-checked against lkg/lkg.json by fencing.
 */
export function ledgerGenState(records) {
  let currentGen = null
  let lastGenAction = null
  for (const record of records) {
    if (record.action === 'gen-established' || record.action === 'promote') {
      if (typeof record.toGen === 'number') { currentGen = record.toGen; lastGenAction = record.action }
    } else if (record.action === 'rollback') {
      if (typeof record.record?.currentGenAfter === 'number') { currentGen = record.record.currentGenAfter; lastGenAction = record.action }
      else if (typeof record.toGen === 'number') { currentGen = record.toGen; lastGenAction = record.action }
    }
  }
  return { currentGen, lastGenAction }
}

// ── LKG generation snapshots and the numeric pointer chain ───────────────────

/** Read lkg/lkg.json; undefined when no generation exists yet. */
export async function readLkgPointer(lkgDir) {
  return readJsonFile(join(lkgDir, 'lkg.json'))
}

/**
 * Verify the LKG chain end to end: the pointer names an existing generation
 * snapshot whose tarball digest matches, whose record agrees with the
 * pointer, whose prevGen links exist all the way down, and (when a ledger is
 * given) whose generation the ledger tail agrees with.
 */
export async function verifyLkgChain(lkgDir, ledgerRecords = []) {
  const failures = []
  const pointer = await readLkgPointer(lkgDir)
  if (pointer === undefined) return { ok: false, failures: ['lkg/lkg.json pointer missing'], pointer }
  if (pointer.schemaVersion !== 1) failures.push('lkg.json schemaVersion must be 1')
  if (typeof pointer.currentGen !== 'number' || !Number.isInteger(pointer.currentGen) || pointer.currentGen < 0) failures.push('lkg.json currentGen missing/invalid')
  if (failures.length > 0) return { ok: false, failures, pointer }
  let gen = pointer.currentGen
  const seen = new Set()
  while (gen !== null && gen !== undefined) {
    if (seen.has(gen)) { failures.push(`prev-chain cycle at g${gen}`); break }
    seen.add(gen)
    const dir = genDir(lkgDir, gen)
    const record = await readJsonFile(join(dir, 'lkg.json'))
    if (record === undefined) { failures.push(`lkg/g${gen}/lkg.json missing`); break }
    const tarball = join(dir, 'dsh-agent-swarm.tgz')
    if (!(await fileExists(tarball))) { failures.push(`lkg/g${gen}/dsh-agent-swarm.tgz missing`) }
    else {
      const digest = await sha256File(tarball)
      if (digest !== record.tarballSha256) failures.push(`lkg/g${gen} tarball digest does not match its record`)
      if (gen === pointer.currentGen && pointer.currentTarballSha256 !== digest) failures.push('lkg.json currentTarballSha256 does not match the current generation tarball')
    }
    if (record.gen !== gen) failures.push(`lkg/g${gen}/lkg.json records gen ${record.gen}`)
    if (gen === pointer.currentGen && record.gen !== pointer.currentGen) failures.push('pointer/gen record disagree on current generation')
    const prev = record.prevGen
    if (typeof prev === 'number' && prev >= gen) failures.push(`lkg/g${gen} prevGen ${prev} must be lower`)
    gen = typeof prev === 'number' ? prev : null
  }
  if (ledgerRecords.length > 0) {
    const chain = verifyLedgerChain(ledgerRecords)
    if (!chain.ok) failures.push(...chain.failures.map(failure => `ledger: ${failure}`))
    const ledgerState = ledgerGenState(ledgerRecords)
    if (ledgerState.currentGen !== pointer.currentGen) {
      failures.push(`generational fencing mismatch: lkg.json currentGen ${pointer.currentGen} but ledger tail asserts ${ledgerState.currentGen}`)
    }
  }
  return { ok: failures.length === 0, failures, pointer }
}

/**
 * Generational fencing for one external promotion-lane action (fail-loud,
 * never wait-and-retry): `establish` requires no existing generation;
 * `promote` requires the expected generation to still be current in BOTH the
 * pointer and the ledger tail (a concurrent writer moved either → refuse);
 * `rollback` requires a strictly lower, existing target generation.
 */
export function checkFencing(pointer, ledgerRecords, { action, expectGen, toGen }) {
  const ledgerState = ledgerGenState(ledgerRecords)
  if (pointer === undefined) {
    if (action === 'establish') return { ok: true, reason: 'no generation yet; establish g0' }
    return { ok: false, reason: 'lkg/lkg.json missing — establish g0 first (promote/rollback refused)' }
  }
  if (pointer.currentGen !== ledgerState.currentGen) {
    return { ok: false, reason: `pointer/ledger disagree (currentGen ${pointer.currentGen} vs ledger ${ledgerState.currentGen}) — a concurrent writer is mid-flight; refuse` }
  }
  if (action === 'establish') return { ok: false, reason: `generation ${pointer.currentGen} already established — use promote` }
  if (action === 'promote') {
    const expected = expectGen ?? pointer.currentGen
    if (expected !== pointer.currentGen) {
      return { ok: false, reason: `stale promotion: expected currentGen ${expected} but ${pointer.currentGen} is current (代际 fencing 拒绝)` }
    }
    return { ok: true, reason: `promote onto currentGen ${pointer.currentGen} → g${pointer.currentGen + 1}` }
  }
  if (action === 'rollback') {
    const target = toGen ?? pointer.prevGen
    if (typeof target !== 'number') return { ok: false, reason: 'no previous generation to roll back to' }
    if (target >= pointer.currentGen) return { ok: false, reason: `rollback target g${target} must be lower than current g${pointer.currentGen}` }
    return { ok: true, reason: `rollback g${pointer.currentGen} → g${target}` }
  }
  return { ok: false, reason: `unknown fencing action ${action}` }
}

/**
 * Establish one immutable generation snapshot: copy the frozen tarball into
 * lkg/g<N>/, write the generation record, update the numeric pointer, append
 * the ledger record. The fencing expectation is re-checked against a FRESH
 * pointer read immediately before the pointer write (single-writer PM
 * discipline plus an optimistic last-line check).
 */
export async function establishGeneration(lkgDir, ledgerPath, input) {
  const { action, gen, prevGen, tarballPath, candidateId, gitCommit, gitTree, tarballSha256, tarballBytes, verdictRef, reason, profileIdentity, expectPrevGen } = input
  if (action !== 'gen-established' && action !== 'promote' && action !== 'rollback') {
    throw new Error(`establishGeneration: unsupported action ${action}`)
  }
  const dir = genDir(lkgDir, gen)
  const tarball = join(dir, 'dsh-agent-swarm.tgz')
  await mkdir(dir, { recursive: true })
  await copyFile(tarballPath, tarball)
  const digest = await sha256File(tarball)
  if (digest !== tarballSha256) throw new Error(`copied tarball digest ${digest} does not match the expected ${tarballSha256}`)
  const ledgerBefore = await readLedger(ledgerPath)
  const record = {
    schemaVersion: 1,
    gen,
    prevGen: prevGen ?? null,
    candidateId,
    gitCommit,
    gitTree,
    tarballSha256: digest,
    tarballBytes,
    verdictRef: verdictRef ?? null,
    establishedAt: new Date().toISOString(),
    ledgerSeq: (ledgerBefore.at(-1)?.seq ?? 0) + 1,
  }
  await writeJsonFile(join(dir, 'lkg.json'), record)
  const freshPointer = await readLkgPointer(lkgDir)
  if (action === 'gen-established') {
    if (freshPointer !== undefined) throw new Error('fencing: a generation pointer already exists (establish refused)')
  } else if (action === 'promote') {
    if (freshPointer?.currentGen !== (expectPrevGen ?? gen - 1)) {
      throw new Error(`fencing: pointer moved mid-promotion (currentGen ${freshPointer?.currentGen}, expected ${expectPrevGen ?? gen - 1})`)
    }
  }
  const pointer = {
    schemaVersion: 1,
    currentGen: gen,
    prevGen: prevGen ?? null,
    currentTarballSha256: digest,
    updatedAt: new Date().toISOString(),
  }
  await writeJsonFile(join(lkgDir, 'lkg.json'), pointer)
  const ledgerRecord = await appendLedgerRecord(ledgerPath, {
    action,
    actor: input.actor ?? 'external-promoter',
    candidateId: candidateId ?? null,
    gitCommit: gitCommit ?? null,
    gitTree: gitTree ?? null,
    tarballSha256: digest,
    tarballBytes: tarballBytes ?? null,
    fromGen: prevGen ?? null,
    toGen: gen,
    record: { prevPointer: freshPointer ?? null, currentGenAfter: gen, ...(reason !== undefined ? { reason } : {}) },
    profileIdentity: profileIdentity ?? null,
    verdictRef: verdictRef ?? null,
  })
  return { gen, genRecord: record, pointer, ledgerRecord }
}

/**
 * Roll the pointer back to a prior generation WITHOUT rewriting history: the
 * target's own gen record and tarball stay untouched (immutable evidence),
 * only lkg/lkg.json moves and the ledger records the rollback.
 */
export async function rollPointerBack(lkgDir, ledgerPath, targetGen, details) {
  const targetRecord = await readJsonFile(join(genDir(lkgDir, targetGen), 'lkg.json'))
  if (targetRecord === undefined) throw new Error(`rollback target lkg/g${targetGen}/lkg.json missing`)
  const tarball = join(genDir(lkgDir, targetGen), 'dsh-agent-swarm.tgz')
  const digest = await sha256File(tarball)
  if (digest !== targetRecord.tarballSha256) throw new Error(`rollback target g${targetGen} tarball digest mismatch — evidence tampered`)
  const freshPointer = await readLkgPointer(lkgDir)
  if (targetGen >= (freshPointer?.currentGen ?? -1)) throw new Error(`rollback refused: target g${targetGen} not below current ${freshPointer?.currentGen}`)
  await writeJsonFile(join(lkgDir, 'lkg.json'), {
    schemaVersion: 1,
    currentGen: targetGen,
    prevGen: targetRecord.prevGen ?? null,
    currentTarballSha256: digest,
    updatedAt: new Date().toISOString(),
  })
  const ledgerRecord = await appendLedgerRecord(ledgerPath, {
    action: 'rollback',
    actor: details?.actor ?? 'external-promoter',
    candidateId: targetRecord.candidateId ?? null,
    gitCommit: targetRecord.gitCommit ?? null,
    gitTree: targetRecord.gitTree ?? null,
    tarballSha256: digest,
    tarballBytes: targetRecord.tarballBytes ?? null,
    fromGen: freshPointer.currentGen,
    toGen: targetGen,
    record: { currentGenAfter: targetGen, reason: details?.reason ?? 'manual rollback', ...(details?.context !== undefined ? { context: details.context } : {}) },
    profileIdentity: details?.profileIdentity ?? null,
    verdictRef: null,
  })
  return ledgerRecord
}

// ── acceptance verdict verification ──────────────────────────────────────────

/**
 * The acceptance-gate vocabulary (issue #122, F4). The eight gate names the
 * acceptance lane may emit: the seven evidence-carrying A0–A6 gates a PASSING
 * verdict must carry (name + `pass` status + evidence digest — three-fold
 * presence), plus `acceptance-run`, the catch-all failure gate that only ever
 * appears on a failed run (its presence in a verdict up for promotion is
 * itself a refusal). Any gate name outside this vocabulary is refused — a
 * forged verdict cannot shrink or rename the gate set (the P4b drill
 * injection's bare single-gate form is rejected by exactly this rule).
 */
export const REQUIRED_VERDICT_GATES = [
  'a0-freeze-discipline',
  'a1-source-floor',
  'a2-artifact-integrity',
  'a3-assembly-fail-closed',
  'a4-boot-load',
  'a5-rpc-health',
  'a6-reload-recovery-teardown',
]
const KNOWN_VERDICT_GATES = new Set([...REQUIRED_VERDICT_GATES, 'acceptance-run'])

/**
 * Verify an acceptance verdict against the frozen manifest (issue #122, F4 —
 * the promoter's check is now AT LEAST as strong as the contract suite's
 * self-check): the verdict must bind the exact candidate (id + tarball
 * digest), carry no promotion verb, present every required gate exactly once
 * with `pass` status AND a verified evidence digest (a bare verdict without
 * evidence is refused), and only name gates from the known vocabulary. Every
 * referenced evidence file must exist under `evidenceBaseDir` with its
 * recorded digest; `evidenceBaseDir` is mandatory — digest re-verification
 * may not be skipped.
 */
export async function verifyVerdict(verdict, manifest, evidenceBaseDir) {
  const failures = []
  if (verdict?.schemaVersion !== 1) failures.push('verdict.schemaVersion must be 1')
  if (verdict?.promotionVerb !== undefined) failures.push('verdict carries a promotion verb — acceptance evidence may not promote itself')
  if (verdict?.candidateId !== manifest?.candidateId) failures.push('verdict.candidateId does not match the manifest')
  if (verdict?.tarballSha256 !== manifest?.tarballSha256) failures.push('verdict.tarballSha256 does not match the manifest')
  if (verdict?.overall !== 'pass') failures.push(`verdict.overall is ${verdict?.overall}, not pass`)
  if (evidenceBaseDir === undefined) failures.push('evidenceBaseDir is required — gate evidence digests must be re-verified, never skipped (F4)')
  if (!Array.isArray(verdict?.gates)) {
    failures.push('verdict.gates missing/not an array')
    return { ok: false, failures }
  }
  if (verdict.gates.length === 0) failures.push('verdict.gates empty')
  const seen = new Map()
  for (const gate of verdict.gates) {
    if (typeof gate?.gate !== 'string' || gate.gate === '') {
      failures.push('verdict.gates carries an unnamed gate entry')
      continue
    }
    seen.set(gate.gate, (seen.get(gate.gate) ?? 0) + 1)
    if (!KNOWN_VERDICT_GATES.has(gate.gate)) {
      failures.push(`gate ${gate.gate}: unknown gate name (vocabulary: ${[...KNOWN_VERDICT_GATES].join(', ')})`)
    }
    if (gate.gate === 'acceptance-run') {
      failures.push('gate acceptance-run is present — it only ever appears on a failed acceptance run')
    }
    if (gate.status !== 'pass') failures.push(`gate ${gate.gate}: ${gate.status}${gate.detail ? ` (${gate.detail})` : ''}`)
    // F4 three-fold presence: gate name + pass status + evidence digest.
    if (typeof gate.evidencePath !== 'string' || gate.evidencePath === '') {
      failures.push(`gate ${gate.gate}: evidencePath missing — a bare verdict without per-gate evidence is refused (F4)`)
    }
    if (typeof gate.evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(gate.evidenceSha256)) {
      failures.push(`gate ${gate.gate}: evidenceSha256 missing/not a sha256 hex digest (F4)`)
    }
    if (evidenceBaseDir === undefined) continue
    if (typeof gate.evidencePath !== 'string' || gate.evidencePath === '') continue
    if (typeof gate.evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(gate.evidenceSha256)) continue
    const evidenceFile = resolve(evidenceBaseDir, gate.evidencePath)
    if (!isInside(evidenceBaseDir, evidenceFile)) { failures.push(`gate ${gate.gate}: evidence path escapes the evidence base`); continue }
    const actual = await sha256File(evidenceFile).catch(() => undefined)
    if (actual === undefined) failures.push(`gate ${gate.gate}: evidence file missing: ${gate.evidencePath}`)
    else if (actual !== gate.evidenceSha256) failures.push(`gate ${gate.gate}: evidence digest mismatch for ${gate.evidencePath}`)
  }
  for (const required of REQUIRED_VERDICT_GATES) {
    if (!seen.has(required)) failures.push(`required gate missing: ${required} (F4 enforces the full gate set)`)
  }
  for (const [name, count] of seen) {
    if (count > 1) failures.push(`gate ${name} appears ${count} times — exactly one entry per gate`)
  }
  return { ok: failures.length === 0, failures }
}

/**
 * The promoter-side acceptance cross-check (issue #122, F4): a verdict file
 * alone is not promotion input — it must be the SAME evidence the acceptance
 * lane recorded. This binds the verdict file digest to the ledger's `accepted`
 * record (`verdictRef.sha256`), binds that record's tarball digest to the
 * manifest, binds the verdict's `run.drillDir` to the record's `drillDir`, and
 * requires that drill directory to live inside the drills domain before its
 * evidence tree is used as `evidenceBaseDir` for full digest re-verification.
 * This closes the "silent promotion past acceptance" third form: a bare or
 * forged verdict pre-written into candidates/<id>/ cannot pass without a
 * matching, chain-protected accepted ledger record whose evidence re-digests.
 */
export async function crossCheckAcceptedVerdict({ verdict, manifest, verdictDigest, ledgerRecords, drillsDir }) {
  const failures = []
  const accepted = [...ledgerRecords].reverse().find(record => record.action === 'accepted' && record.candidateId === manifest.candidateId)
  if (accepted === undefined) {
    failures.push(`no 'accepted' ledger record for candidate ${manifest?.candidateId} — a candidate without recorded acceptance cannot promote (F4)`)
  } else {
    if (accepted.tarballSha256 !== manifest.tarballSha256) failures.push('accepted ledger record binds a different tarball digest than the manifest')
    if (accepted.verdictRef?.sha256 !== verdictDigest) {
      failures.push(`verdict file digest does not match the accepted ledger record's verdictRef (ledger ${accepted.verdictRef?.sha256 ?? 'absent'}, verdict file ${verdictDigest})`)
    }
  }
  const drillDir = accepted?.record?.drillDir
  if (typeof drillDir !== 'string' || drillDir === '') {
    failures.push('accepted ledger record carries no drillDir — evidence location is unknown')
  } else if (!isInside(drillsDir, drillDir)) {
    failures.push(`accepted record drillDir ${drillDir} is not inside the drills domain — refusing foreign evidence`)
  }
  if (verdict?.run?.drillDir !== drillDir) {
    failures.push(`verdict.run.drillDir (${String(verdict?.run?.drillDir)}) does not match the accepted ledger record's drillDir (${String(drillDir)})`)
  }
  if (typeof drillDir === 'string' && isInside(drillsDir, drillDir)) {
    const verdictCheck = await verifyVerdict(verdict, manifest, join(drillDir, 'evidence'))
    if (!verdictCheck.ok) failures.push(...verdictCheck.failures)
  }
  return { ok: failures.length === 0, failures, acceptedSeq: accepted?.seq ?? null, drillDir: drillDir ?? null }
}

// ── quiesce: the three pre-promotion stillness criteria (ADR-0008 decision 8) ─

/**
 * Parse the stable `agent_swarm` storage unit text and list every team whose
 * phase is not archived. Fail-safe faces (issue #122, F6): unparseable
 * content, an EMPTY file, or a parseable unit whose `tables.teams` key is
 * absent/pruned all count as ACTIVE — a corrupt or trimmed authority face
 * must block promotion, never wave it through. A unit the plugin actually
 * wrote always carries `tables.teams` (the storage schema materializes the
 * table even when empty); only an absent FILE (fresh root, the domain never
 * wrote state) reads as quiet.
 */
export function activeTeamsFromUnitText(text) {
  if (text === undefined || text === null) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return [{ teamId: '<unparseable-agent_swarm-unit>', phase: 'unknown' }]
  }
  const teams = parsed?.tables?.teams
  if (teams === undefined || teams === null) return [{ teamId: '<missing-teams-table>', phase: 'unknown' }]
  if (typeof teams !== 'object') return [{ teamId: '<malformed-teams-table>', phase: 'unknown' }]
  return Object.entries(teams)
    .filter(([, team]) => team?.phase !== 'archived')
    .map(([teamId, team]) => ({ teamId, phase: typeof team?.phase === 'string' ? team.phase : 'unknown' }))
}

/** Snapshot the mtime+size fingerprint of every file under a sessions root. */
export async function sessionsFingerprint(sessionsRoot) {
  const entries = new Map()
  const walk = async dir => {
    let names
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name.name)
      if (name.isDirectory()) await walk(path)
      else if (name.isFile()) {
        const info = await stat(path).catch(() => undefined)
        if (info !== undefined) entries.set(path, `${info.mtimeMs}:${info.size}`)
      }
    }
  }
  await walk(sessionsRoot)
  return entries
}

/**
 * Evaluate all three quiesce criteria. `deps` is injectable for the contract
 * suite: `readFile`, `listNodeProcesses` (returns [{pid, commandLine}]),
 * `delay`, `now`. Criterion 1: no active (non-archived) team in the stable
 * authority face. Criterion 2: sessions fingerprint stable across a full
 * window (double-poll). Criterion 3: no live node process whose command line
 * references the control home (a booted stable plane).
 */
export async function evaluateQuiesce(control, deps = {}) {
  const readFileImpl = deps.readFile ?? readFile
  const listNodeProcesses = deps.listNodeProcesses ?? (async () => [])
  const delay = deps.delay ?? (async ms => { await new Promise(resolve => setTimeout(resolve, ms)) })
  const windowMs = deps.windowMs ?? 120_000
  const storagePath = join(control.storageRoot, 'agent_swarm.json')
  let unitText
  try {
    unitText = await readFileImpl(storagePath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const activeTeams = activeTeamsFromUnitText(unitText)
  const before = await sessionsFingerprint(control.sessionsRoot)
  if (windowMs > 0) await delay(windowMs)
  const after = await sessionsFingerprint(control.sessionsRoot)
  const sessionChanges = [...after.entries()].filter(([path, fingerprint]) => before.get(path) !== fingerprint)
    .map(([path]) => path)
  const appeared = [...before.keys()].filter(path => !after.has(path))
  const processes = await listNodeProcesses()
  const marker = control.home.replaceAll('\\', '/').toLowerCase()
  const liveStable = processes.filter(process => typeof process.commandLine === 'string'
    && process.commandLine.replaceAll('\\', '/').toLowerCase().includes(marker))
  const criteria = [
    {
      criterion: 'no-active-team',
      pass: activeTeams.length === 0,
      detail: activeTeams.length === 0 ? `authority face ${storagePath} quiet` : `active teams: ${activeTeams.map(team => `${team.teamId}(${team.phase})`).join(', ')}`,
    },
    {
      criterion: 'no-live-session-traffic',
      pass: sessionChanges.length === 0 && appeared.length === 0,
      detail: sessionChanges.length === 0 && appeared.length === 0
        ? `sessions root ${control.sessionsRoot} static across ${windowMs}ms`
        : `sessions traffic within the window: ${[...sessionChanges, ...appeared.map(path => `${path} (removed)`)].join(', ')}`,
    },
    {
      criterion: 'no-stable-process',
      pass: liveStable.length === 0,
      detail: liveStable.length === 0 ? 'no live process references the control home' : `live stable processes: ${liveStable.map(process => `pid ${process.pid}`).join(', ')}`,
    },
  ]
  return { quiet: criteria.every(criterion => criterion.pass), criteria }
}

// ── RPC health probe over the official apiproxy fetch carrier ────────────────

/**
 * One bounded unary RPC against the booted plane's `/api/<method>` route
 * using the official client-request envelope (content-type application/json,
 * see packages/host/apiproxy/src/fetch/handler.ts).
 */
export async function rpcCall(port, method, payload, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 5_000
  const rpcId = `m3c-${Math.random().toString(36).slice(2, 10)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: controller.signal,
    })
    const body = await response.json()
    return { ok: response.status === 200 && body?.result?.ok === true, httpStatus: response.status, rpcId, body }
  } catch (error) {
    return { ok: false, httpStatus: null, rpcId, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** List node.exe processes with command lines (Windows CIM; inert elsewhere). */
export async function listNodeProcessesWindows() {
  if (process.platform !== 'win32') return []
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance -ClassName Win32_Process -Filter \\\"Name='node.exe'\\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ], { timeout: 15_000, windowsHide: true })
    const parsed = stdout.trim() === '' ? [] : JSON.parse(stdout)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.map(row => ({ pid: row.ProcessId, commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : '' }))
  } catch {
    return []
  }
}

// ── acceptance-domain topology isolation (red line 14, scenario 27) ──────────

/**
 * Assert the four-domain isolation invariant for one acceptance drill: every
 * acceptance path (home/storage/sessions/workspace/evidence) must live inside
 * the drill domain, the drill domain must live inside drills/, and none of
 * them may intersect the control domain, any lkg/candidate path, or a
 * foreign home. Returned as data; the caller fails loud on any violation.
 */
export function acceptanceIsolation(drillDir, control) {
  const violations = []
  const drill = resolve(drillDir)
  if (!isInside(control.drillsDir, drill)) violations.push(`drill domain ${drill} is not inside drills/`)
  const domains = {
    home: join(drill, 'home'),
    storageRoot: join(drill, 'storage-root'),
    sessionsRoot: join(drill, 'sessions-root'),
    workspace: join(drill, 'workspace'),
    evidence: join(drill, 'evidence'),
  }
  for (const [name, path] of Object.entries(domains)) {
    if (!isInside(drill, path)) violations.push(`acceptance ${name} escapes the drill domain: ${path}`)
    if (isInside(control.controlHome, path) || isInside(path, control.controlHome)) violations.push(`acceptance ${name} intersects the control home`)
    if (isInside(control.lkgDir, path) || isInside(path, control.lkgDir)) violations.push(`acceptance ${name} intersects the LKG domain`)
    if (isInside(control.candidatesDir, path) || isInside(path, control.candidatesDir)) violations.push(`acceptance ${name} intersects the candidates domain`)
  }
  return { ok: violations.length === 0, violations, domains }
}

// ── ledger chain-tail anchors in git (issue #122, F5 — OQ-11 reversal) ───────

/** Tag name candidates for one promotion record (gen number + unique seq). */
export function ledgerAnchorTagNames(gen, seq) {
  return [`d2-ledger-${gen}`, `d2-ledger-${gen}.${seq}`]
}

async function defaultGit(cwd, args) {
  const { git } = await import('./runner.mjs')
  return git(cwd, args)
}

/**
 * Anchor one promotion's ledger tail as a LOCAL annotated git tag (never
 * pushed — credentials face excluded, OQ-11's original reasoning). The sha256
 * ledger chain has no key and no external fact: anyone with write access to
 * the ledger could recompute the whole chain (the F5 forgery face). The tag
 * message carries the promoting record's full `recordSha256`, so any later
 * whole-chain recomputation changes that hash and the status-side
 * `verifyLedgerAnchors` check fails against the immutable tag object.
 *
 * Names: `d2-ledger-<gen>` for the first promotion of a generation number;
 * `d2-ledger-<gen>.<seq>` when that name is already taken by an earlier
 * promotion of the same generation number (a rollback + re-promote reuses gen
 * numbers; the ledger seq is unique). Re-anchoring the SAME record is a
 * no-op.
 */
export async function anchorLedgerTail({ repo, gen, seq, tailRecordSha256, action }, deps = {}) {
  const gitImpl = deps.git ?? defaultGit
  const message = [
    'D2 promotion-ledger chain-tail anchor (issue #122, F5; OQ-11 reversal)',
    `action: ${action}`,
    `gen: ${gen}`,
    `ledgerSeq: ${seq}`,
    `tailRecordSha256: ${tailRecordSha256}`,
  ].join('\n')
  for (const tagName of ledgerAnchorTagNames(gen, seq)) {
    const existing = await gitImpl(repo, ['rev-parse', '-q', '--verify', `refs/tags/${tagName}`])
    if (existing.code === 0) {
      const show = await gitImpl(repo, ['for-each-ref', `refs/tags/${tagName}`, '--format=%(contents)'])
      if (show.stdout.includes(tailRecordSha256)) return { tagName, alreadyAnchored: true }
      continue // this name anchors an earlier promotion of the same gen — take the seq-suffixed name
    }
    // Annotated tags need a tagger identity; the lane env deliberately hides
    // the user's global gitconfig, so identity is explicit and deterministic.
    const tag = await gitImpl(repo, ['-c', 'user.name=d2-promoter', '-c', 'user.email=promoter@d2.invalid', 'tag', '-a', tagName, '-m', message])
    if (tag.code !== 0) throw new Error(`ledger chain-tail anchor tag failed (${tagName}): ${tag.stderr || tag.stdout}`)
    return { tagName, alreadyAnchored: false }
  }
  throw new Error(`both anchor tag names for gen ${gen} seq ${seq} already exist without carrying tail ${tailRecordSha256}`)
}

/**
 * Verify the ledger's LATEST promotion/gen-establishment record against its
 * git anchor (the "tail anchor" check status runs): the expected tag must
 * exist and its message must carry that record's exact `recordSha256`.
 * A tag for that generation carrying a DIFFERENT tail hash means the chain
 * was recomputed after anchoring — fail. No tag at all is a failure only
 * once the anchor era has begun (some d2-ledger tag exists); a lineage whose
 * promotions all predate the feature reports `preAnchorEra: true`
 * (informational, matches the legacy dogfood root).
 */
export async function verifyLedgerAnchors({ repo, records }, deps = {}) {
  const gitImpl = deps.git ?? defaultGit
  const promotions = records.filter(record => record.action === 'promote' || record.action === 'gen-established')
  const result = { checked: true, ok: true, failures: [], anchoredPromotions: 0, latest: null }
  if (promotions.length === 0) {
    result.note = 'no promotion records to anchor'
    return result
  }
  const latest = promotions.at(-1)
  result.latest = { seq: latest.seq, action: latest.action, toGen: latest.toGen, recordSha256: latest.recordSha256 }
  let found = null
  for (const tagName of ledgerAnchorTagNames(latest.toGen, latest.seq)) {
    const existing = await gitImpl(repo, ['rev-parse', '-q', '--verify', `refs/tags/${tagName}`])
    if (existing.code !== 0) continue
    const show = await gitImpl(repo, ['for-each-ref', `refs/tags/${tagName}`, '--format=%(contents)'])
    if (show.stdout.includes(latest.recordSha256)) found = tagName
    else if (found === null) {
      result.failures.push(`anchor tag ${tagName} exists but carries a different chain tail than ledger seq ${latest.seq} (${latest.recordSha256.slice(0, 16)}…) — the ledger was recomputed after anchoring`)
    }
  }
  if (found !== null) {
    result.anchorTag = found
    result.anchoredPromotions = 1
    return result
  }
  const anyTag = await gitImpl(repo, ['tag', '-l', 'd2-ledger-*'])
  if ((anyTag.stdout.trim() ?? '') !== '') {
    result.failures.push(`latest promotion (seq ${latest.seq}, action ${latest.action}, toGen ${latest.toGen}) has no matching anchor tag — anchor it (see promote --repo) before proceeding`)
    result.ok = false
    return result
  }
  result.preAnchorEra = true
  result.note = 'no d2-ledger anchors exist in the repo (pre-anchor-era lineage); informational'
  return result
}

// ── installed-bytes reconciliation (issue #122, F3 machine check) ────────────

/**
 * Deterministic content digest of a directory tree: every FILE (symlinks
 * skipped) visited in sorted order, hashed as `relpath\0sha256\n` lines and
 * chained through sha256. Stable across runs and machines.
 */
export async function directoryContentDigest(directory) {
  const lines = []
  const walk = async dir => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        lines.push(`${relative(directory, path).replaceAll('\\', '/')}\0${await sha256File(path)}\n`)
      }
    }
  }
  await walk(directory)
  return sha256Hex(lines.join(''))
}

/**
 * Per-file digest map of a directory tree (files only, sorted, forward-slash
 * relative paths) — the ground-truth form `reconcileInstalledProfile`
 * compares, since pnpm's installed copy additionally carries layout-only
 * `node_modules/.bin` shims inside the package directory (verified live:
 * every artifact file is byte-identical, only those shims are extra).
 */
export async function treeFileDigests(directory) {
  const files = new Map()
  const walk = async dir => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.set(relative(directory, path).replaceAll('\\', '/'), await sha256File(path))
    }
  }
  await walk(directory)
  return files
}

/**
 * Reconcile the stable control Profile's INSTALLED plugin bytes against the
 * LKG pointer's generation tarball (issue #122, F3): before this check,
 * status only read dependency presence — a promote that died between
 * `installIntoStableProfile` and `establishGeneration` left the stable
 * Profile on candidate bytes with the pointer untouched and chainOk still
 * true, silently. The current generation tarball is extracted (through the
 * injectable `extract(tarball, destDir)`, tar-backed by default); EVERY file
 * of the tarball's package/ tree must exist in the installed package with
 * the exact same digest. Files pnpm adds inside the package directory
 * (node_modules/.bin shims) are reported as informational `extraFiles`, not
 * failures — the frozen artifact's own file set is the contract.
 */
export async function reconcileInstalledProfile({ layout, pointer, extract }) {
  if (pointer === undefined) return { checked: false, reason: 'no LKG pointer — nothing to reconcile against' }
  if (extract === undefined) throw new Error('reconcileInstalledProfile: extract(tarball, destDir) is required')
  const profileManifest = await stat(join(layout.controlProfileDir, 'package.json')).catch(() => undefined)
  if (profileManifest === undefined) {
    // No stable Profile at all (fresh root, or a drill copy lineage without a
    // control home) — not an installed-bytes divergence, and controlHomePresent
    // already reports it on the status face.
    return { checked: false, reason: 'stable control Profile not installed (no profile package.json)', pointerGen: pointer.currentGen }
  }
  const installedDir = await realpath(join(layout.controlProfileDir, 'node_modules', 'dsh-agent-swarm')).catch(() => undefined)
  if (installedDir === undefined) {
    return { checked: true, matches: false, reason: 'stable Profile exists but has no dsh-agent-swarm package installed', pointerGen: pointer.currentGen }
  }
  const tarball = join(genDir(layout.lkgDir, pointer.currentGen), 'dsh-agent-swarm.tgz')
  const tarInfo = await stat(tarball).catch(() => undefined)
  if (tarInfo === undefined) {
    return { checked: true, matches: false, reason: `current generation tarball missing: ${tarball}`, pointerGen: pointer.currentGen }
  }
  const scratch = await mkdtemp(join(tmpdir(), 'd2-reconcile-'))
  try {
    await extract(tarball, scratch)
    const expected = await treeFileDigests(join(scratch, 'package'))
    const installed = await treeFileDigests(installedDir)
    const missing = []
    const mismatched = []
    for (const [rel, digest] of expected) {
      if (!installed.has(rel)) missing.push(rel)
      else if (installed.get(rel) !== digest) mismatched.push(rel)
    }
    const extraFiles = [...installed.keys()].filter(rel => !expected.has(rel))
    const matches = missing.length === 0 && mismatched.length === 0
    const reason = matches ? undefined
      : `artifact files missing: ${missing.join(', ')}; digest mismatch: ${mismatched.join(', ')}`
    return {
      checked: true,
      matches,
      ...(reason !== undefined ? { reason } : {}),
      pointerGen: pointer.currentGen,
      installedDir,
      artifactFiles: expected.size,
      extraFiles,
      installedContentSha256: await directoryContentDigest(installedDir),
      expectedContentSha256: await directoryContentDigest(join(scratch, 'package')),
    }
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
}
