import { execFileSync, spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256File, verifyP0Evidence, EXPECTED_P0_OFFICIAL_COMMIT, EXPECTED_P0_OFFICIAL_TREE } from './evidence.mjs'
const git = ref => execFileSync('git', ['rev-parse', ref], { encoding: 'utf8', windowsHide: true }).trim()

// Synthetic consumer fixtures, never a live receipt or acceptance collector.
function fixture(commit, tree, artifact) {
  let time = 1000
  const sessions = new Map()
  const ids = ['main', 'captain', 'member-a', 'member-b']
  for (const [index, id] of ids.entries()) sessions.set(id, {
    header: { version: 0, id, createdAt: 100, ...(index === 0 ? {} : { parentSession: index === 1 ? 'main' : 'captain' }) }, events: [],
  })
  function invoke(id, name, args, text, model = 'model-a') {
    const session = sessions.get(id)
    const events = session.events
    const turn = events.filter(event => event.type === 'turn/start').length
    const add = (type, data) => { const event = { type, seq: events.length, time: ++time, data }; events.push(event); return event.seq }
    add('turn/start', { turn })
    if (id === 'main') add('user/message', { source: { kind: 'user' }, contentSha256: 'e'.repeat(64) })
    add('request/header', { header: { config: { provider: 'configured-provider', model } } })
    const callId = `${id}-${turn}`
    const callSeq = add('tool/call', { turn, step: 0, callId, name, arguments: args })
    const resultSeq = add('tool/result', { turn, step: 0, callId, isError: false, text })
    add('turn/end', { turn, reason: { kind: 'completed' } })
    return { sessionId: id, callSeq, resultSeq, turn, callId }
  }
  const creation = invoke('main', 'agent_swarm_create_managed', { name: 'Managed proof' }, 'Created managed Team "Managed proof" (team-1) with dedicated Captain captain. Objective delivered.')
  const profile = { displayName: 'Captain', profession: 'Coordinator', personality: 'Precise', pixelAvatarSvg: '<svg viewBox="0 0 8 8"><rect width="8" height="8" fill="#111111"/></svg>' }
  const profileCall = invoke('captain', 'agent_swarm_set_captain_profile', {
    expected_revision: 1, display_name: profile.displayName, profession: profile.profession, personality: profile.personality, pixel_avatar_svg: profile.pixelAvatarSvg,
  }, 'Set Team profile (revision 2).')
  const memberRows = ids.slice(2).map((id, index) => ({ name: `worker-${index}`, sessionId: id, provider: 'dsh-subagent', phase: 'active' }))
  const recruit = memberRows.map(row => invoke('captain', 'agent_swarm_add_member', { name: row.name }, `Member ${row.name} (${row.sessionId}) is active via dsh-subagent.`))
  const tasks = [], attempts = []
  function finish(id, taskId, model) {
    const attemptId = `${taskId}-attempt`
    const submit = invoke(id, 'agent_swarm_submit_task', { task_id: taskId, expected_revision: 2, attempt_id: attemptId }, `Submitted ${taskId} at revision 3; captain review is required.`, model)
    const review = invoke('captain', 'agent_swarm_review_task', { task_id: taskId, expected_revision: 3, attempt_id: attemptId, decision: 'accept' }, `Review accept: ${taskId} is now completed at revision 4.`)
    tasks.push({ id: taskId, revision: 4, status: 'completed', ownerSessionId: id, currentAttemptId: attemptId })
    attempts.push({ id: attemptId, taskId, generation: 1, memberSessionId: id, phase: 'accepted' })
    return { submit, review }
  }
  const first = finish('member-a', 'task-a', 'model-a')
  const second = finish('member-b', 'task-b', 'model-b')
  const base = { schemaVersion: 2, id: 'team-1', revision: 1, name: 'Managed proof', captainSessionId: 'captain',
    managedOrigin: 'managed:main:turn:0', phase: 'active', members: [], tasks: [], attempts: [] }
  const created = structuredClone(base)
  const profiled = { ...structuredClone(base), revision: 2, captainProfile: profile }
  const recruited = { ...structuredClone(profiled), revision: 4, members: memberRows }
  const reviewed = { ...structuredClone(recruited), revision: 12, tasks: structuredClone(tasks), attempts: structuredClone(attempts) }
  const before = structuredClone([...sessions.values()])
  const stoppedAt = ++time, startedAt = ++time
  const next = finish('member-a', 'task-next', 'model-a')
  const later = finish('member-a', 'task-later', 'model-a')
  // Official request/header is emitted on a new loop's first request, then
  // only on header change. Later turns legitimately reuse that lifecycle's
  // header instead of emitting a fresh one for every tool call.
  for (const ref of [later.submit, later.review]) {
    const session = sessions.get(ref.sessionId)
    const redundant = session.events.filter(event => event.type === 'request/header' && event.seq < ref.callSeq).at(-1)
    session.events = session.events.filter(event => event !== redundant)
  }
  const continued = { ...structuredClone(reviewed), revision: 20, tasks, attempts }
  const files = {
    'evidence/managed-before.json': before, 'evidence/managed-after.json': [...sessions.values()],
    'evidence/managed-creation.json': created, 'evidence/managed-profile.json': profiled,
    'evidence/managed-members.json': recruited, 'evidence/managed-review.json': reviewed,
    'evidence/managed-ui-team.json': structuredClone(reviewed), 'evidence/managed-reopened.json': structuredClone(reviewed),
    'evidence/managed-restart.json': continued,
    'evidence/managed-ui.json': { source: 'in-app-browser', teamId: 'team-1', beforeRevision: 4, afterRevision: 12,
      captainProfile: { displayName: profile.displayName, profession: profile.profession },
      members: memberRows.map((row, index) => ({ name: row.name, displayName: row.name, provider: 'configured-provider', model: `model-${index === 0 ? 'a' : 'b'}` })),
      tasks: reviewed.tasks.map(task => ({ id: task.id, status: task.status })), screenshot: 'evidence/managed-ui.png' },
    'evidence/managed-ui.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]),
  }
  const manifest = { schemaVersion: 2, proofKind: 'managed-team', status: 'pass', provenance: 'controller-observed-live',
    candidate: { commit, tree, cleanBefore: true, cleanAfter: true }, artifact,
    official: { commitBefore: EXPECTED_P0_OFFICIAL_COMMIT, commitAfter: EXPECTED_P0_OFFICIAL_COMMIT,
      treeBefore: EXPECTED_P0_OFFICIAL_TREE, treeAfter: EXPECTED_P0_OFFICIAL_TREE, statusBefore: '', statusAfter: '', version: '0.1.1-rc.2' },
    profile: { dshHome: join(process.cwd(), 'isolated-profile'), provider: 'configured-provider', model: 'model-a', profileName: 'acceptance' },
    managed: { mainSessionId: 'main', captainSessionId: 'captain', memberSessionIds: ids.slice(2),
      sessionsBefore: 'evidence/managed-before.json', sessionsAfter: 'evidence/managed-after.json', phases: {
        creation: { team: 'evidence/managed-creation.json', call: creation, userMessageSeq: 1 },
        profile: { team: 'evidence/managed-profile.json', call: profileCall },
        members: { team: 'evidence/managed-members.json', calls: recruit },
        review: { team: 'evidence/managed-review.json', submissions: [first.submit, second.submit], reviews: [first.review, second.review] },
        ui: { team: 'evidence/managed-ui-team.json', observation: 'evidence/managed-ui.json' },
        restart: { team: 'evidence/managed-restart.json', reopenedTeam: 'evidence/managed-reopened.json', submissions: [next.submit, later.submit], reviews: [next.review, later.review],
          process: { beforePid: 100, afterPid: 101, stoppedAt, startedAt } },
      } },
  }
  // Controller expectation is an independent test input. Mutating manifest
  // identity below never rewrites these expected package/Profile fields.
  const expected = { requireManaged: true, proofKind: 'managed-team', candidateCommit: commit, candidateTree: tree,
    artifact: { sha256: artifact.sha256, bytes: artifact.bytes },
    official: { commit: EXPECTED_P0_OFFICIAL_COMMIT, tree: EXPECTED_P0_OFFICIAL_TREE, version: '0.1.1-rc.2' },
    profile: { dshHome: join(process.cwd(), 'isolated-profile'), provider: 'configured-provider', model: 'model-a', profileName: 'acceptance' } }
  return { manifest, files, expected }
}

