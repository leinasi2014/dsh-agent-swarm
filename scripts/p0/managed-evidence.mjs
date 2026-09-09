import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

// This is a consumer of controller-attested, allowlisted canonical readbacks.
// It cannot establish provenance from candidate-authored JSON or screenshots.
const PHASES = ['creation', 'profile', 'members', 'review', 'ui', 'restart']
const PROFILE = ['dshHome', 'provider', 'model', 'profileName']
const IDENTITY = ['displayName', 'profession', 'personality', 'biography', 'pixelAvatarSvg']
const TOOLS = {
  run_code: [],
  agent_swarm_create_managed: ['name', 'stage'],
  agent_swarm_set_captain_profile: ['expected_revision', 'display_name', 'profession', 'personality', 'biography', 'pixel_avatar', 'pixel_avatar_svg'],
  agent_swarm_add_member: ['name', 'provider', 'llm_provider', 'model'],
  agent_swarm_submit_task: ['task_id', 'expected_revision', 'attempt_id'],
  agent_swarm_review_task: ['task_id', 'expected_revision', 'attempt_id', 'decision'],
}
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const integer = value => Number.isSafeInteger(value) && value >= 0
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function keys(value, allowed, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert(Object.keys(value).every(key => allowed.includes(key)), `${label} contains non-allowlisted fields`)
}

function exactProfile(actual, expected) {
  keys(actual, PROFILE, 'profile')
  keys(expected, PROFILE, 'expected.profile')
  for (const key of PROFILE) {
    assert(nonempty(expected[key]) && nonempty(actual[key]), `profile.${key} must be nonblank`)
    assert(actual[key] === expected[key], `profile.${key} differs from controller identity`)
  }
  assert(isAbsolute(actual.dshHome), 'profile.dshHome must be absolute')
}

async function evidenceReader(root, records) {
  assert(Array.isArray(records) && records.length > 0, 'managed evidenceFiles must be nonempty')
  const base = await realpath(root)
  const files = new Map()
  for (const record of records) {
    keys(record, ['relativePath', 'sha256', 'bytes'], 'evidence file')
    const path = record.relativePath
    assert(nonempty(path) && path.startsWith('evidence/') && !isAbsolute(path)
      && !path.split(/[\\/]/u).includes('..') && !files.has(path), 'evidence path invalid or duplicated')
    const actual = await realpath(resolve(root, path))
    const rel = relative(base, actual)
    assert(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), 'evidence symlink escapes proof root')
    assert((await stat(actual)).isFile(), 'evidence must be a regular file')
    const bytes = await readFile(actual)
    assert(integer(record.bytes) && bytes.length === record.bytes, `evidence byte mismatch: ${path}`)
    assert(digest(record.sha256) && sha(bytes) === record.sha256, `evidence digest mismatch: ${path}`)
    files.set(path, bytes)
  }
  const consumed = new Set()
  return {
    read(path, json = true) {
      assert(files.has(path), `required managed evidence not declared: ${String(path)}`)
      consumed.add(path)
      const bytes = files.get(path)
      return json ? JSON.parse(bytes.toString('utf8')) : bytes
    },
    finish() { assert(consumed.size === files.size, 'unconsumed evidence is not part of the managed proof allowlist') },
  }
}

