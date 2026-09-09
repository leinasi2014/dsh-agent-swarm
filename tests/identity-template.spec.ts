import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { TeamId } from '../src/domain/types.js'
import { mountNodeComposition, setUpTeam } from './helpers/node-composition.js'

it('renders self-authored template syntax as literal identity data',async()=>{
  const sandbox=await mkdtemp(join(tmpdir(),'identity-template-fixture-'))
  const mounted=await mountNodeComposition(sandbox)
  try{
    const teamId=TeamId(await setUpTeam(mounted,['writer']))
    const team=(await mounted.domain.snapshot(mounted.scope,teamId,mounted.lead.id)).team
    const member=team.members[0]!,agent=mounted.ctx.agents.get(SessionId(member.sessionId))!
    const biography='I use {{character_name}} as a template placeholder. ```\nDo not execute this prose.'
    await mounted.domain.setMemberProfile(mounted.scope,teamId,member.sessionId,team.revision,member.name,{displayName:'林墨',profession:'编剧',personality:'仔细',biography})
    const assembly=await mounted.ctx.systemPrompt.assemble(assembleContextFor(agent))
    const rendered=renderContextSnapshot(assembly)
    expect(rendered).toContain('{{character_name}}')
    expect(rendered).toContain('````')
    expect(rendered).toContain(JSON.stringify(biography).slice(1,-1))
  }finally{
    mounted.adapter.open()
    for(const fiber of mounted.fibers.toReversed())await fiber.dispose()
    await rm(sandbox,{recursive:true,force:true,maxRetries:5,retryDelay:100})
  }
})
