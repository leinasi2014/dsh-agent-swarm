/**
 * Type declarations for the release-anchor decision core exported by
 * scripts/verify-official-baseline.mjs. The module is verification tooling,
 * not shipped code; these declarations exist so the vitest suite in
 * tests/official-baseline-anchor.spec.ts drives the pure core type-safely.
 */

export interface RemoteTagFact {
  name: string
  sha: string
  peeled?: string
}

export interface LsRemoteFacts {
  head?: string
  branchHead?: string
  tags: RemoteTagFact[]
}

export interface AncestryFacts {
  /** True/false once proven; null means "not yet checked". */
  tag: boolean | null
  head: boolean | null
}

export interface BaselineAnchorInput {
  pin: string
  release: string
  branch: string
  head?: string
  branchHead?: string
  tags: RemoteTagFact[]
  ancestry: AncestryFacts
}

export type BaselineAnchorKind =
  | 'release-tag'
  | 'release-tag-history'
  | 'pending-tag-head'
  | 'pending-tag-history'

export interface AncestryRequest {
  fact: 'tag' | 'head'
  sha: string
  ref: string
}

export interface BaselineAnchorVerdict {
  status: 'pass' | 'fail' | 'needs-ancestry'
  anchor: BaselineAnchorKind | null
  detail: string
  failures: string[]
  warnings: string[]
  notes: string[]
  ancestryRequest: AncestryRequest | null
}

export function tagNameForRelease(release: string): string

export function parseReleaseVersion(release: string): { major: number; minor: number; patch: number; rc: number | null } | null

export function compareReleaseVersions(a: string, b: string): number

export function parseLsRemote(output: string, branch: string): LsRemoteFacts

export function evaluateBaselineAnchor(input: BaselineAnchorInput): BaselineAnchorVerdict

export interface OfficialCheckoutBaseline {
  commit: string
  release: string
}

export interface OfficialCheckoutFacts {
  root: string
  head: string
  packageName?: string
  packageVersion?: string
}

export function enclosingCheckoutCandidates(pluginRoot: string): string[]

export function discoverOfficialCheckout(input: {
  pluginRoot: string
  override?: string
  baseline: OfficialCheckoutBaseline
  inspect(candidate: string): Promise<OfficialCheckoutFacts>
}): Promise<string>

export interface OfficialEvidenceResult {
  failures: string[]
  warnings: string[]
  notes: string[]
  anchorDetail: string
}

export function collectOfficialBaselineEvidence(input: {
  discover(): Promise<string>
  verifyRemote(): Promise<OfficialEvidenceResult>
  verifyLocal(checkout: string): Promise<{ failures: string[] }>
}): Promise<OfficialEvidenceResult>

export type GitProbe = (args: string[], cwd?: string) => Promise<string>

export function inspectOfficialCheckout(candidate: string, runGit?: GitProbe): Promise<OfficialCheckoutFacts>

export function verifyReleaseReachability(input: {
  repository: string
  pin: string
  commit: string
  runGit?: GitProbe
  createEvidenceRepository?: () => Promise<string>
  removeEvidenceRepository?: (directory: string) => Promise<void>
}): Promise<boolean | null>

export function verifyLocalCheckout(input: {
  baseline: OfficialCheckoutBaseline & {
    evidenceFiles?: string[]
    packages: Array<{ path: string, name: string, visibility: 'private' | 'public' }>
  }
  checkout: string
  runGit?: GitProbe
  readEvidenceFile?: (path: string, encoding: 'utf8') => Promise<unknown>
}): Promise<{ failures: string[] }>