// Compare rendered pixels with the authored grid. This does not duplicate
// the product compiler's horizontal/vertical rectangle merging algorithm.
function avatarMatches(args, svg) {
  if (args.pixel_avatar === undefined) return nonempty(args.pixel_avatar_svg) && args.pixel_avatar_svg.trim() === svg
  assert(args.pixel_avatar_svg === undefined, 'avatar grid and legacy SVG are mutually exclusive')
  const grid = args.pixel_avatar
  keys(grid, ['palette', 'rows'], 'avatar grid')
  assert(Array.isArray(grid.palette) && grid.palette.length > 0 && grid.palette.length <= 16
    && grid.palette.every(color => typeof color === 'string' && /^#[0-9a-f]{6}$/iu.test(color)), 'avatar palette invalid')
  assert(Array.isArray(grid.rows) && grid.rows.length === 32
    && grid.rows.every(row => typeof row === 'string' && /^[.0-9a-f]{32}$/iu.test(row)), 'avatar rows invalid')
  const wanted = grid.rows.flatMap(row => [...row].map(pixel => {
    if (pixel === '.') return null
    const color = grid.palette[Number.parseInt(pixel, 16)]
    assert(color !== undefined, 'avatar pixel uses missing palette entry')
    return color.toLowerCase()
  }))
  const body = /^<svg viewBox="0 0 32 32">(.*)<\/svg>$/u.exec(svg)?.[1]
  assert(body !== undefined, 'compiled grid needs canonical 32x32 SVG')
  const rectPattern = /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="(#[0-9a-f]{6})"\/>/gu
  const rects = [...body.matchAll(rectPattern)]
  assert(rects.length > 0 && rects.length <= 256 && body.replace(rectPattern, '') === '', 'compiled grid contains unsupported SVG')
  const actual = Array(1024).fill(null)
  for (const [, left, top, width, height, color] of rects) {
    const x = Number(left), y = Number(top), w = Number(width), h = Number(height)
    assert(w > 0 && h > 0 && x + w <= 32 && y + h <= 32, 'compiled avatar rect outside grid')
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      assert(actual[row * 32 + col] === null, 'compiled avatar rects overlap')
      actual[row * 32 + col] = color
    }
  }
  return isDeepStrictEqual(actual, wanted)
}

function screenshotDimensions(bytes, path) {
  const png = bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (png) {
    assert(/\.png$/iu.test(path) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR', 'PNG extension/header invalid')
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
    assert(width > 0 && height > 0, 'PNG dimensions invalid')
    return { width, height }
  }
  assert(/\.jpe?g$/iu.test(path) && bytes.length > 4 && bytes.readUInt16BE(0) === 0xffd8
    && bytes.readUInt16BE(bytes.length - 2) === 0xffd9, 'UI screenshot must be actual PNG or JPEG with matching extension')
  let offset = 2
  while (offset + 4 <= bytes.length) {
    assert(bytes[offset++] === 0xff, 'JPEG marker invalid')
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    assert(marker !== 0xda && marker !== 0xd9, 'JPEG has no frame dimensions')
    const length = bytes.readUInt16BE(offset)
    assert(length >= 2 && offset + length <= bytes.length, 'JPEG segment invalid')
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      assert(length >= 8, 'JPEG frame truncated')
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5)
      assert(width > 0 && height > 0, 'JPEG dimensions invalid')
      return { width, height }
    }
    offset += length
  }
  throw new Error('JPEG has no frame dimensions')
}

