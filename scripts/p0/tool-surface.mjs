/** Exact plugin-owned tool surface required by the real P0 Profile probe. */
export const EXPECTED_P0_SWARM_TOOL_NAMES = Object.freeze([
  'agent_swarm_add_member',
  'agent_swarm_add_memory',
  'agent_swarm_add_private_memory',
  'agent_swarm_archive',
  'agent_swarm_claim_task',
  'agent_swarm_create',
  'agent_swarm_create_task',
  'agent_swarm_interrupt_member',
  'agent_swarm_list_jobs',
  'agent_swarm_list_members',
  'agent_swarm_list_memory',
  'agent_swarm_list_private_memory',
  'agent_swarm_reassign_task',
  'agent_swarm_remove_member',
  'agent_swarm_review_task',
  'agent_swarm_send_message',
  'agent_swarm_set_budget',
  'agent_swarm_status',
  'agent_swarm_submit_task',
  'agent_swarm_wait',
  'agent_swarm_list_tasks',
].toSorted())

/** Probe output is sorted before comparison; replacement, omission and extras all fail. */
export function exactP0SwarmToolSurface(tools) {
  const actual = Array.isArray(tools) && tools.every(tool => typeof tool === 'string') ? tools.toSorted() : undefined
  return {
    ok: actual !== undefined
      && actual.length === EXPECTED_P0_SWARM_TOOL_NAMES.length
      && actual.every((tool, index) => tool === EXPECTED_P0_SWARM_TOOL_NAMES[index]),
    actual,
    expected: EXPECTED_P0_SWARM_TOOL_NAMES,
  }
}