function asCodeMode(value) {
  for (const path of ['evidence/managed-before.json', 'evidence/managed-after.json']) {
    for (const session of value.files[path]) {
      const calls = new Map(session.events.filter(event => event.type === 'tool/call').map(event => [event.data.callId, event]))
      session.events = session.events.flatMap(event => {
        const seq = event.seq * 3
        if (event.type === 'tool/call') {
          const data = { rootCallId: event.data.callId, parentCallId: event.data.callId, subCallId: `${event.data.callId}:code:1`, name: event.data.name, arguments: event.data.arguments }
          return [{ ...event, seq, data: { ...event.data, name: 'run_code', arguments: {} } }, { type: 'tool/code-dispatch-start', seq: seq + 1, time: event.time, data }]
        }
        if (event.type === 'tool/result') {
          const call = calls.get(event.data.callId)
          const data = { rootCallId: event.data.callId, parentCallId: event.data.callId, subCallId: `${event.data.callId}:code:1`, name: call.data.name,
            arguments: call.data.arguments, isError: event.data.isError, content: [{ type: 'text', text: event.data.text }] }
          return [{ type: 'tool/code-dispatch', seq, time: event.time, data }, { ...event, seq: seq + 2,
            data: { turn: event.data.turn, step: event.data.step, callId: event.data.callId, isError: event.data.isError, textSha256: 'e'.repeat(64) } }]
        }
        return [{ ...event, seq }]
      })
    }
  }
  const phases = value.manifest.managed.phases
  const refs = [phases.creation.call, phases.profile.call, ...phases.members.calls, ...phases.review.submissions,
    ...phases.review.reviews, ...phases.restart.submissions, ...phases.restart.reviews]
  for (const ref of refs) {
    ref.callSeq = ref.callSeq * 3 + 1; ref.resultSeq *= 3
    ref.rootCallId = ref.callId; ref.parentCallId = ref.callId; ref.subCallId = `${ref.callId}:code:1`
    delete ref.callId
  }
  phases.creation.userMessageSeq *= 3
  for (const file of Object.values(value.files)) {
    if (file.managedOrigin !== undefined) file.managedOrigin = `managed:main:detached:${phases.creation.call.subCallId}`
  }
  return value
}