function checkSession(session) {
  keys(session, ['header', 'events'], 'Session projection')
  keys(session.header, ['version', 'id', 'createdAt', 'parentSession', 'origin', 'isSeeded', 'delegationDepth', 'agentPreset'], 'Session header')
  assert(session.header.version === 0 && typeof session.header.isSeeded === 'boolean' && nonempty(session.header.id) && integer(session.header.createdAt), 'invalid official Session header')
  assert(Array.isArray(session.events) && session.events.length > 0, 'Session events missing')
  let previous = -1
  for (const event of session.events) {
    keys(event, ['type', 'seq', 'time', 'data'], 'Session event')
    assert(integer(event.seq) && event.seq > previous && integer(event.time), 'Session seq/time invalid')
    previous = event.seq
    const data = event.data
    switch (event.type) {
      case 'user/message':
        keys(data, ['source', 'contentSha256'], 'user message projection')
        keys(data.source, ['kind', 'form', 'senderSessionId'], 'user source')
        assert(digest(data.contentSha256), 'user message content digest missing')
        if (data.source.kind === 'user') {
          assert(data.source.form === undefined && data.source.senderSessionId === undefined, 'direct user source must not claim an Agent sender')
        } else {
          const form = { 'agent-message': 'relay', 'subagent-settled': 'notice' }[data.source.kind]
          assert(form !== undefined && data.source.form === form && nonempty(data.source.senderSessionId), 'Agent message source attribution invalid')
        }
        break
      case 'request/header':
        keys(data, ['header'], 'request header projection')
        keys(data.header, ['config'], 'request header')
        keys(data.header.config, ['provider', 'model', 'reasoningEffort'], 'request route')
        if (data.header.config.reasoningEffort !== undefined) assert(nonempty(data.header.config.reasoningEffort), 'actual reasoning effort must be nonblank')
        assert(nonempty(data.header.config.provider) && nonempty(data.header.config.model), 'actual request route missing')
        assert(!/dev_smoke|fixture|mock/iu.test(`${data.header.config.provider}/${data.header.config.model}`), 'fixture route is not live model evidence')
        break
      case 'turn/start':
      case 'turn/end':
        keys(data, event.type === 'turn/start' ? ['turn'] : ['turn', 'reason'], 'turn boundary')
        assert(integer(data.turn), 'invalid turn number')
        if (event.type === 'turn/end') {
          keys(data.reason, ['kind'], 'turn end reason projection')
          assert(nonempty(data.reason.kind), 'turn end reason missing')
        }
        break
      case 'tool/call':
        keys(data, ['turn', 'step', 'callId', 'name', 'arguments'], 'tool call projection')
        assert(Object.hasOwn(TOOLS, data.name), 'tool outside managed acceptance allowlist')
        keys(data.arguments, TOOLS[data.name], 'projected tool arguments')
        assert(integer(data.turn) && integer(data.step) && nonempty(data.callId), 'tool call correlation missing')
        break
      case 'tool/result':
        keys(data, ['turn', 'step', 'callId', 'isError', 'text', 'textSha256'], 'tool result projection')
        assert(integer(data.turn) && integer(data.step) && nonempty(data.callId)
          && typeof data.isError === 'boolean' && (nonempty(data.text) || digest(data.textSha256)), 'tool result correlation missing')
        break
      case 'tool/code-dispatch-start':
      case 'tool/code-dispatch':
        keys(data, ['rootCallId', 'parentCallId', 'subCallId', 'name', 'arguments', ...(event.type === 'tool/code-dispatch' ? ['isError', 'content', 'contentSha256'] : [])], 'Code Mode dispatch')
        assert([data.rootCallId, data.parentCallId, data.subCallId].every(nonempty) && Object.hasOwn(TOOLS, data.name), 'Code Mode identity/tool missing')
        keys(data.arguments, TOOLS[data.name], 'Code Mode projected arguments')
        if (event.type === 'tool/code-dispatch') {
          assert(typeof data.isError === 'boolean', 'Code Mode outcome missing')
          if (data.name === 'run_code') {
            assert(digest(data.contentSha256) && data.content === undefined, 'nested run_code output must be digest-only')
            break
          }
          assert(data.contentSha256 === undefined && Array.isArray(data.content) && data.content.length > 0, 'Code Mode result missing')
          for (const block of data.content) {
            keys(block, ['type', 'text'], 'Code Mode result block')
            assert(block.type === 'text' && nonempty(block.text), 'only public tool result text may be exported')
          }
        }
        break
      default: throw new Error(`non-allowlisted Session event: ${String(event.type)}`)
    }
  }
}

function sessionMap(value, ids) {
  assert(Array.isArray(value) && value.length === ids.length, 'exact managed Session set required')
  const sessions = new Map()
  for (const session of value) {
    checkSession(session)
    assert(ids.includes(session.header.id) && !sessions.has(session.header.id), 'wrong or duplicate Session identity')
    sessions.set(session.header.id, session)
  }
  for (const session of sessions.values()) for (const event of session.events) {
    if (event.type !== 'user/message' || event.data.source.kind === 'user') continue
    const sender = sessions.get(event.data.source.senderSessionId)
    assert(sender !== undefined && sender.header.id !== session.header.id, 'Agent message sender is outside the managed Session set')
    assert(sender.header.parentSession === session.header.id
      || (event.data.source.kind === 'agent-message' && session.header.parentSession === sender.header.id), 'Agent message source contradicts canonical parent lineage')
  }
  return sessions
}

