/** Execute the installed overlay functions; only their CSS class map is a fixture.
 * The package's full barrel needs unrelated markdown dependencies unavailable in this test install. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { createPortal } from 'react-dom'

export function profilePrimitiveSource(): string {
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
  const icons = ['IconGaugeOutline16', 'IconDatabaseOutline16', 'IconPaperclipOutline16']
  const iconSource = icons.map(name => { const start = source.indexOf(`const ${name} =`), end = source.indexOf('\n});', start); if (start < 0 || end < 0) throw new Error(`Installed icon missing: ${name}`); return source.slice(start, end + 4) }).join('\n')
  return `${functions}\n${iconSource}\n({ ${[...names, ...icons].join(', ')} })`
}

export function profilePrimitives(): Pick<typeof import('@deepseek-ai/dsh-client-ui-primitives'), 'Modal' | 'useAnchoredPosition' | 'useDismissOnOutsidePointer' | 'IconGaugeOutline16' | 'IconDatabaseOutline16' | 'IconPaperclipOutline16'> {
  return runInNewContext(profilePrimitiveSource(), {
    ...React, ...jsx, createPortal, window, document, Node,
    get ResizeObserver() { return globalThis.ResizeObserver },
    clsx: (...values: unknown[]) => values.filter(Boolean).join(' '),
    css$9: { root: 'fixture-modal-root', mask: 'fixture-modal-mask', dialog: 'fixture-modal-dialog' },
  }) as ReturnType<typeof profilePrimitives>
}

/** Real React + current Surface + the installed overlay functions, without a fixture server. */
export async function profileBrowserScripts(): Promise<string[]> {
  const require = createRequire(import.meta.url)
  const { transpileModule, ModuleKind, JsxEmit, ScriptTarget } = await import('typescript')
  const component = transpileModule(readFileSync(require.resolve('../../src/client/MemberProfileSurface.tsx'), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.React, target: ScriptTarget.ES2022 },
  }).outputText
  return [
    readFileSync(join(dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8'),
    readFileSync(join(dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8'),
    `(() => {
      const { useEffect, useLayoutEffect, useState, Fragment } = React;
      const { createPortal } = ReactDOM;
      const jsx = (type, props, key) => React.createElement(type, key === undefined ? props : { ...props, key });
      const jsxs = jsx;
      const clsx = (...values) => values.filter(Boolean).join(' ');
      const css$9 = { root: 'fixture-modal-root', mask: 'fixture-modal-mask', dialog: 'fixture-modal-dialog' };
      const primitives = eval(${JSON.stringify(profilePrimitiveSource())});
      const exports = {};
      new Function('require', 'exports', ${JSON.stringify(component)})(name => {
        if (name === 'react') return React;
        if (name === 'react-dom') return ReactDOM;
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
        throw new Error('Unexpected Surface dependency: ' + name);
      }, exports);
      const Surface = exports.MemberProfileSurface;
      const pendingFrames = new Set();
      const requestFrame = window.requestAnimationFrame.bind(window), cancelFrame = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => {
        const id = requestFrame(time => { pendingFrames.delete(id); callback(time); });
        pendingFrames.add(id); return id;
      };
      window.cancelAnimationFrame = id => { pendingFrames.delete(id); cancelFrame(id); };
      Object.defineProperty(window, 'profilePendingFrames', { get: () => pendingFrames.size });
      function App() {
        const anchorRef = React.useRef(null), rootRef = React.useRef(null);
        const [open, setOpen] = React.useState(true), [section, setSection] = React.useState('attributes');
        const close = React.useCallback(() => setOpen(false), []);
        return React.createElement('div', { className: 'fixture-sidebar', ref: rootRef },
          React.createElement('button', { ref: anchorRef, 'data-fixture-anchor': true, onClick: () => setOpen(value => !value) }, 'Captain'),
          open && React.createElement(Surface, { anchorRef, rootRef, close, title: 'Captain' }, dismiss =>
            React.createElement('section', { className: 'swarm-profile__content' },
              React.createElement('header', { className: 'swarm-profile__header' }, React.createElement('h3', { 'data-profile-heading': true, tabIndex: -1 }, 'Captain'), React.createElement('button', { onClick: dismiss }, 'Close')),
              React.createElement('button', { 'data-fixture-section': section, onClick: () => setSection('capabilities') }, section),
              React.createElement('div', { className: 'swarm-profile__body', style: { height: 540 } }, React.createElement('div', { style: { height: 1200 } }, 'Current profile content')))));
      }
      ReactDOM.createRoot(document.getElementById('fixture-root')).render(React.createElement(App));
    })();`,
  ]
}
