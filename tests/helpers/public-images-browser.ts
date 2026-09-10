import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { profilePrimitiveSource } from './profile-primitives.js'

/** Real components and installed Modal; only Host data/read transport are fixtures. */
export async function publicImagesBrowserScript(): Promise<string> {
  const require = createRequire(import.meta.url)
  const esbuildPath = createRequire(require.resolve('tsdown')).resolve('esbuild')
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const options = { stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {TeamPublicChat} from './src/client/TeamPublicChat.tsx';
    import {zh} from './src/client/team-dashboard-locales.ts';
    window.mountChat = async (team, chat) => {
      const canvas = document.createElement('canvas'); canvas.width=480; canvas.height=320;
      const c=canvas.getContext('2d'); c.fillStyle='#c8daf4'; c.fillRect(0,0,480,320);
      c.fillStyle='#55799e'; c.fillRect(60,80,160,170); c.fillStyle='#b17e72'; c.beginPath(); c.arc(320,155,72,0,Math.PI*2); c.fill();
      const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
      chat.draftBlobs={'draft-image':blob};
      window.reads=0;window.created=[];window.revoked=[];window.actions=[];
      const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
      URL.createObjectURL=b=>{const url=create(b);window.created.push(url);return url}; URL.revokeObjectURL=u=>{window.revoked.push(u);revoke(u)};
      const action=name=>(...args)=>window.actions.push([name,...args.map(v=>Array.isArray(v)?v.map(f=>f.name):v)]);
      const props={t:(key,params={})=>zh[key].replace(/\\{(\\w+)\\}/gu,(match,name)=>name in params?String(params[name]):match),
        useTeam:f=>f(team),useChat:f=>f(chat),useSurface:f=>f({mode:'inactive',view:'overview'}),
        image:async()=>{window.reads++;return blob},addImages:action('addImages'),removeImage:action('removeImage'),
        replaceText:action('replaceText'),chooseMention:action('mention'),removeMention:action('removeMention'),refreshDirectory:()=>{},
        edit:()=>{},reply:action('reply'),send:action('send'),recover:()=>{},earlier:()=>{},newer:()=>{},refresh:()=>{},upgradeLegacy:()=>{},openTeam:()=>{},retryDraftStorage:()=>{},useStoredDraft:()=>{}};
      const root=createRoot(document.getElementById('fixture-root'));root.render(React.createElement(TeamPublicChat,props)); window.unmountChat=()=>root.unmount();
    };`, resolveDir: cwd, sourcefile: 'image-fixture.tsx', loader: 'tsx' }, absWorkingDir: cwd, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  }
  const primitives = `import {useEffect,useRef,useState,useLayoutEffect,useCallback} from 'react'; import {jsx,jsxs} from 'react/jsx-runtime'; import {createPortal} from 'react-dom'; const clsx=(...v)=>v.filter(Boolean).join(' '); const css$9={root:'fixture-modal-root',mask:'fixture-modal-mask',dialog:'fixture-modal-dialog'}; ${profilePrimitiveSource().slice(0, profilePrimitiveSource().lastIndexOf('\n({'))} export {Modal};`
  return await new Promise<string>((complete, reject) => {
    const child = spawn(process.execPath, ['-e', `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>input+=v);process.stdin.on('end',async()=>{try{const {options,primitives,esbuildPath}=JSON.parse(input);options.plugins=[{name:'installed-modal-only',setup(build){build.onResolve({filter:/^@deepseek-ai\\/dsh-client-ui-primitives$/},()=>({path:'modal',namespace:'installed-modal'}));build.onLoad({filter:/.*/,namespace:'installed-modal'},()=>({resolveDir:options.absWorkingDir,loader:'js',contents:primitives}))}}];const result=await require(esbuildPath).build(options);process.stdout.write(result.outputFiles[0].text)}catch(e){process.stderr.write(String(e));process.exitCode=1}});`], { windowsHide: true })
    let output = '', error = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', (value: string) => { output += value }); child.stderr.on('data', (value: string) => { error += value })
    child.on('error', reject); child.on('close', code => { if (code === 0) complete(output); else reject(new Error(error)) })
    child.stdin.end(JSON.stringify({ options, primitives, esbuildPath }))
  })
}