function toolPair(sessions, ref, name, owner) {
  keys(ref, ['sessionId', 'callSeq', 'resultSeq', 'turn', 'callId', 'rootCallId', 'parentCallId', 'subCallId'], 'tool evidence reference')
  assert(ref.sessionId === owner && integer(ref.callSeq) && integer(ref.resultSeq), 'tool evidence owner/seq mismatch')
  const events = sessions.get(owner)?.events
  assert(events !== undefined, 'referenced Session missing')
  const call = events.find(event => event.seq === ref.callSeq)
  const result = events.find(event => event.seq === ref.resultSeq)
  if (call?.type === 'tool/code-dispatch-start') return codePair(sessions, events, ref, name, owner, call, result)
  assert(call?.type === 'tool/call' && call.data.name === name && result?.type === 'tool/result', 'referenced tool pair missing')
  assert(call.seq < result.seq && call.data.callId === ref.callId && call.data.turn === ref.turn
    && result.data.callId === ref.callId && result.data.turn === ref.turn
    && result.data.step === call.data.step && result.data.isError === false, 'tool pair correlation/success mismatch')
  assert(events.filter(event => event.type === 'tool/call' && event.data.callId === ref.callId).length === 1
    && events.filter(event => event.type === 'tool/result' && event.data.callId === ref.callId).length === 1, 'tool callId must be unique in Session')
  const start = events.find(event => event.type === 'turn/start' && event.data.turn === ref.turn && event.seq < call.seq)
  const end = events.find(event => event.type === 'turn/end' && event.data.turn === ref.turn && event.seq > result.seq)
  assert(start && end && end.data.reason.kind === 'completed', 'tool pair must belong to a completed real turn')
  const routeHeader = events.filter(event => event.type === 'request/header' && event.seq < call.seq).at(-1)
  assert(routeHeader !== undefined, 'tool call lacks actual request/header route')
  if (name === 'run_code') assert(digest(result.data.textSha256) && result.data.text === undefined, 'run_code parent output must be digest-only')
  return { args: call.data.arguments, text: result.data.text, call, result, route: routeHeader.data.header.config, routeHeader }
}

function codePair(sessions, events, ref, name, owner, call, result) {
  assert(call.data.name === name && result?.type === 'tool/code-dispatch' && result.data.isError === false
    && result.seq > call.seq, 'Code Mode dispatch outcome mismatch')
  for (const field of ['rootCallId', 'parentCallId', 'subCallId']) {
    assert(nonempty(ref[field]) && call.data[field] === ref[field] && result.data[field] === ref[field], 'Code Mode correlation mismatch')
  }
  assert(result.data.name === name && isDeepStrictEqual(call.data.arguments, result.data.arguments), 'Code Mode start/result payload mismatch')
  assert(events.filter(event => event.type === 'tool/code-dispatch-start' && event.data.subCallId === ref.subCallId).length === 1
    && events.filter(event => event.type === 'tool/code-dispatch' && event.data.subCallId === ref.subCallId).length === 1, 'Code Mode subCallId must pair uniquely')
  const rootCall = events.find(event => event.type === 'tool/call' && event.data.callId === ref.rootCallId)
  const rootResult = events.find(event => event.type === 'tool/result' && event.data.callId === ref.rootCallId)
  assert(rootCall && rootResult && rootCall.seq < call.seq && result.seq < rootResult.seq, 'Code Mode dispatch must be enclosed by actual run_code')
  const root = toolPair(sessions, { sessionId: owner, callSeq: rootCall.seq, resultSeq: rootResult.seq,
    callId: ref.rootCallId, turn: ref.turn }, 'run_code', owner)
  let parent = ref.parentCallId, childStart = call.seq, childEnd = result.seq
  const seen = new Set([ref.subCallId])
  while (parent !== ref.rootCallId) {
    assert(!seen.has(parent), 'Code Mode parent cycle')
    seen.add(parent)
    const start = events.find(event => event.type === 'tool/code-dispatch-start' && event.data.subCallId === parent)
    const end = events.find(event => event.type === 'tool/code-dispatch' && event.data.subCallId === parent)
    assert(start && end && start.data.name === 'run_code' && end.data.name === 'run_code' && end.data.isError === false
      && start.data.rootCallId === ref.rootCallId && end.data.rootCallId === ref.rootCallId
      && start.data.parentCallId === end.data.parentCallId && start.seq < childStart && childEnd < end.seq, 'Code Mode nested parent lineage mismatch')
    parent = start.data.parentCallId
    childStart = start.seq; childEnd = end.seq
  }
  return { args: call.data.arguments, text: result.data.content.map(block => block.text).join('\n'), call, result,
    route: root.route, routeHeader: root.routeHeader, managedOrigin: `managed:${owner}:detached:${ref.subCallId}` }
}

