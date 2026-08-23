const EXPECTED = [
  '- insert:',
  '    - id: agent-swarm',
  '      name: cordis:group',
  '      group: true',
  '      disabled: true',
  '      config:',
  '        - id: agent-swarm-runtime',
  '          name: dsh-agent-swarm',
  '          config:',
  '            enabled: true',
  '            memberProvider: spawn',
  '            memberMaxDepth: 1',
  '            schedulerProvider: priority-ready',
  '            reviewProvider: manual',
]

function semanticLines(text) {
  return text.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'))
}

export function verifySafeBundlePatch(text) {
  const actual = semanticLines(text)
  const failures = []
  if (actual.length !== EXPECTED.length) failures.push(`expected ${EXPECTED.length} semantic lines, got ${actual.length}`)
  const longest = Math.max(actual.length, EXPECTED.length)
  for (let index = 0; index < longest; index += 1) {
    if (actual[index] !== EXPECTED[index]) failures.push(`line ${index + 1}: expected ${JSON.stringify(EXPECTED[index])}, got ${JSON.stringify(actual[index])}`)
  }
  return { ok: failures.length === 0, failures }
}

