/**
 * Machine audit of the docs/08 §3 protocol-scenario matrix.
 *
 * Contract (single source of truth is the "Scenario audit:" line in §7):
 * 1. tests carry evidence as `it('scenario N: ...')` titles or
 *    `// scenario-evidence: N` markers at the proving assertion;
 * 2. the §7 audit line partitions ALL §3 scenarios into
 *    `implemented` and `not yet proven`;
 * 3. `implemented` must equal the evidence found in tests, exactly, in both
 *    directions — claiming a scenario without a proving test fails, and a
 *    tagged test the docs do not claim fails.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const failures = []

const doc = await readFile(join(root, 'docs/08-testing-verification.md'), 'utf8')
const section3 = doc.split(/^## 3\..*$/m)[1]?.split(/^## 4\..*$/m)[0] ?? ''
const scenarioNums = new Set([...section3.matchAll(/^(\d+)\./gm)].map(match => Number(match[1])))
if (scenarioNums.size === 0) failures.push('docs/08 §3: no numbered scenarios found')

function expand(list) {
  const out = new Set()
  for (const part of list.split(',').map(value => value.trim()).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n += 1) out.add(n)
    } else if (/^\d+$/.test(part)) {
      out.add(Number(part))
    } else {
      failures.push(`docs/08 §7 scenario-audit line: unparsable entry "${part}"`)
    }
  }
  return out
}

const auditMatch = /Scenario audit: implemented = ([\d,\s-]+?);\s*not yet proven = ([\d,\s-]+?)\./.exec(doc)
if (auditMatch === null) {
  failures.push('docs/08 §7: missing the "Scenario audit: implemented = ...; not yet proven = ..." line')
}
const claimed = auditMatch ? expand(auditMatch[1]) : new Set()
const notProven = auditMatch ? expand(auditMatch[2]) : new Set()

const evidence = new Set()
const testsDir = join(root, 'tests')
for (const name of await readdir(testsDir)) {
  if (!name.endsWith('.spec.ts')) continue
  const content = await readFile(join(testsDir, name), 'utf8')
  for (const match of content.matchAll(/scenario (\d+):/g)) evidence.add(Number(match[1]))
  for (const match of content.matchAll(/scenario-evidence: (\d+)/g)) evidence.add(Number(match[1]))
}

for (const n of claimed) {
  if (!scenarioNums.has(n)) failures.push(`§7 claims scenario ${n} which does not exist in §3`)
  if (!evidence.has(n)) failures.push(`§7 claims scenario ${n} as implemented but no test carries its evidence tag`)
  if (notProven.has(n)) failures.push(`scenario ${n} is both implemented and not yet proven`)
}
for (const n of evidence) {
  if (!scenarioNums.has(n)) failures.push(`tests tag scenario ${n} which does not exist in §3`)
  if (!claimed.has(n)) failures.push(`tests prove scenario ${n} but §7 does not claim it — update the audit line`)
}
for (const n of scenarioNums) {
  if (!claimed.has(n) && !notProven.has(n)) {
    failures.push(`scenario ${n} is in neither partition of the §7 audit line`)
  }
}

if (failures.length > 0) {
  console.error('Scenario audit failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`Protocol scenario audit: ${claimed.size}/${scenarioNums.size} scenarios machine-proven, ${notProven.size} explicitly unproven: PASS`)
}