function checkTeam(team) {
  keys(team, ['schemaVersion', 'id', 'revision', 'name', 'captainSessionId', 'managedOrigin', 'phase', 'captainProfile', 'members', 'tasks', 'attempts'], 'Team projection')
  assert(team.schemaVersion === 2 && nonempty(team.id) && integer(team.revision) && team.phase === 'active'
    && nonempty(team.name) && nonempty(team.managedOrigin), 'active managed Team identity missing')
  if (team.captainProfile !== undefined) keys(team.captainProfile, IDENTITY, 'Captain profile')
  assert(Array.isArray(team.members) && Array.isArray(team.tasks) && Array.isArray(team.attempts), 'Team canonical collections missing')
  for (const member of team.members) {
    keys(member, ['name', 'sessionId', 'provider', 'phase', ...IDENTITY], 'Team member')
    assert(nonempty(member.name) && nonempty(member.sessionId) && nonempty(member.provider), 'member identity missing')
  }
  for (const task of team.tasks) {
    keys(task, ['id', 'revision', 'status', 'ownerSessionId', 'currentAttemptId'], 'Team task')
    assert(nonempty(task.id) && integer(task.revision) && nonempty(task.status), 'task identity missing')
  }
  for (const attempt of team.attempts) {
    keys(attempt, ['id', 'taskId', 'generation', 'memberSessionId', 'phase'], 'Team attempt')
    assert(nonempty(attempt.id) && nonempty(attempt.taskId) && integer(attempt.generation)
      && nonempty(attempt.memberSessionId) && nonempty(attempt.phase), 'attempt identity missing')
  }
  for (const [rows, key] of [[team.members, 'sessionId'], [team.tasks, 'id'], [team.attempts, 'id']]) {
    assert(new Set(rows.map(row => row[key])).size === rows.length, 'duplicate canonical Team row identity')
  }
}

function checkReviews(sessions, phase, team, captain, members) {
  assert(Array.isArray(phase.submissions) && Array.isArray(phase.reviews)
    && phase.submissions.length >= 1 && phase.submissions.length === phase.reviews.length, 'submission/review evidence missing')
  const completed = []
  for (let index = 0; index < phase.submissions.length; index++) {
    const ref = phase.submissions[index]
    assert(members.includes(ref.sessionId), 'submission must originate from recruited member')
    const submit = toolPair(sessions, ref, 'agent_swarm_submit_task', ref.sessionId)
    const review = toolPair(sessions, phase.reviews[index], 'agent_swarm_review_task', captain)
    const task = team.tasks.find(value => value.id === submit.args.task_id)
    const attempt = team.attempts.find(value => value.id === submit.args.attempt_id)
    assert(task && attempt && task.currentAttemptId === attempt.id && attempt.taskId === task.id
      && task.ownerSessionId === ref.sessionId && attempt.memberSessionId === ref.sessionId
      && task.status === 'completed' && attempt.phase === 'accepted', 'review must complete exact current member attempt')
    assert(review.args.task_id === task.id && review.args.attempt_id === attempt.id && review.args.decision === 'accept'
      && integer(submit.args.expected_revision) && review.args.expected_revision === submit.args.expected_revision + 1
      && task.revision === review.args.expected_revision + 1, 'submit/review exact revision fence mismatch')
    assert(submit.text === `Submitted ${task.id} at revision ${submit.args.expected_revision + 1}; captain review is required.`
      && review.text === `Review accept: ${task.id} is now completed at revision ${task.revision}.`, 'tool result contradicts canonical task review')
    assert(submit.result.time <= review.call.time, 'review precedes submitted outcome')
    completed.push({ task, attempt, member: ref.sessionId, route: submit.route, submit, review })
  }
  assert(new Set(completed.map(value => value.attempt.id)).size === completed.length, 'duplicate accepted attempt evidence')
  return completed
}

