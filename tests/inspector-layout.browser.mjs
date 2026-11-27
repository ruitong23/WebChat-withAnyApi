import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkspaceStore} from '../src/workspace-store.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),qa=join(root,'work/inspector-layout-qa');await mkdir(qa,{recursive:true});const directory=await mkdtemp(join(qa,'data-'));let server,browser,output='';
const mock=http.createServer(async(req,res)=>{for await(const part of req){};res.setHeader('Content-Type','application/json');if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'layout-model'}]}));res.writeHead(404);res.end('{}');});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url='http://127.0.0.1:'+port;
const text='中文剧情在打开设置后应该保持完整，不会被挤成一列。\n\n'+String.raw`$\text{距离拉近} \rightarrow \text{身体接触}$`+'\n\n| 人物 | 设定 |\n| --- | --- |\n| 阿莉雅 | 保持一致 |\n\n'+('后续正文与正常段落。\n\n').repeat(35);
const profile={id:'p',name:'Mock',baseUrl:'http://127.0.0.1:'+mock.address().port,mode:'proxy'};
await createWorkspaceStore(join(directory,'workspace.json')).update(0,{parameterPolicyVersion:1,profiles:[profile],profile,projects:[],chats:[{id:'a',title:'窄屏对话',model:'layout-model',messages:[{id:'u',role:'user',content:'继续剧情'},{id:'a',role:'assistant',content:text,status:'complete'}]}],active:'a',inspector:true});
const wait=async check=>{for(let i=0;i<200;i++){try{if(await check())return;}catch{}await new Promise(r=>setTimeout(r,40));}throw new Error('Startup timeout '+output);};
try{
 server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_DATA_DIR:directory},windowsHide:true,stdio:'pipe'});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);await wait(async()=>(await fetch(url+'/health')).ok);browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:960}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));await page.evaluate(()=>document.fonts.ready);
 const geometry=()=>page.locator('.workspace').evaluate(el=>{const r=el.getBoundingClientRect();const chat=document.querySelector('#conversation').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,chatHeight:chat.height};});
 for(const width of [1120,1000,850,721,720,390]){
  await page.setViewportSize({width,height:960});await page.keyboard.press('Escape');await page.locator('#conversation').evaluate(el=>el.scrollTop=300);const before=await geometry(),html=await page.locator('#msg-a .message-content').innerHTML();
  await page.locator('.topbar [data-action="inspector"]').click();assert(await page.locator('.inspector').isVisible());const after=await geometry();assert.deepEqual(after,before,'Opening inspector must not move or shrink the workspace at width '+width);assert(after.chatHeight>180);assert.equal(await page.locator('#msg-a .message-content').innerHTML(),html);
  assert(await page.locator('.mobile-overlay').evaluate(el=>getComputedStyle(el).position==='fixed'));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(await page.locator('#msg-a .katex').count(),1);assert.equal(await page.locator('#msg-a .katex-error').count(),0);assert.equal(await page.locator('#conversation').evaluate(el=>el.scrollTop),300);
  if([1000,390].includes(width))await page.screenshot({path:join(qa,width+'.png')});
  await page.locator('.mobile-overlay').click({position:{x:5,y:300}});assert(!await page.locator('.inspector').isVisible());assert.deepEqual(await geometry(),before);await page.locator('.topbar [data-action="inspector"]').click();await page.keyboard.press('Escape');assert(!await page.locator('.inspector').isVisible());
  console.log('PASS '+width+'px: drawer overlay, stable chat geometry/scroll/text/math, backdrop and Escape');
 }
 await page.setViewportSize({width:1440,height:960});assert(await page.locator('.inspector').isVisible());assert.deepEqual(errors,[]);await context.close();
}finally{await browser?.close();if(server?.exitCode===null){const exit=once(server,'exit');server.kill();await exit;}mock.closeAllConnections();await new Promise(r=>mock.close(r));}
