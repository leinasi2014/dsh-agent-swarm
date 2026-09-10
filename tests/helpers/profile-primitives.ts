/** Execute the installed overlay functions; only their CSS class map is a fixture.
 * The package's full barrel needs unrelated markdown dependencies unavailable in this test install. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { createPortal } from 'react-dom'

export function profilePrimitives(): Pick<typeof import('@deepseek-ai/dsh-client-ui-primitives'), 'Modal' | 'useAnchoredPosition' | 'useDismissOnOutsidePointer'> {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; version: string; main: string }
  if (manifest.name !== '@deepseek-ai/dsh-client-ui-primitives' || manifest.version !== '0.1.5-alpha.2' || manifest.main !== 'lib/index.js') throw new Error('Recheck overlay extraction against the installed official package')
  const source = readFileSync(join(dirname(manifestPath), manifest.main), 'utf8')
  const names = ['Modal', 'useAnchoredPosition', 'useDismissOnOutsidePointer']
  const functions = names.map(name => {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf('//#endregion', start)
    if (start < 0 || end < 0) throw new Error(`Installed overlay function missing: ${name}`)
    return source.slice(start, end)
  }).join('\n')
  return runInNewContext(`${functions}\n({ ${names.join(', ')} })`, {
    ...React, ...jsx, createPortal, window, document, Node,
    get ResizeObserver() { return globalThis.ResizeObserver },
    clsx: (...values: unknown[]) => values.filter(Boolean).join(' '),
    css$9: { root: 'fixture-modal-root', mask: 'fixture-modal-mask', dialog: 'fixture-modal-dialog' },
  }) as ReturnType<typeof profilePrimitives>
}
