// Gate A official-baseline verification — release-anchored (issue #105).
//
// The baseline pin is a release merge commit, not a moving HEAD. This script
// proves the pin is an official release before any snapshot check counts:
//
// 1. primary anchor: the remote release tag `dsh-v<release>` exists and lands
//    exactly on the pinned commit (both observed release flows — rc.8's
//    141eb6f and 0.1.1-rc.1's 528c682 — tag the release merge SHA itself), or
//    the tag's commit demonstrably contains the pin (`git merge-base
//    --is-ancestor` after fetching just that commit into the evidence
//    checkout, whose shallow boundary sits at the pin);
// 2. tag-pending window (the official flow publishes npm before pushing the
//    tag): the pin must still be the remote branch tip, or a verified
//    ancestor of it, and the verdict carries an explicit warning;
// 3. anything else is red: the pin is not a provable release.
//
// Official master advancing past the pin is expected between releases: it is
// reported as a note, never as a failure. A newer published release makes a
// re-pin due (docs/11 section 2) and is reported as a warning, not a failure.
//
// The snapshot checks (checkout at the pin, clean tree, evidenceFiles,
// package visibility) are unchanged from the HEAD-equality era.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))

// ---------------------------------------------------------------------------
// Pure decision core. Unit-tested in tests/official-baseline-anchor.spec.ts;
// typed for those tests by scripts/verify-official-baseline.d.mts.
// ---------------------------------------------------------------------------

const RELEASE_TAG_PREFIX = 'dsh-v'

export function tagNameForRelease(release) {
  return `${RELEASE_TAG_PREFIX}${release}`
}

export function parseReleaseVersion(release) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(release)
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: match[4] === undefined ? null : Number(match[4]),
  }
}

export function compareReleaseVersions(a, b) {
  const left = parseReleaseVersion(a)
  const right = parseReleaseVersion(b)
  // Unparsable names never order: callers filter through parseReleaseVersion
  // before asking for an ordering.
  if (left === null || right === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.rc === null && right.rc === null) return 0
  // A final release outranks any rc of the same x.y.z; rc numbers compare
  // numerically (rc.10 > rc.9).
  if (left.rc === null) return 1
  if (right.rc === null) return -1
  return left.rc - right.rc
}

export function parseLsRemote(output, branch) {
  const facts = { head: undefined, branchHead: undefined, tags: [] }
  const byName = new Map()
  for (const line of output.split(/\r?\n/)) {
    if (line === '') continue
    const [sha, ref] = line.split(/\s+/, 2)
    if (sha === undefined || ref === undefined) continue
    if (ref === 'HEAD') {
      facts.head = sha
      continue
    }
    if (ref === `refs/heads/${branch}`) {
      facts.branchHead = sha
      continue
    }
    if (!ref.startsWith('refs/tags/')) continue
    const name = ref.slice('refs/tags/'.length)
    if (name.endsWith('^{}')) {
      // Peeled line of an annotated tag: the commit the tag object points at.
      const base = name.slice(0, -3)
      const entry = byName.get(base) ?? { name: base, sha: '' }
      entry.peeled = sha
      byName.set(base, entry)
      continue
    }
    const entry = byName.get(name) ?? { name, sha: '' }
    entry.sha = sha
    byName.set(name, entry)
  }
  facts.tags = [...byName.values()].filter(tag => tag.sha !== '')
  return facts
}

