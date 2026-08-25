import { fail } from './diagnostics.mjs'
import { buildMechanicalInventory } from './inventory-model.mjs'
import { buildAssignmentDeliverySlice } from './assignment-delivery-model.mjs'
import { buildFreshV2InitialDispatchSlice } from './fresh-v2-initial-dispatch-model.mjs'

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0

const registry = Object.freeze([
  Object.freeze({
    id: 'kg1-d1-assignment-delivery-recovery',
    factKey: 'assignmentDelivery',
    build: buildAssignmentDeliverySlice,
  }),
  Object.freeze({
    id: 'kg1-d2-fresh-v2-initial-dispatch',
    factKey: 'freshV2InitialDispatch',
    build: buildFreshV2InitialDispatchSlice,
  }),
])

function aggregate(kind, slices) {
  const result = []
  const seen = new Map()
  for (const slice of slices) {
    for (const item of slice[kind]) {
      const previous = seen.get(item.id)
      if (previous !== undefined) {
        fail('KG_SEMANTIC_REGISTRY_ID_COLLISION', `semantic slice identity ${item.id} is declared twice`, {
          id: item.id,
          kind,
          slices: [previous, slice.sliceId],
        })
      }
      seen.set(item.id, slice.sliceId)
      result.push(item)
    }
  }
  return result.sort((left, right) => compareText(left.id, right.id))
}

export function buildRegisteredSemanticSlices(factSets, sourceFacts) {
  const mechanical = buildMechanicalInventory(sourceFacts)
  const slices = registry.filter(entry => factSets[entry.factKey] !== undefined).map(entry => {
    const facts = factSets[entry.factKey]
    return { sliceId: entry.id, ...entry.build(facts, mechanical) }
  })
  return {
    sliceIds: slices.map(item => item.sliceId),
    nodes: aggregate('nodes', slices),
    edges: aggregate('edges', slices),
    slices,
  }
}