export async function verifyManagedEvidence(root, manifest, expected, failures) {
  try {
    assert(expected.requireManaged === true, 'managed proof needs explicit controller acceptance mode')
    assert(expected.proofKind === 'managed-team', 'controller managed proof identity missing')
    assert(digest(expected.manifestSha256), 'controller manifest digest missing')
    const manifestBytes = await readFile(resolve(root, 'evidence/manifest.json'))
    assert(sha(manifestBytes) === expected.manifestSha256, 'manifest differs from controller digest')
    assert(isDeepStrictEqual(JSON.parse(manifestBytes.toString('utf8')), manifest), 'supplied manifest differs from pinned file')
    assert(digest(expected.artifact?.sha256) && integer(expected.artifact?.bytes) && expected.artifact.bytes > 0
      && manifest.artifact.sha256 === expected.artifact.sha256 && manifest.artifact.bytes === expected.artifact.bytes,
    'artifact differs from controller package identity')
    const artifactPath = await realpath(resolve(root, manifest.artifact.relativePath))
    const artifactRel = relative(await realpath(root), artifactPath)
    assert(artifactRel !== '' && !artifactRel.startsWith('..') && !isAbsolute(artifactRel), 'artifact symlink escapes proof root')
    for (const key of ['commit', 'tree', 'version']) {
      assert(nonempty(expected.official?.[key]), `controller official.${key} missing`)
      const actual = manifest.official[key === 'version' ? key : `${key}Before`]
      assert(actual === expected.official[key], `official.${key} differs from controller identity`)
    }
    exactProfile(manifest.profile, expected.profile)
    assert(manifest.provenance === 'controller-observed-live', 'fixtures are not live proof provenance')
    const reader = await evidenceReader(root, manifest.evidenceFiles)
    const managed = manifest.managed
    keys(managed, ['mainSessionId', 'captainSessionId', 'memberSessionIds', 'sessionsBefore', 'sessionsAfter', 'phases'], 'managed proof')
    assert(nonempty(managed.mainSessionId) && nonempty(managed.captainSessionId)
      && Array.isArray(managed.memberSessionIds) && managed.memberSessionIds.length >= 2
      && managed.memberSessionIds.every(nonempty), 'Main Brain/Captain/two members required')
    const ids = [managed.mainSessionId, managed.captainSessionId, ...managed.memberSessionIds]
    assert(new Set(ids).size === ids.length, 'managed Sessions must be distinct')
    const before = sessionMap(reader.read(managed.sessionsBefore), ids)
    const after = sessionMap(reader.read(managed.sessionsAfter), ids)
    assert(before.get(ids[0]).header.parentSession === undefined, 'Main Brain must be top level')
    assert(before.get(ids[1]).header.parentSession === ids[0], 'dedicated Captain parent lineage mismatch')
    for (const id of ids.slice(2)) assert(before.get(id).header.parentSession === ids[1], 'member Captain lineage mismatch')
    for (const id of ids) {
      const old = before.get(id), current = after.get(id)
      assert(isDeepStrictEqual(old.header, current.header)
        && isDeepStrictEqual(old.events, current.events.slice(0, old.events.length)), 'restart must preserve exact Session identity and projected prefix')
    }
    keys(managed.phases, PHASES, 'managed phases')
    assert(PHASES.every(name => Object.hasOwn(managed.phases, name)), 'all six managed phases required')
    assert(new Set(PHASES.map(name => managed.phases[name]?.team)).size === PHASES.length, 'each phase needs its own canonical Team readback')
    const teams = {}
    for (const name of PHASES) {
      const phase = managed.phases[name]
      const allowed = { creation: ['team', 'call', 'userMessageSeq'], profile: ['team', 'call'], members: ['team', 'calls'],
        review: ['team', 'submissions', 'reviews'], ui: ['team', 'observation'],
        restart: ['team', 'reopenedTeam', 'submissions', 'reviews', 'process'] }[name]
      keys(phase, allowed, `${name} phase`)
      const team = reader.read(phase.team)
      checkTeam(team)
      assert(team.captainSessionId === managed.captainSessionId, 'phase Captain identity changed')
      teams[name] = team
    }
    const { creation, profile, members, review, ui, restart } = managed.phases
    const main = toolPair(before, creation.call, 'agent_swarm_create_managed', ids[0])
    const created = teams.creation
    assert(main.args.stage !== true && main.args.name === created.name, 'creation must start managed dedicated Captain')
    assert(created.managedOrigin === (main.managedOrigin ?? `managed:${ids[0]}:turn:${creation.call.turn}`), 'managed operation is not bound to exact Main Brain call')
    assert(main.text.startsWith(`Created managed Team "${created.name}" (${created.id}) with dedicated Captain ${ids[1]}.`), 'creation result does not bind Team/Captain')
    const user = before.get(ids[0]).events.find(event => event.seq === creation.userMessageSeq)
    assert(user?.type === 'user/message' && user.data.source.kind === 'user' && user.seq < main.call.seq, 'model-visible Main Brain user request missing')
    assert(main.route.provider === manifest.profile.provider && main.route.model === manifest.profile.model, 'Main Brain request differs from Profile route')
    let previousRevision = created.revision
    for (const name of PHASES) {
      const team = teams[name]
      assert(team.id === created.id && team.managedOrigin === created.managedOrigin, 'six phases must preserve one managed Team identity')
      assert(team.revision >= previousRevision, 'phase Team revisions regressed')
      previousRevision = team.revision
    }
    const profileCall = toolPair(before, profile.call, 'agent_swarm_set_captain_profile', ids[1])
    const profileTeam = teams.profile
    assert(integer(profileCall.args.expected_revision) && profileTeam.revision >= profileCall.args.expected_revision + 1
      && profileCall.text === `Set Team profile (revision ${profileCall.args.expected_revision + 1}).`, 'Captain profile revision/result mismatch')
    for (const [field, arg] of [['displayName', 'display_name'], ['profession', 'profession'], ['personality', 'personality'], ['biography', 'biography']]) {
      assert(nonempty(profileTeam.captainProfile?.[field]) && typeof profileCall.args[arg] === 'string' && profileCall.args[arg].trim() === profileTeam.captainProfile[field], 'Captain profile must be read back from exact update')
    }
    assert(avatarMatches(profileCall.args, profileTeam.captainProfile.pixelAvatarSvg), 'Captain avatar pixels differ from exact profile update')
    assert(Array.isArray(members.calls) && members.calls.length === ids.length - 2, 'recruitment calls must cover actual member set')
    const recruited = teams.members.members
    assert(recruited.length === ids.length - 2 && recruited.every(member => ids.slice(2).includes(member.sessionId) && member.phase === 'active'), 'recruited member set is not active')
    for (const id of ids.slice(2)) {
      const member = recruited.find(value => value.sessionId === id)
      const pair = members.calls.map(ref => toolPair(before, ref, 'agent_swarm_add_member', ids[1])).find(value => value.args.name === member.name)
      assert(pair && pair.text === `Member ${member.name} (${id}) is active via ${member.provider}.`, 'recruitment lacks exact successful Session result')
    }
    const completed = checkReviews(before, review, teams.review, ids[1], ids.slice(2))
    assert(ids.slice(2).every(id => completed.some(value => value.member === id)), 'each heterogeneous member must actually execute and submit')
    assert(new Set(completed.map(value => value.route.model)).size >= 2, 'members did not execute heterogeneous models')
    for (const name of ['review', 'ui', 'restart']) {
      assert(isDeepStrictEqual(teams[name].members, recruited)
        && isDeepStrictEqual(teams[name].captainProfile, profileTeam.captainProfile), 'member/Captain identities changed across acceptance phases')
    }
    const observation = reader.read(ui.observation)
    keys(observation, ['source', 'teamId', 'beforeRevision', 'afterRevision', 'captainProfile', 'members', 'tasks', 'screenshot', 'width', 'height'], 'UI readback')
    assert(observation.source === 'in-app-browser' && observation.teamId === created.id
      && observation.beforeRevision === teams.members.revision && observation.afterRevision === teams.ui.revision
      && observation.afterRevision > observation.beforeRevision, 'UI must refresh same Team after canonical change')
    const visibleCaptain = { displayName: teams.ui.captainProfile.displayName, profession: teams.ui.captainProfile.profession }
    const visibleMembers = teams.ui.members.map(member => {
      const route = completed.find(value => value.member === member.sessionId).route
      return { name: member.name, displayName: member.displayName ?? member.name, provider: route.provider, model: route.model }
    })
    const visibleTasks = teams.ui.tasks.map(task => ({ id: task.id, status: task.status }))
    assert(isDeepStrictEqual(observation.captainProfile, visibleCaptain)
      && isDeepStrictEqual(observation.members, visibleMembers)
      && isDeepStrictEqual(observation.tasks, visibleTasks), 'UI visible fields disagree with canonical Team/request routes')
    const screenshot = reader.read(observation.screenshot, false)
    const dimensions = screenshotDimensions(screenshot, observation.screenshot)
    assert(observation.width === dimensions.width && observation.height === dimensions.height, 'UI screenshot dimensions disagree with observation')
    const reopened = reader.read(restart.reopenedTeam)
    assert(isDeepStrictEqual(reopened, teams.ui), 'reopened Team must equal exact pre-restart canonical state')
    keys(restart.process, ['beforePid', 'afterPid', 'stoppedAt', 'startedAt'], 'restart process identity')
    assert(integer(restart.process.beforePid) && restart.process.beforePid > 0 && integer(restart.process.afterPid)
      && restart.process.afterPid > 0 && restart.process.beforePid !== restart.process.afterPid
      && integer(restart.process.stoppedAt) && integer(restart.process.startedAt)
      && restart.process.startedAt > restart.process.stoppedAt, 'real process restart boundary missing')
    for (const session of before.values()) assert(session.events.every(event => event.time <= restart.process.stoppedAt), 'pre-restart Session evidence extends beyond stopped process')
    const continued = checkReviews(after, restart, teams.restart, ids[1], ids.slice(2))
    for (const value of continued) {
      assert(!teams.ui.attempts.some(attempt => attempt.id === value.attempt.id), 'restart reused old accepted attempt')
      for (const [id, pair] of [[value.member, value.submit], [ids[1], value.review]]) {
        assert(pair.call.seq > before.get(id).events.at(-1).seq && pair.call.time >= restart.process.startedAt, 'restart evidence must be newly executed after process restart')
        // A resumed Agent emits a lifecycle header once; later turns may reuse
        // it. They may not borrow the stopped process's last request route.
        assert(pair.routeHeader.seq > before.get(id).events.at(-1).seq
          && pair.routeHeader.time >= restart.process.startedAt, 'restart request route must originate in the new process lifecycle')
      }
    }
    reader.finish()
  } catch (error) {
    failures.push(`managed proof: ${error.message}`)
  }
}
