/** Browser-safe, side-effect-free R2 client. Constructing or mounting performs no request. */
import {
  parseSwarmReadRpcEnvelope,
  SWARM_READ_RPC_ENDPOINT,
  type SwarmReadRpcEnvelope,
  type SwarmReadRpcRequest,
} from '../rpc/read-rpc-contract.js'
import { assertSwarmReadRpcValue } from '../rpc/read-rpc-artifact.js'

export * from '../rpc/read-rpc-contract.js'
export * from '../rpc/read-rpc-artifact.js'

export type SwarmFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class SwarmReadClient {
  constructor(
    private readonly fetcher: SwarmFetch = globalThis.fetch.bind(globalThis),
    private readonly endpoint: string = SWARM_READ_RPC_ENDPOINT,
  ) {}

  mount(): SwarmReadClientMount {
    return new SwarmReadClientMount(this)
  }

  async request(request: SwarmReadRpcRequest, signal?: AbortSignal): Promise<SwarmReadRpcEnvelope> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    })
    const value = parseSwarmReadRpcEnvelope(await response.json())
    if (!response.ok && value.ok) throw new Error(`Swarm RPC returned HTTP ${String(response.status)} with a success body`)
    if (value.ok) assertSwarmReadRpcValue(request.method, value.value)
    return value
  }
}

/** One UI/component lifetime. Disposal aborts its physical requests and forbids new calls. */
export class SwarmReadClientMount {
  private readonly controller = new AbortController()
  private disposed = false

  constructor(private readonly client: SwarmReadClient) {}

  request(request: SwarmReadRpcRequest, signal?: AbortSignal): Promise<SwarmReadRpcEnvelope> {
    if (this.disposed) return Promise.reject(new Error('Swarm read client mount is disposed'))
    return this.client.request(request, combineSignals(this.controller.signal, signal))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort()
  }
}

function combineSignals(owner: AbortSignal, caller: AbortSignal | undefined): AbortSignal {
  if (caller === undefined) return owner
  return AbortSignal.any([owner, caller])
}
