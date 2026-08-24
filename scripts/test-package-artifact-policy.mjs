import assert from 'node:assert/strict'
import { verifyPublishedLifecycleScripts } from './package-artifact-policy.mjs'

assert.deepEqual(verifyPublishedLifecycleScripts({ scripts: { build: 'tsc' } }), [])

for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
  assert.deepEqual(
    verifyPublishedLifecycleScripts({ scripts: { [lifecycle]: 'lefthook install' } }),
    [`published manifest must not run development lifecycle script: ${lifecycle}`],
  )
}

console.log('Published lifecycle negative cases: PASS')
