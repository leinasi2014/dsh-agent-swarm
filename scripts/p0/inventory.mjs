export function pluginInventoryPayload() {
  return { args: {} }
}

export function parsePluginInventoryResponse(response) {
  if (response?.ok !== true) {
    const error = response?.body?.result?.error
    throw new Error(`pluginInventory/list transport or remote failure: ${JSON.stringify(error ?? response)}`)
  }
  const value = response.body?.result?.value
  if (!Array.isArray(value?.entries)) throw new Error('pluginInventory/list returned no entries array')
  return value.entries
}