export function evaluateBaselineAnchor(input) {
  const tagName = tagNameForRelease(input.release)
  const tag = input.tags.find(entry => entry.name === tagName)
  const tagCommit = tag === undefined ? undefined : tag.peeled ?? tag.sha
  const tip = input.branchHead ?? input.head
  const notes = []
  const warnings = []
  const newerReleases = input.tags
    .map(entry => (entry.name.startsWith(RELEASE_TAG_PREFIX) ? entry.name.slice(RELEASE_TAG_PREFIX.length) : null))
    .filter(name => name !== null && compareReleaseVersions(name, input.release) > 0)
    .sort((a, b) => compareReleaseVersions(b, a))

  if (newerReleases.length > 0) {
    warnings.push(`official release(s) ${newerReleases.map(tagNameForRelease).join(', ')} newer than the pinned ${input.release} are published: a re-pin is due (docs/11 section 2)`)
  }
  if (input.branchHead !== undefined && input.branchHead !== input.pin) {
    notes.push(`official ${input.branch} advanced to ${input.branchHead}; the baseline stays release-anchored at ${input.release} ${input.pin}`)
  }

  const pass = (anchor, detail) => ({ status: 'pass', anchor, detail, failures: [], warnings, notes, ancestryRequest: null })
  const fail = failure => ({ status: 'fail', anchor: null, detail: failure, failures: [failure], warnings, notes, ancestryRequest: null })

  if (tag !== undefined) {
    if (tagCommit === input.pin) {
      return pass('release-tag', `release tag ${tagName} landed on the pinned commit ${input.pin}`)
    }
    if (input.ancestry.tag === true) {
      return pass('release-tag-history', `release tag ${tagName} commit ${tagCommit} contains the pinned commit ${input.pin}`)
    }
    if (input.ancestry.tag === null) {
      return {
        status: 'needs-ancestry',
        anchor: null,
        detail: `release tag ${tagName} is ${tagCommit}; proving it contains the pin requires a reachability check`,
        failures: [],
        warnings,
        notes,
        ancestryRequest: { fact: 'tag', sha: tagCommit, ref: `refs/tags/${tagName}` },
      }
    }
    return fail(`release tag ${tagName} is ${tagCommit} and does not contain the pinned commit ${input.pin}`)
  }

  if (newerReleases.length > 0) {
    return fail(`baseline release ${input.release} has no release tag while newer official release(s) ${newerReleases.map(tagNameForRelease).join(', ')} exist: the pin cannot be proven to be a release — re-pin per docs/11 section 2`)
  }
  if (tip === input.pin) {
    warnings.push(`release tag ${tagName} has not landed yet (the official flow publishes npm before pushing the tag); the pin is the remote ${input.branch} tip — re-run Gate A once the tag lands to upgrade the anchor`)
    return pass('pending-tag-head', `pin ${input.pin} is the remote ${input.branch} tip while tag ${tagName} is pending`)
  }
  if (input.ancestry.head === true) {
    warnings.push(`release tag ${tagName} has not landed yet (the official flow publishes npm before pushing the tag); the pin is a verified ancestor of remote ${input.branch} ${tip} — re-run Gate A once the tag lands to upgrade the anchor`)
    return pass('pending-tag-history', `pin ${input.pin} is an ancestor of remote ${input.branch} ${tip} while tag ${tagName} is pending`)
  }
  if (input.ancestry.head === null && tip !== undefined) {
    return {
      status: 'needs-ancestry',
      anchor: null,
      detail: `tag ${tagName} is missing and the remote ${input.branch} tip ${tip} differs from the pin; proving containment requires a reachability check`,
      failures: [],
      warnings,
      notes,
      ancestryRequest: { fact: 'head', sha: tip, ref: `refs/heads/${input.branch}` },
    }
  }
  return fail(`pin ${input.pin} is not any official release: tag ${tagName} is missing and the pin is not reachable from ${tip === undefined ? `remote ${input.branch}` : `remote ${input.branch} ${tip}`}`)
}

const OFFICIAL_ROOT_PACKAGE = '@deepseek-ai/dsh-root'

/**
 * Return every enclosing directory outside the independently versioned plugin.
 * The nearest candidate wins; discovery never relies on a directory name.
 */
export function enclosingCheckoutCandidates(pluginRoot) {
  const candidates = []
  let current = dirname(resolve(pluginRoot))
  while (true) {
    candidates.push(current)
    const parent = dirname(current)
    if (parent === current) return candidates
    current = parent
  }
}

/**
 * Resolve one exact official checkout without persisting a machine path.
 * An explicit override is authoritative: an invalid override fails closed and
 * never falls back to an enclosing repository.
 */
export async function discoverOfficialCheckout({ pluginRoot, override, baseline, inspect }) {
  const candidates = override === undefined || override.trim() === ''
    ? enclosingCheckoutCandidates(pluginRoot)
    : [resolve(override)]
  const pluginGitRoot = resolve(pluginRoot)
  const inspectedRoots = new Set()

  for (const candidate of candidates) {
    let facts
    try {
      facts = await inspect(candidate)
    } catch {
      continue
    }
    const checkout = resolve(facts.root)
    if (checkout === pluginGitRoot || inspectedRoots.has(checkout)) continue
    inspectedRoots.add(checkout)
    if (facts.packageName !== OFFICIAL_ROOT_PACKAGE) continue
    if (facts.packageVersion !== baseline.release) continue
    if (facts.head !== baseline.commit) continue
    return checkout
  }

  const source = override === undefined || override.trim() === '' ? 'enclosing repositories' : 'DSH_OFFICIAL_CHECKOUT'
  throw new Error(`${source} did not identify the pinned official DSH checkout`)
}

// ---------------------------------------------------------------------------
// Runner. Only the thin I/O adapter below talks to git and the filesystem.
// ---------------------------------------------------------------------------

async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    ...(cwd === undefined ? {} : { cwd }),
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.trim()
}

async function inspectOfficialCheckout(candidate) {
  const checkout = await git(['rev-parse', '--show-toplevel'], candidate)
  const head = await git(['rev-parse', 'HEAD'], checkout)
  const manifest = JSON.parse(await git(['show', 'HEAD:package.json'], checkout))
  return {
    root: checkout,
    head,
    packageName: manifest.name,
    packageVersion: manifest.version,
  }
}

