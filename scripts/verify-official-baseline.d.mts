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
