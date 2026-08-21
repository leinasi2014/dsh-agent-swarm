/**
 * Type declarations for the external promoter contract core exported by
 * scripts/promotion/lib.mjs (issue #102 / ADR-0008 D2). The module is
 * control-plane tooling, never shipped plugin code — these declarations
 * exist so tests/promotion-contract.spec.ts drives the contract type-safely,
 * exactly like the scripts/verify-official-baseline.d.mts precedent.
 */

export type LedgerAction = 'gen-established' | 'accepted' | 'promote' | 'rollback' | 'reject'

export interface ControlRootLayout {
  root: string
  controlHome: string
  controlStorage: string
  controlSessions: string
  controlProfileDir: string
  lkgDir: string
  lkgPointerPath: string
  candidatesDir: string
  drillsDir: string
  ledgerPath: string
}

export interface CandidateManifest {
  schemaVersion: 1
  candidateId: string
  gitCommit: string
  gitTree: string
  tarballSha256: string
  tarballBytes: number
  builtBy: string
  builtAt: string
  buildCommand: string[]
  packageVersion: string
  peerPins: Record<string, string>
  acceptanceFloor: string[]
  reviewRef?: string
  injected?: string
}

export interface LkgGenRecord {
  schemaVersion: 1
  gen: number
  prevGen: number | null
  candidateId: string
  gitCommit: string
  gitTree: string
  tarballSha256: string
  tarballBytes: number
  verdictRef: { candidateId: string; sha256: string } | null
  establishedAt: string
  ledgerSeq: number
}

export interface LkgPointer {
  schemaVersion: 1
  currentGen: number
  prevGen: number | null
  currentTarballSha256: string
  updatedAt: string
}

export interface LedgerRecord {
  seq: number
  time: string
  action: LedgerAction
  actor: string
  candidateId: string | null
  gitCommit: string | null
  gitTree: string | null
  tarballSha256: string | null
  tarballBytes: number | null
  fromGen: number | null
  toGen: number | null
  record: Record<string, unknown>
  profileIdentity: { profileName: string; dshHome: string } | null
  verdictRef: { candidateId: string; sha256: string } | null
  prevRecordSha256: string
  recordSha256: string
}

export interface VerdictGate {
  gate: string
  status: 'pass' | 'fail' | 'skip'
  detail?: string
  evidencePath?: string
  evidenceSha256?: string
}

export interface AcceptanceVerdict {
  schemaVersion: 1
  candidateId: string
  tarballSha256: string
  overall: 'pass' | 'fail'
  gates: VerdictGate[]
  run: Record<string, unknown>
  /** Presence is a contract violation: acceptance evidence may not promote itself (verifyVerdict refuses). */
  promotionVerb?: string
}

export interface QuiesceCriterion {
  criterion: 'no-active-team' | 'no-live-session-traffic' | 'no-stable-process'
  pass: boolean
  detail: string
}

export interface QuiesceResult {
  quiet: boolean
  criteria: QuiesceCriterion[]
}

export interface ProcessRow {
  pid: number
  commandLine: string
}

export interface RpcProbeResult {
  ok: boolean
  httpStatus: number | null
  rpcId: string
  body?: unknown
  error?: string
}

export function controlRootLayout(root: string): ControlRootLayout

export function genDir(lkgDir: string, gen: number): string

export function stableStringify(value: unknown): string

export function sha256Hex(input: string | Uint8Array): string

export function sha256File(path: string): Promise<string>

export function readJsonFile(path: string): Promise<unknown>

export function writeJsonFile(path: string, value: unknown): Promise<void>

export function isInside(parent: string, child: string): boolean

export function verifyArtifactAgainstManifest(manifest: CandidateManifest | undefined, tarballPath: string): Promise<{ ok: boolean; failures: string[] }>

export function ledgerRecordHash(previousHash: string, recordBody: unknown): string

export function appendLedgerRecord(ledgerPath: string, body: Partial<LedgerRecord>): Promise<LedgerRecord>

export function readLedger(ledgerPath: string): Promise<LedgerRecord[]>

export function verifyLedgerChain(records: LedgerRecord[]): { ok: boolean; failures: string[] }

export function ledgerGenState(records: LedgerRecord[]): { currentGen: number | null; lastGenAction: LedgerAction | null }

export function readLkgPointer(lkgDir: string): Promise<LkgPointer | undefined>

export function verifyLkgChain(lkgDir: string, ledgerRecords?: LedgerRecord[]): Promise<{ ok: boolean; failures: string[]; pointer?: LkgPointer }>

export function checkFencing(
  pointer: LkgPointer | undefined,
  ledgerRecords: LedgerRecord[],
  input: { action: 'establish' | 'promote' | 'rollback'; expectGen?: number; toGen?: number },
): { ok: boolean; reason: string }

export function establishGeneration(lkgDir: string, ledgerPath: string, input: {
  action: 'gen-established' | 'promote'
  gen: number
  prevGen?: number | null
  tarballPath: string
  candidateId: string
  gitCommit: string
  gitTree: string
  tarballSha256: string
  tarballBytes: number
  verdictRef?: { candidateId: string; sha256: string } | null
  reason?: string
  profileIdentity?: { profileName: string; dshHome: string } | null
  actor?: string
  expectPrevGen?: number
}): Promise<{ gen: number; genRecord: LkgGenRecord; pointer: LkgPointer; ledgerRecord: LedgerRecord }>

export function rollPointerBack(
  lkgDir: string,
  ledgerPath: string,
  targetGen: number,
  details?: { reason?: string; actor?: string; context?: unknown; profileIdentity?: { profileName: string; dshHome: string } | null },
): Promise<LedgerRecord>

export function verifyVerdict(verdict: AcceptanceVerdict | undefined, manifest: CandidateManifest | undefined, evidenceBaseDir?: string): Promise<{ ok: boolean; failures: string[] }>

export function activeTeamsFromUnitText(text: string | undefined): { teamId: string; phase: string }[]

export function sessionsFingerprint(sessionsRoot: string): Promise<Map<string, string>>

export function evaluateQuiesce(
  control: { storageRoot: string; sessionsRoot: string; home: string },
  deps?: { readFile?: ((path: string, encoding: 'utf8') => Promise<string>) | undefined; listNodeProcesses?: (() => Promise<ProcessRow[]>) | undefined; delay?: ((ms: number) => Promise<void>) | undefined; windowMs?: number },
): Promise<QuiesceResult>

export function rpcCall(port: number, method: string, payload: unknown, options?: { fetchImpl?: typeof fetch | undefined; timeoutMs?: number | undefined }): Promise<RpcProbeResult>

export function listNodeProcessesWindows(): Promise<ProcessRow[]>

export function acceptanceIsolation(drillDir: string, control: ControlRootLayout): { ok: boolean; violations: string[]; domains: { home: string; storageRoot: string; sessionsRoot: string; workspace: string; evidence: string } }