async function verifyReleaseReachability(repository, checkout, pin, commit) {
  // Fetch only the commits connecting `commit` to the pinned checkout: the
  // evidence checkout is a depth-1 shallow clone rooted at the pin, so the
  // fetch terminates at the existing shallow boundary. HEAD and the worktree
  // stay untouched; only FETCH_HEAD and object storage are written, so the
  // "detached at pin, clean tree" invariants below remain authoritative.
  try {
    await git(['fetch', '--quiet', '--no-tags', repository, commit], checkout)
  } catch {
    return null
  }
  try {
    await git(['merge-base', '--is-ancestor', pin, 'FETCH_HEAD'], checkout)
    return true
  } catch (error) {
    // merge-base --is-ancestor exits 1 for "not an ancestor"; anything else
    // is a real git failure and must not be read as a verdict.
    return error.code === 1 ? false : null
  }
}

async function main() {
  const baseline = JSON.parse(await readFile(resolve(root, 'docs/OFFICIAL_BASELINE.json'), 'utf8'))
  const failures = []
  const warnings = []
  const notes = []
  let anchorDetail = 'release anchor not evaluated'
  let checkout

  try {
    checkout = await discoverOfficialCheckout({
      pluginRoot: root,
      override: process.env.DSH_OFFICIAL_CHECKOUT,
      baseline,
      inspect: inspectOfficialCheckout,
    })
  } catch (error) {
    failures.push(`cannot discover official checkout: ${String(error)}`)
  }

  if (checkout !== undefined) {
    try {
      const remote = await git(['ls-remote', baseline.repository, 'HEAD', `refs/heads/${baseline.branch}`, 'refs/tags/dsh-v*'])
      const facts = parseLsRemote(remote, baseline.branch)
      const input = {
        pin: baseline.commit,
        release: baseline.release,
        branch: baseline.branch,
        head: facts.head,
        branchHead: facts.branchHead,
        tags: facts.tags,
        ancestry: { tag: null, head: null },
      }
      let verdict = evaluateBaselineAnchor(input)
      if (verdict.status === 'needs-ancestry') {
        const request = verdict.ancestryRequest
        const reachable = await verifyReleaseReachability(baseline.repository, checkout, input.pin, request.sha)
        if (reachable === null) {
          failures.push(`cannot prove that the pinned commit is contained in ${request.ref} (${request.sha}): the reachability check could not run (network failure or missing local history)`)
        } else {
          input.ancestry[request.fact] = reachable
          verdict = evaluateBaselineAnchor(input)
        }
      }
      warnings.push(...verdict.warnings)
      notes.push(...verdict.notes)
      if (verdict.status === 'pass') anchorDetail = verdict.detail
      else failures.push(...verdict.failures)
    } catch (error) {
      failures.push(`cannot query official remote: ${String(error)}`)
    }

    try {
      const localHead = await git(['rev-parse', 'HEAD'], checkout)
      if (localHead !== baseline.commit) failures.push(`official checkout HEAD is ${localHead}, baseline is ${baseline.commit}`)
      const dirty = await git(['status', '--porcelain'], checkout)
      if (dirty !== '') failures.push('official checkout is dirty')

      for (const evidenceFile of baseline.evidenceFiles ?? []) {
        try {
          await readFile(resolve(checkout, evidenceFile), 'utf8')
        } catch {
          failures.push(`official evidence file is not materialized in the checkout: ${evidenceFile}`)
        }
      }

      for (const expected of baseline.packages) {
        const raw = await git(['show', `${baseline.commit}:${expected.path}/package.json`], checkout)
        const manifest = JSON.parse(raw)
        if (manifest.name !== expected.name) {
          failures.push(`${expected.path}: expected ${expected.name}, found ${manifest.name ?? 'unnamed'}`)
        }
        if (expected.visibility === 'private') {
          if (manifest.private !== true) failures.push(`${expected.name}: expected private package`)
          if (manifest.publishConfig !== undefined) failures.push(`${expected.name}: private package must not publish`)
        } else if (manifest.private === true) {
          failures.push(`${expected.name}: expected published/public package`)
        }
      }
    } catch (error) {
      failures.push(`cannot verify discovered official checkout: ${String(error)}`)
    }
  }

  if (failures.length > 0) {
    console.error('Official-first baseline verification failed:')
    for (const failure of failures) console.error(`- ${failure}`)
    console.error('The pin must be a provable official release. Official master advancing past the pin is not by itself a failure; review the official release diff before re-pinning docs/OFFICIAL_BASELINE.json together with architecture/milestones.')
    process.exitCode = 1
  } else {
    console.log(`Official DSH ${baseline.release} baseline ${baseline.commit}: release anchor PASS (${anchorDetail}); checkout evidence and package visibility PASS`)
    for (const warning of warnings) console.log(`warning: ${warning}`)
    for (const note of notes) console.log(`note: ${note}`)
  }
}

const invokedAs = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
const selfPath = fileURLToPath(import.meta.url)
const isDirectRun = invokedAs !== undefined
  && (process.platform === 'win32' ? invokedAs.toLowerCase() === selfPath.toLowerCase() : invokedAs === selfPath)
if (isDirectRun) await main()
