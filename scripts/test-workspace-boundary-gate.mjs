import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { validateWorkspaceBoundary } from './verify-workspace-boundary.mjs'

const projectRoot = resolve('fixture', 'plugin')
const valid = {
  projectRoot,
  workspaceRoot: resolve(projectRoot, 'node_modules'),
  workspaceDefinition: 'packages: []\n',
  expectedVitestRange: '^3.2.4',
  vitestVersion: 'vitest/3.2.7 win32-x64 node-v24.18.0',
  vitestLocator: resolve(projectRoot, 'node_modules', 'vitest', 'package.json'),
}

assert.deepEqual(validateWorkspaceBoundary(valid), [])
assert.match(validateWorkspaceBoundary({ ...valid, workspaceRoot: resolve(projectRoot, '..', 'node_modules') }).join(' '), /escapes/)
assert.match(validateWorkspaceBoundary({ ...valid, workspaceDefinition: "packages:\n  - '../*'" }).join(' '), /standalone/)
assert.match(validateWorkspaceBoundary({ ...valid, vitestVersion: 'vitest/4.1.8' }).join(' '), /Vitest 3/)
assert.match(validateWorkspaceBoundary({ ...valid, vitestLocator: resolve(projectRoot, '..', 'node_modules', 'vitest', 'package.json') }).join(' '), /outside/)

console.log('Independent pnpm workspace gate positive fixture and 4 negative cases: PASS')
