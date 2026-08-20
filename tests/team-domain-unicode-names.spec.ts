/**
 * M1C official-compat semantics (issue #19), domain half: Unicode member
 * names.
 *
 * The naming policy folds member names through NFC normalization plus the
 * `\p{L}\p{N}` whitelist (ref `dsh-agent-teams` `sanitizeKey` template), so
 * non-Latin names stay distinct and resolvable, while over-length and
 * letter-less names fail loud instead of being silently folded onto a shared
 * identity. Evidence runs over the same real official storage stack as the
 * protocol suite; the runtime halves (quiet delivery, interrupt, wait
 * contract) live in `official-compat-semantics.spec.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamDomain } from '../src/domain/team-domain.js'
import { openStorageStack, type StorageStack } from './helpers/storage-stack.js'

describe('Unicode member names over the official Storage Domain (issue #19)', () => {
  let sandbox: string
  let scope: string
  let tick: number
  let stack: StorageStack
  let domain: TeamDomain

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-unicode-'))
    scope = join(sandbox, 'workspace')
    tick = 1_000
    stack = await openStorageStack(join(sandbox, 'storage'), () => tick++)
    domain = stack.port as TeamDomain
  })

  afterEach(async () => {
    await stack.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('admits distinct CJK and Cyrillic member names and resolves mail targets by them', async () => {
    const team = await domain.createTeam(scope, 'captain-session', 'Unicode team', 'Non-Latin names stay distinct')
    const chinese = await domain.provisionMember(scope, team.id, 'captain-session', {
      name: '小明', role: '中文实现成员', sessionId: 'member-cjk', provider: 'spawn',
    })
    expect(chinese).toMatchObject({ name: '小明', phase: 'provisioning' })
    const cyrillic = await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'Иван', role: 'кириллический участник', sessionId: 'member-cyr', provider: 'spawn',
    })
    // Cyrillic case-folds like every other script (ref `sanitizeKey` parity);
    // the identity stays distinct from the CJK row.
    expect(cyrillic).toMatchObject({ name: 'иван', phase: 'provisioning' })
    await domain.settleMember(scope, team.id, 'member-cjk', { active: true })
    await domain.settleMember(scope, team.id, 'member-cyr', { active: true })

    // Mail targets resolve by the Unicode names, to the exact member rows.
    const toChinese = await domain.queueMessage(scope, team.id, 'captain-session', '小明', '你好', 'wakeup')
    expect(toChinese.targetSessionId).toBe('member-cjk')
    const toCyrillic = await domain.queueMessage(scope, team.id, 'captain-session', 'ИВАН', 'привет', 'wakeup')
    expect(toCyrillic.targetSessionId).toBe('member-cyr')

    // Removal resolves by the same names, and the retired identity stays
    // occupied exactly like a Latin one (F12 lifetime rule).
    await domain.removeMember(scope, team.id, 'captain-session', '小明', 'rotation')
    await expect(domain.provisionMember(scope, team.id, 'captain-session', {
      name: '小明', role: 'replacement', sessionId: 'member-cjk-2', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
  })

  it('folds canonically equivalent names onto one identity (NFC, case, separators)', async () => {
    const team = await domain.createTeam(scope, 'captain-session', 'Fold team', 'Equivalent inputs share an identity')
    const spaced = await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'Bob Smith', role: 'separator folding', sessionId: 'member-1', provider: 'spawn',
    })
    expect(spaced.name).toBe('bob-smith')

    // NFC equivalence: the decomposed and composed accented forms are one name.
    const composed = await domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'étude', role: 'nfc folding', sessionId: 'member-2', provider: 'spawn',
    })
    expect(composed.name).toBe('étude')
    await expect(domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'E\u0301tude', role: 'decomposed duplicate', sessionId: 'member-3', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })

    // Case and surrounding punctuation fold onto the same identity too.
    await expect(domain.provisionMember(scope, team.id, 'captain-session', {
      name: '  BOB-SMITH ', role: 'case duplicate', sessionId: 'member-4', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })

    // Mail targeting resolves through the same fold ('BOB SMITH' -> 'bob-smith').
    await domain.settleMember(scope, team.id, 'member-1', { active: true })
    const folded = await domain.queueMessage(scope, team.id, 'captain-session', 'BOB SMITH', 'resolves after folding', 'quiet')
    expect(folded.targetSessionId).toBe('member-1')
  })

  it('rejects over-length, letter-less and reserved names instead of synthesizing identities', async () => {
    const team = await domain.createTeam(scope, 'captain-session', 'Reject team', 'Fail loud on unusable names')

    // 64 code points are admitted; 65 are not (official roster bound parity,
    // decided as reject over the ref digest suffix — see docs/04 §8b).
    const exact = 'a'.repeat(64)
    const admitted = await domain.provisionMember(scope, team.id, 'captain-session', {
      name: exact, role: 'boundary length', sessionId: 'member-1', provider: 'spawn',
    })
    expect(admitted.name).toBe(exact)
    await expect(domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'a'.repeat(65), role: 'too long', sessionId: 'member-2', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_INVALID' })

    // No letters or digits at all: nothing readable remains to identify.
    await expect(domain.provisionMember(scope, team.id, 'captain-session', {
      name: '!!! ... !!!', role: 'punctuation only', sessionId: 'member-3', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_INVALID' })
    await expect(domain.provisionMember(scope, team.id, 'captain-session', {
      name: '\u200b', role: 'zero width only', sessionId: 'member-4', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_INVALID' })

    // The captain pseudo-name stays reserved for the captain identity.
    await expect(domain.provisionMember(scope, team.id, 'captain-session', {
      name: 'Captain', role: 'reserved', sessionId: 'member-5', provider: 'spawn',
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_RESERVED' })
  })
})
