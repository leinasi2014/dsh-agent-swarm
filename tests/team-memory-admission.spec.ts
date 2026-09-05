import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_TEAM_LIMITS, TeamDomain } from '../src/domain/team-domain.js'
import { FaultableBackend, openFaultableStack, openStorageStack, unitFilePath, type StorageStack } from './helpers/storage-stack.js'

const scope = 'memory-admission-workspace'
const captain = 'memory-captain'
let root: string
let stack: StorageStack
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-admission-'))
  stack = await openStorageStack(root)
})
afterEach(async () => { await stack.close(); await rm(root, { recursive: true, force: true }) })

const examples = [
  ['API key: synthetic-key-17', 'API key: [REDACTED]'],
  ['api_key="synthetic key 17"; safe', 'api_key="[REDACTED]"; safe'],
  [String.raw`password="synthetic\"quoted-tail"; safe`, 'password="[REDACTED]"; safe'],
  ['access token is synthetic-access', 'access token is [REDACTED]'],
  ['refresh_token = `synthetic-refresh`', 'refresh_token = `[REDACTED]`'],
  ['password: synthetic-password\npasswd=synthetic-passwd\npwd is synthetic-pwd', 'password: [REDACTED]\npasswd=[REDACTED]\npwd is [REDACTED]'],
  ['secret: synthetic-secret; key=synthetic-key', 'secret: [REDACTED]; key=[REDACTED]'],
  ['Authorization: Bearer synthetic-bearer-17', 'Authorization: Bearer [REDACTED]'],
  ['Authorization: "Bearer synthetic-bearer-17"', 'Authorization: "Bearer [REDACTED]"'],
  ['API密钥：合成密钥；访问令牌是合成访问；刷新令牌为合成刷新', 'API密钥：[REDACTED]；访问令牌是[REDACTED]；刷新令牌为[REDACTED]'],
  ['密码为“合成密码”；口令是\'合成口令\'；密钥=合成密钥；令牌：合成令牌', '密码为“[REDACTED]”；口令是\'[REDACTED]\'；密钥=[REDACTED]；令牌：[REDACTED]'],
  ['| **API key** | `synthetic-table-key` | keep |\n| 密码 | 合成表密码 | 保留 |', '| **API key** | `[REDACTED]` | keep |\n| 密码 | [REDACTED] | 保留 |'],
  ['Contact synthetic.person+17@example.test, keep this.', 'Contact [REDACTED], keep this.'],
  ['手机 13800138000；备用 +86 13900139000', '手机 [REDACTED]；备用 [REDACTED]'],
  ['phone: +1 (202) 555-0177; 电话：010-55550177', 'phone: [REDACTED]; 电话：[REDACTED]'],
  ['telephone: (202) 555-0177; keep', 'telephone: [REDACTED]; keep'],
  ['identity number: SYNTHETIC-ID-17; 身份证号：110101199001010017', 'identity number: [REDACTED]; 身份证号：[REDACTED]'],
  ['身份证号：11010119900101001X', '身份证号：[REDACTED]'],
  ['identity number: 1234-SYNTHETIC-ID-TAIL', 'identity number: [REDACTED]'],
  ['card number: 1234ABCD', 'card number: [REDACTED]'],
  ['card number: 4111 1111 1111 1111', 'card number: [REDACTED]'],
  ['银行卡号：4111-1111-1111-1111；保留', '银行卡号：[REDACTED]；保留'],
  ['card number: 4111-1111-1111-1111ABCD', 'card number: [REDACTED]'],
  ['card number: 4111 1111 1111 1111ABCD', 'card number: [REDACTED]'],
  ['| 银行卡号 | 4111 1111 1111 1111 | safe |', '| 银行卡号 | [REDACTED] | safe |'],
  ['card number: 4111 1111 1111 1111&task=task-17', 'card number: [REDACTED]&task=task-17'],
  ['| card number | 4111-1111-1111-1111 | safe |', '| card number | [REDACTED] | safe |'],
  ['**password**: **synthetic-bold**; token=`synthetic-inline`', '**password**: **[REDACTED]**; token=`[REDACTED]`'],
  ['password: **synthetic secret phrase**', 'password: **[REDACTED]**'],
  ['Authorization: **Bearer synthetic-bearer**', 'Authorization: **Bearer [REDACTED]**'],
  ['password: **"synthetic quoted tail"**', 'password: **"[REDACTED]"**'],
  ['密码：*synthetic italic phrase*；保留', '密码：*[REDACTED]*；保留'],
  ['https://example.test/evidence?api_key=synthetic-query&task=task-17#anchor', 'https://example.test/evidence?api_key=[REDACTED]&task=task-17#anchor'],
] as const

it.each(examples)('sanitizes direct admission in returned records, JSON and reopen: %s', async (input, expected) => {
  const team = await stack.port.createTeam(scope, captain, 'Admission', 'Synthetic values only')
  const entry = await stack.port.addMemory(scope, team.id, captain, 'context', input, [input])
  const persisted = await readFile(unitFilePath(root), 'utf8')
  await stack.close(); stack = await openStorageStack(root)
  const reopened = (await stack.port.snapshot(scope, team.id, captain)).team.memory[0]
  expect.soft(entry).toMatchObject({ content: expected, evidenceRefs: [expected] })
  expect.soft(reopened).toEqual(entry)
  expect(persisted).not.toContain(JSON.stringify(input).slice(1, -1))
})

