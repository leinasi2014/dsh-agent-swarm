/** Official local attachment storage plus the existing real authenticated public/Session composition. */
import LocalAttachmentStore, { type Config } from '@deepseek-ai/dsh-attachment-local'
import { expect } from 'vitest'
import { ROOT, Recording, setup } from './public-chat-real-composition.js'

export const PNG_IMAGE = { type: 'image' as const, mediaType: 'image/png' as const,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', name: 'pixel.png' }
export const GIF_IMAGE = { type: 'image' as const, mediaType: 'image/gif' as const,
  data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', name: 'pixel.gif' }

export class ImageRecording extends Recording {
  imageInput: 'supported' | 'unsupported' | 'unknown' = 'supported'
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, ...(this.imageInput === 'unknown' ? {}
      : { inputModalities: this.imageInput === 'supported' ? ['text' as const, 'image' as const] : ['text' as const] }) }
  }
}

export async function setupImages(sandbox: string, adapter = new ImageRecording(), config: Config | false = {}) {
  return await setup(sandbox, adapter, true, async (ctx, fibers) => {
    if (config !== false) fibers.push(await ctx.plugin(LocalAttachmentStore, { dshHome: sandbox, ...config }))
  })
}

export async function imageClient(f: Awaited<ReturnType<typeof setup>>, teamId: string) {
  const auth = await fetch(f.ctx.connection.authenticatedUrl(f.base + '/'), { redirect: 'manual' })
  expect(auth.status).toBe(303)
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
  return async (endpoint: string, fields: object = {}, version = 3, signal?: AbortSignal) => {
    const response = await fetch(`${f.base}/swarm-public/v${version}/${endpoint}`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie }, ...(signal === undefined ? {} : { signal }),
      body: JSON.stringify({ type: 'client-request', rpcId: 'image-fixture-rpc', method: `v${version}/${endpoint}`,
        payload: { schemaVersion: version, target: { rootSessionId: ROOT, teamId }, ...fields } }) })
    expect(response.status).toBe(200)
    return (await response.json()).result
  }
}