export async function testManagedP0Evidence(root, artifact) {
  const base = fixture(git('HEAD'), git('HEAD^{tree}'), artifact)
  async function install(value) {
    value.manifest.evidenceFiles = []
    for (const [relativePath, data] of Object.entries(value.files)) {
      const bytes = data instanceof Uint8Array ? data : Buffer.from(`${JSON.stringify(data)}\n`)
      await writeFile(join(root, relativePath), bytes)
      value.manifest.evidenceFiles.push({ relativePath, bytes: bytes.length, sha256: await sha256File(join(root, relativePath)) })
    }
    await writeFile(join(root, 'evidence/manifest.json'), `${JSON.stringify(value.manifest)}\n`)
    value.expected.manifestSha256 = await sha256File(join(root, 'evidence/manifest.json'))
  }
  await install(base)
  const positive = await verifyP0Evidence(root, base.manifest, base.expected)
  if (!positive.ok) throw new Error(`managed consumer positive fixture failed: ${positive.failures.join('; ')}`)
  const codeMode = asCodeMode(structuredClone(base))
  // A readback may follow concurrent usage/announcement writes. Tool-result
  // revision remains exact; later snapshot revision need not equal it.
  codeMode.files['evidence/managed-profile.json'].revision = 3
  await install(codeMode)
  const codePositive = await verifyP0Evidence(root, codeMode.manifest, codeMode.expected)
  if (!codePositive.ok) throw new Error(`actual typed PTC shape rejected: ${codePositive.failures.join('; ')}`)
  const cases = [
    ['wrong commit', value => { value.manifest.candidate.commit = 'c'.repeat(40) }],
    ['wrong tree', value => { value.manifest.candidate.tree = 'd'.repeat(40) }],
    ['wrong package expected', value => { value.expected.artifact.sha256 = 'f'.repeat(64) }],
    ['wrong package bytes', value => { value.expected.artifact.bytes++ }],
    ['wrong official expected', value => { value.expected.official.commit = 'c'.repeat(40) }],
    ['changed official after', value => { value.manifest.official.treeAfter = 'd'.repeat(40) }],
    ['fixture provenance', value => { value.manifest.provenance = 'test-fixture' }],
    ['missing expected managed kind', value => { delete value.expected.proofKind }],
    ['six empty assertions', value => { value.manifest.managed.phases = Object.fromEntries(['creation', 'profile', 'members', 'review', 'ui', 'restart'].map(name => [name, {}])) }],
    ['missing phase', value => { delete value.manifest.managed.phases.restart }],
    ['same Captain as Main', value => { value.manifest.managed.captainSessionId = 'main' }],
    ['one member', value => { value.manifest.managed.memberSessionIds.pop() }],
    ['no model request', value => { value.files['evidence/managed-before.json'][0].events = value.files['evidence/managed-before.json'][0].events.filter(event => event.type !== 'request/header') }],
    ['fixture actual request route', value => { value.files['evidence/managed-before.json'][0].events.find(event => event.type === 'request/header').data.header.config.provider = 'DEV_SMOKE' }],
    ['wrong call seq', value => { value.manifest.managed.phases.creation.call.callSeq = 999 }],
    ['wrong callId', value => { value.manifest.managed.phases.creation.call.callId = 'wrong' }],
    ['wrong turn', value => { value.manifest.managed.phases.creation.call.turn = 999 }],
    ['wrong result', value => { value.files['evidence/managed-before.json'][0].events.find(event => event.type === 'tool/result').data.text = 'Created something' }],
    ['no direct user request', value => { value.manifest.managed.phases.creation.userMessageSeq = 0 }],
    ['detached unmanaged origin', value => { value.files['evidence/managed-creation.json'].managedOrigin = 'managed:main:detached:unknown' }],
    ['fake profile readback', value => { value.files['evidence/managed-profile.json'].captainProfile.personality = 'wrong' }],
    ['missing avatar readback', value => { delete value.files['evidence/managed-profile.json'].captainProfile.pixelAvatarSvg }],
    ['failed recruited member', value => { value.files['evidence/managed-members.json'].members[0].phase = 'failed' }],
    ['missing second submission', value => { value.manifest.managed.phases.review.submissions.pop(); value.manifest.managed.phases.review.reviews.pop() }],
    ['stale attempt', value => { value.files['evidence/managed-review.json'].tasks[0].currentAttemptId = 'stale' }],
    ['task not completed', value => { value.files['evidence/managed-review.json'].tasks[0].status = 'submitted' }],
    ['attempt not accepted', value => { value.files['evidence/managed-review.json'].attempts[0].phase = 'submitted' }],
    ['UI not refreshed', value => { value.files['evidence/managed-ui.json'].afterRevision = 4 }],
    ['UI switched Team', value => { value.files['evidence/managed-ui.json'].teamId = 'other' }],
    ['UI wrong member count', value => { value.files['evidence/managed-ui.json'].members.pop() }],
    ['screenshot alone', value => { value.files['evidence/managed-ui.json'] = { screenshot: 'evidence/managed-ui.png' } }],
    ['no actual process restart', value => { value.manifest.managed.phases.restart.process.afterPid = 100 }],
    ['restart changed Team', value => { value.files['evidence/managed-restart.json'].id = 'new-team' }],
    ['restart changed reopened state', value => { value.files['evidence/managed-reopened.json'].revision++ }],
    ['restart changed Session header', value => { value.files['evidence/managed-after.json'][1].header.createdAt++ }],
    ['restart changed prefix', value => { value.files['evidence/managed-after.json'][0].events[0].time++ }],
    ['restart borrows old process request routes', value => {
      for (const session of value.files['evidence/managed-after.json']) {
        const old = value.files['evidence/managed-before.json'].find(entry => entry.header.id === session.header.id)
        session.events = session.events.filter(event => event.type !== 'request/header' || event.seq <= old.events.at(-1).seq)
      }
    }],
    ['restart header predates new process', value => {
      const session = value.files['evidence/managed-after.json'].find(entry => entry.header.id === 'member-a')
      session.events.filter(event => event.type === 'request/header').at(-1).time = value.manifest.managed.phases.restart.process.startedAt - 1
    }],
    ['restart old execution', value => { value.manifest.managed.phases.restart.submissions = [value.manifest.managed.phases.review.submissions[0]]; value.manifest.managed.phases.restart.reviews = [value.manifest.managed.phases.review.reviews[0]] }],
    ['forbidden raw request context', value => { value.files['evidence/managed-before.json'][0].events.push({ type: 'request/context', seq: 999, time: 9999, data: {} }) }],
    ['forbidden hidden reasoning', value => { value.files['evidence/managed-before.json'][0].events[0].data.reasoning = 'forbidden' }],
  ]
  for (const field of ['dshHome', 'provider', 'model', 'profileName']) {
    cases.push([`wrong profile ${field}`, value => { value.manifest.profile[field] = 'different' }])
    cases.push([`blank expected ${field}`, value => { value.expected.profile[field] = ' ' }])
    cases.push([`missing profile ${field}`, value => { delete value.manifest.profile[field] }])
  }
  // Change both pre/post projections so these cases reach their semantic check,
  // not merely the immutable restart prefix guard.
  for (const [name, mutate] of [
    ['same model members', sessions => { for (const session of sessions) for (const event of session.events) if (event.type === 'request/header') event.data.header.config.model = 'model-a' }],
    ['wrong member lineage', sessions => { sessions[2].header.parentSession = 'main' }],
    ['tool result failed', sessions => { sessions[2].events.find(event => event.type === 'tool/result').data.isError = true }],
    ['review stale revision', sessions => { sessions[1].events.find(event => event.type === 'tool/call' && event.data.name === 'agent_swarm_review_task').data.arguments.expected_revision = 99 }],
    ['review wrong attempt', sessions => { sessions[1].events.find(event => event.type === 'tool/call' && event.data.name === 'agent_swarm_review_task').data.arguments.attempt_id = 'stale' }],
    ['tool turn aborted', sessions => { sessions[2].events.find(event => event.type === 'turn/end').data.reason.kind = 'aborted' }],
  ]) cases.push([name, value => { mutate(value.files['evidence/managed-before.json']); mutate(value.files['evidence/managed-after.json']) }])
  for (const [label, mutate] of cases) {
    const value = structuredClone(base)
    mutate(value)
    await install(value)
    const result = await verifyP0Evidence(root, value.manifest, value.expected)
    if (result.ok) throw new Error(`managed negative unexpectedly passed: ${label}`)
  }
  const codeCases = [
    ['wrong subCallId', value => { value.manifest.managed.phases.creation.call.subCallId = 'wrong' }],
    ['wrong parentCallId', value => { value.manifest.managed.phases.creation.call.parentCallId = 'wrong' }],
    ['wrong rootCallId', value => { value.manifest.managed.phases.creation.call.rootCallId = 'wrong' }],
    ['wrong PTC turn', value => { value.manifest.managed.phases.creation.call.turn = 100 }],
    ['PTC fake turn managedOrigin', value => { for (const file of Object.values(value.files)) if (file.managedOrigin) file.managedOrigin = 'managed:main:turn:0' }],
    ['PTC restart borrows stopped Captain route', value => {
      const old = value.files['evidence/managed-before.json'].find(entry => entry.header.id === 'captain')
      const session = value.files['evidence/managed-after.json'].find(entry => entry.header.id === 'captain')
      session.events = session.events.filter(event => event.type !== 'request/header' || event.seq <= old.events.at(-1).seq)
    }],
  ]
  for (const [label, mutate] of [
    ['PTC result missing', sessions => { sessions[0].events = sessions[0].events.filter(event => event.type !== 'tool/code-dispatch') }],
    ['PTC body failed', sessions => { sessions[0].events.find(event => event.type === 'tool/code-dispatch').data.isError = true }],
    ['PTC arguments changed', sessions => { sessions[0].events.find(event => event.type === 'tool/code-dispatch').data.arguments = { name: 'changed' } }],
    ['PTC parent failed', sessions => { sessions[0].events.find(event => event.type === 'tool/result').data.isError = true }],
    ['PTC orphan parent', sessions => { sessions[0].events = sessions[0].events.filter(event => event.type !== 'tool/call') }],
    ['PTC outside parent', sessions => { sessions[0].events.find(event => event.type === 'tool/call').data.callId = 'other' }],
  ]) codeCases.push([label, value => { mutate(value.files['evidence/managed-before.json']); mutate(value.files['evidence/managed-after.json']) }])
  for (const [label, mutate] of codeCases) {
    const value = structuredClone(codeMode)
    mutate(value)
    await install(value)
    if ((await verifyP0Evidence(root, value.manifest, value.expected)).ok) throw new Error(`PTC negative unexpectedly passed: ${label}`)
  }
  await install(base)
  await writeFile(join(root, 'evidence/managed-ui.json'), '{}')
  if ((await verifyP0Evidence(root, base.manifest, base.expected)).ok) throw new Error('unresealed evidence tamper passed')
  await install(base)
  await writeFile(join(root, 'evidence/manifest.json'), '{}')
  if ((await verifyP0Evidence(root, base.manifest, base.expected)).ok) throw new Error('unresealed manifest tamper passed')
  await install(base)
  const expectedPath = join(root, 'controller-expected.json')
  await writeFile(expectedPath, JSON.stringify(base.expected))
  const expectedDigest = await sha256File(expectedPath)
  const cleanEnv = { ...process.env }
  for (const name of ['P0_PROOF_ROOT', 'P0_EXPECTED', 'P0_EXPECTED_SHA256']) delete cleanEnv[name]
  const run = args => spawnSync(process.execPath, ['scripts/verify-p0-profile-proof.mjs', '--candidate', ...args], { env: cleanEnv, encoding: 'utf8', timeout: 30_000, windowsHide: true })
  const configured = ['--root', root, '--expected', expectedPath, '--expected-sha256', expectedDigest]
  const cliPositive = run(configured)
  if (cliPositive.status !== 0 || !cliPositive.stdout.includes('PASS')) throw new Error(`configured CLI positive failed: ${cliPositive.stderr}`)
  const cliCases = [
    ['--root', root], ['--root', ' '], ['--expected', expectedPath], ['--expected-sha256', expectedDigest],
    ['--root', join(root, 'missing'), '--expected', expectedPath, '--expected-sha256', expectedDigest],
    ['--root', root, '--expected', join(root, 'missing.json'), '--expected-sha256', expectedDigest],
    ['--root', root, '--expected', expectedPath, '--expected-sha256', '0'.repeat(64)],
  ]
  for (const args of cliCases) {
    const result = run(args)
    if (result.status !== 1 || result.stdout.includes('NOT_CONFIGURED')) throw new Error('configured invalid CLI input skipped or passed')
  }
  await writeFile(expectedPath, '{broken')
  const badJson = run(['--root', root, '--expected', expectedPath, '--expected-sha256', await sha256File(expectedPath)])
  if (badJson.status !== 1) throw new Error('bad controller JSON passed')
  await writeFile(expectedPath, JSON.stringify({ ...base.expected, candidateCommit: 'a'.repeat(40) }))
  const stale = run(['--root', root, '--expected', expectedPath, '--expected-sha256', await sha256File(expectedPath)])
  if (stale.status !== 1 || !stale.stderr.includes('actual checkout')) throw new Error('receipt for another checkout passed')
  console.log(`Managed P0 consumer fixtures only: native/PTC positives + ${cases.length + codeCases.length + 2} negative cases; CLI 1 configured positive + ${cliCases.length + 2} failures: PASS (not live product evidence)`)
}
