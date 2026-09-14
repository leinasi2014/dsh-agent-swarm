// Copied to the controller-owned, candidate-read-only tools directory.
// It starts with no inherited stdio or controller credentials. All child pipes
// are created under the dedicated account's ordinary Windows token.
import { spawn } from 'node:child_process'
import { openSync, closeSync, writeSync, readFileSync } from 'node:fs'

const specification = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const stdout = openSync(specification.stdout, 'w')
const stderr = openSync(specification.stderr, 'w')
let outBytes = 0
let errBytes = 0
const limit = 8 * 1024 * 1024
try {
  const child = spawn(specification.command, specification.args, {
    cwd: specification.cwd, env: specification.env, windowsHide: true,
    shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => {
    if (outBytes < limit) outBytes += writeSync(stdout, chunk.subarray(0, limit - outBytes))
  })
  child.stderr.on('data', chunk => {
    if (errBytes < limit) errBytes += writeSync(stderr, chunk.subarray(0, limit - errBytes))
  })
  child.on('error', () => { process.exitCode = 127 })
  child.on('close', code => {
    closeSync(stdout); closeSync(stderr)
    process.exitCode = code ?? 127
  })
} catch {
  closeSync(stdout); closeSync(stderr)
  process.exitCode = 127
}
