import { LifecycleError, statusReport } from './worktree-lifecycle-core.mjs'

try {
  const report = statusReport({ cwd: process.cwd(), requireHealthy: true })
  console.log(`Isolation status: PASS (${report.allocations.filter(item => item.state === 'ACTIVE').length} managed writer allocation(s); authority revision ${report.revision})`)
} catch (error) {
  const code = error instanceof LifecycleError ? error.code : 'UNEXPECTED'
  console.error(`Isolation status verification failed: ${code}: ${error.message}`)
  process.exitCode = 1
}