it('sanitizes every reference even when content is safe, and is idempotent', async () => {
  const team = await stack.port.createTeam(scope, captain, 'References', 'All refs, not just the visible page')
  const refs = Array.from({ length: 35 }, (_, index) => `password=synthetic-ref-${index}`)
  const entry = await stack.port.addMemory(scope, team.id, captain, 'decision', 'Safe decision', refs)
  expect(entry.evidenceRefs).toEqual(refs.map(() => 'password=[REDACTED]'))
  const repeated = await stack.port.addMemory(scope, team.id, captain, 'decision', entry.content, entry.evidenceRefs)
  expect(repeated.content).toBe(entry.content)
  expect(repeated.evidenceRefs).toEqual(entry.evidenceRefs)
  expect(await readFile(unitFilePath(root), 'utf8')).not.toContain('synthetic-ref-')
})

it('preserves safe Markdown, identifiers, dates, names and existing placeholders exactly', async () => {
  const team = await stack.port.createTeam(scope, captain, 'Safe', 'Conservative scope')
  const content = '# Plan\nTask task-13800138000 at 2026-09-06; Alice, 北京路 17 号.\n| task_id | abc-17 |\nmonkey=banana; keyboard is ready'
  const refs = ['API key: ****', 'password=[REDACTED]', 'secret=<redacted>', 'token=redacted', 'pwd=masked', '密码：已脱敏']
  expect(await stack.port.addMemory(scope, team.id, captain, 'lesson', content, refs)).toMatchObject({ content, evidenceRefs: refs })
})

it('preserves authorization, archived and count rejection without changing ids or revisions', async () => {
  const team = await stack.port.createTeam(scope, captain, 'Limits', 'Atomic policy')
  const limited = new TeamDomain(stack.store, { ...DEFAULT_TEAM_LIMITS, maxMemories: 1 })
  const before = await limited.snapshot(scope, team.id, captain)
  await expect(limited.addMemory(scope, team.id, 'outsider', 'context', 'password=synthetic', [])).rejects.toMatchObject({ code: 'TEAM_UNAUTHORIZED' })
  expect(await limited.snapshot(scope, team.id, captain)).toEqual(before)
  await limited.addMemory(scope, team.id, captain, 'context', 'Safe entry', [])
  const full = await limited.snapshot(scope, team.id, captain)
  await expect(limited.addMemory(scope, team.id, captain, 'context', 'password=synthetic', [])).rejects.toMatchObject({ code: 'TEAM_MEMORY_LIMIT' })
  expect(await limited.snapshot(scope, team.id, captain)).toEqual(full)
  await limited.archiveTeam(scope, team.id, captain, 'Synthetic archive')
  const archived = await limited.snapshot(scope, team.id, captain)
  await expect(limited.addMemory(scope, team.id, captain, 'context', 'password=synthetic', [])).rejects.toMatchObject({ code: 'TEAM_ARCHIVED' })
  expect(await limited.snapshot(scope, team.id, captain)).toEqual(archived)
})

it.each(['content', 'reference'] as const)('enforces raw and transformed UTF-8 byte limits atomically for %s', async field => {
  const team = await stack.port.createTeam(scope, captain, 'Bytes', 'Before and after transformation')
  const max = field === 'content' ? 16_384 : 2_048
  const before = await stack.port.snapshot(scope, team.id, captain)
  for (const value of ['password=' + '界'.repeat(Math.ceil(max / 3)), ' '.repeat(max) + 'x', 'x'.repeat(max - 10) + '\npwd=a']) {
    await expect(stack.port.addMemory(scope, team.id, captain, 'context', field === 'content' ? value : 'safe', field === 'reference' ? [value] : []))
      .rejects.toMatchObject({ code: 'TEAM_INPUT_LIMIT', message: expect.not.stringContaining(value) })
    expect(await stack.port.snapshot(scope, team.id, captain)).toEqual(before)
  }
  const exact = '界'.repeat(Math.floor(max / 3)) + 'x'.repeat(max % 3)
  expect(await stack.port.addMemory(scope, team.id, captain, 'context', field === 'content' ? exact : 'safe', field === 'reference' ? [exact] : []))
    .toMatchObject(field === 'content' ? { content: exact } : { evidenceRefs: [exact] })
})

it('keeps a failed real Storage Domain transaction unchanged after reopen', async () => {
  await stack.close()
  const backend = new FaultableBackend()
  stack = await openFaultableStack(backend)
  const team = await stack.port.createTeam(scope, captain, 'Transaction', 'No partial append')
  const before = await stack.port.snapshot(scope, team.id, captain)
  backend.failNextWrites = 1
  await expect(stack.port.addMemory(scope, team.id, captain, 'context', 'password=synthetic-failed-write', []))
    .rejects.toThrow('injected write failure')
  await stack.close(); stack = await openFaultableStack(backend)
  expect(await stack.port.snapshot(scope, team.id, captain)).toEqual(before)
  const next = await stack.port.addMemory(scope, team.id, captain, 'context', 'password=synthetic-retry', [])
  expect(next).toMatchObject({ id: 'memory-1', content: 'password=[REDACTED]' })
})
