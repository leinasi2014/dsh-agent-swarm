/** Typed cleanup ownership for the plugin's separate, already existing storage domains. */
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { TeamId } from '../domain/types.js'
import type { MemberPrivateMemoryStore } from '../storage/member-private-memory.js'
import type { HumanInteractionOverlayStore } from '../human/human-interaction-store.js'
import { WorkflowRunOverlayStore, workflowOverlayDomainSpec } from '../storage/workflow-run-overlay.js'
import type { TeamBridgeWorkflowEngine } from './workflow/team-bridge-engine.js'

export class RetirementData {
  private constructor(private readonly memory: MemberPrivateMemoryStore, private readonly human: HumanInteractionOverlayStore,
    private readonly workflow: WorkflowRunOverlayStore, private readonly bridge?: TeamBridgeWorkflowEngine,
    private readonly domain?: Domain<typeof workflowOverlayDomainSpec>) {}
  static async open(ctx: Context, memory: MemberPrivateMemoryStore, human: HumanInteractionOverlayStore,
    bridge?: TeamBridgeWorkflowEngine): Promise<RetirementData> {
    if (bridge !== undefined) return new RetirementData(memory, human, bridge.overlay, bridge)
    const domain = await ctx.storageDomain.open(workflowOverlayDomainSpec)
    return new RetirementData(memory, human, new WorkflowRunOverlayStore(ctx, domain), undefined, domain)
  }
  counts(scope: string, teamId: string) {
    return { memories: this.memory.countTeam(scope, teamId), humanInteractions: this.human.list(scope, TeamId(teamId)).length,
      workflowRuns: this.workflow.list().filter(row => row.scope === scope && row.teamId === teamId).length }
  }
  async settle(scope: string, teamId: string): Promise<void> {
    await this.bridge?.retireTeam(scope, teamId)
    await this.workflow.settleRetiredTeam(scope, teamId)
  }
  async purge(scope: string, teamId: string): Promise<void> {
    await this.memory.purgeTeam(scope, teamId)
    await this.human.purgeTeam(scope, TeamId(teamId))
    await this.workflow.purgeTeam(scope, teamId)
    if (Object.values(this.counts(scope, teamId)).some(count => count !== 0)) throw new Error('Team subsidiary storage cleanup did not verify')
  }
  async close(): Promise<void> { if (this.domain !== undefined) { this.workflow.close(); await this.domain.close() } }
}
