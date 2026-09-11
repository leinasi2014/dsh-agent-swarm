import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Actual navigation, menu, dialog and client; only transport data and the glyph are fixtures. */
export async function retirementBrowserScript(): Promise<string> {
  const require = createRequire(import.meta.url)
  const esbuildPath = createRequire(require.resolve('tsdown')).resolve('esbuild')
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const options = { stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {TeamGroupNavigation} from './src/client/TeamGroupNavigation.tsx';
    import {RetirementClient} from './src/client/retirement-client.ts';
    import {zh} from './src/client/team-dashboard-locales.ts';
    window.mountRetirement = (state, preview, recoveredResult) => {
      window.calls=[];window.opened=[];window.completed=[];
      const client=new RetirementClient({call:async(channel,method,input)=>{
        window.calls.push({method,input});
        if(method.endsWith('/preview'))return {ok:true,value:{...preview,target:input.target}};
        if(method.endsWith('/history'))return {ok:true,value:{schemaVersion:1,target:input.target,teamName:preview.teamName,readonly:true,cursor:0,
          sessionId:'captain',sessions:[{id:'captain',label:'团队队长',role:'captain',available:true}],entries:[{sequence:1,role:'user',content:'请核验脸部参考与材质。',truncated:false},{sequence:2,role:'assistant',content:'已完成正面与侧面参考对照。当前候选保留为返修版本，下一步检查脸颊轮廓与眼角连接。'.repeat(4),truncated:false}]}};
        if(method.endsWith('/requestResult'))return {ok:true,value:recoveredResult??{state:'not-found'}};
        throw new Error('连接中断，结果未知');
      }},sessionStorage);
      const props={retirement:client,retired:async result=>window.completed.push(result),t:key=>zh[key],wide:true,expandSidebar:()=>{},refreshDirectory:()=>{},
        useTeam:f=>f(state),usePanelInfo:f=>f({activePanelId:'swarm.group'}),selectGroup:()=>{},
        openMain:async()=>window.opened.push('main'),openCaptain:async()=>window.opened.push('captain'),openMember:async()=>window.opened.push('member')};
      const root=createRoot(document.getElementById('fixture-root')); const render=()=>root.render(React.createElement(TeamGroupNavigation,props));render();
      window.updateRetirement=next=>{state=next;render()};window.unmountRetirement=()=>root.unmount();
    };`, resolveDir: cwd, sourcefile: 'retirement-fixture.tsx', loader: 'tsx' }, absWorkingDir: cwd, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic' }
  return await new Promise<string>((complete, reject) => {
    const child = spawn(process.execPath, ['-e', `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>input+=v);process.stdin.on('end',async()=>{try{const {options,esbuildPath}=JSON.parse(input);options.plugins=[{name:'glyph',setup(build){build.onResolve({filter:/^@deepseek-ai\\/dsh-client-ui-primitives$/},()=>({path:'glyph',namespace:'glyph'}));build.onLoad({filter:/.*/,namespace:'glyph'},()=>({resolveDir:options.absWorkingDir,loader:'js',contents:"import React from 'react';export const IconQueueOutline14=()=>React.createElement('span',{},'☷')"}))}}];const result=await require(esbuildPath).build(options);process.stdout.write(result.outputFiles[0].text)}catch(e){process.stderr.write(String(e));process.exitCode=1}});`], { windowsHide: true })
    let output = '', error = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', (value: string) => { output += value }); child.stderr.on('data', (value: string) => { error += value })
    child.on('error', reject); child.on('close', code => { if (code === 0) complete(output); else reject(new Error(error)) })
    child.stdin.end(JSON.stringify({ options, esbuildPath }))
  })
}
