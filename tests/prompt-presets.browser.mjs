import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkspaceStore} from '../src/workspace-store.mjs';
import {createModelConfigStore} from '../src/shared-store.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),qa=join(root,'work/prompt-presets-qa');await mkdir(qa,{recursive:true});
const directory=await mkdtemp(join(qa,'data-')),configFile=join(directory,'model-configs.json');let server,browser,output='';const requests=[];
const mock=http.createServer(async(req,res)=>{
 let raw='';for await(const part of req)raw+=part;
 res.setHeader('Content-Type','application/json');
 if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'prompt-model'}]}));
 if(req.url==='/v1/chat/completions'){requests.push(JSON.parse(raw));return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'模拟回复'},finish_reason:'stop'}]}));}
 res.writeHead(404);res.end('{}');
});await new Promise(r=>mock.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+mock.address().port;
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url='http://127.0.0.1:'+port;
const store=createWorkspaceStore(join(directory,'workspace.json')),configs=createModelConfigStore(configFile);
const wait=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(r=>setTimeout(r,40));}throw new Error('Timeout: '+label+'\n'+output);};
try{
 server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_DATA_DIR:directory},windowsHide:true,stdio:'pipe'});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 await wait(async()=>{try{return(await fetch(url+'/health')).ok;}catch{return false;}},'startup');browser=await chromium.launch({channel:'chrome',headless:true});
 for(const mobile of [false,true]){
  const old=await store.get(),profile={id:'p',name:'Mock API',baseUrl:base,mode:'proxy'};
  const parameters={temperature:.37,override_temperature:true,top_p:.82,override_top_p:true,max_tokens:4096,override_max_tokens:true,stream:false,history:12,extra:'{}'};
  await configs.update(base,'prompt-model',(await configs.get(base,'prompt-model')).revision,{...parameters,system:'不应覆盖对话的共享提示词'});
  await store.update(old.revision,{parameterPolicyVersion:1,profiles:[profile],profile,projects:[],active:'a',chats:[{id:'a',title:'空白对话',model:'prompt-model',params:{...parameters,system:''},messages:[],created:1},{id:'b',title:'独立设定',model:'prompt-model',params:{...parameters,system:'另一个对话的设定'},messages:[],created:2}],presets:[{name:'旧版预设',params:{system:'旧版设定',temperature:1.8,max_tokens:100,top_p:.1,override_temperature:false,extra:'{"seed":123}'}}]});
  const context=await browser.newContext({locale:'zh-CN',viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));
  const panel=async()=>{if(!await page.locator('#system-prompt').isVisible())await page.locator('.topbar [data-action="inspector"]').click();};
  const sidebar=async()=>{if(mobile&&!await page.locator('#shell').evaluate(el=>el.classList.contains('show-sidebar')))await page.locator('[data-action="sidebar"]').click();};
  const closePanel=async()=>{if(mobile&&await page.locator('#system-prompt').isVisible())await page.locator('.inspector [data-action="inspector"]').click();};
  const saved=()=>page.waitForFunction(()=>document.querySelector('#storage-status')?.textContent.includes('已保存到服务器'));
  const confirm=async name=>{await page.locator('#modal-input').fill(name);await page.locator('.modal [data-action="confirm"]').click();await saved();};
  const sampling=()=>page.locator('.inspector [data-param]').evaluateAll(fields=>Object.fromEntries(fields.filter(f=>f.dataset.param!=='system').map(f=>[f.dataset.param,f.type==='checkbox'?f.checked:f.value])));
  await panel();assert.equal(await page.locator('#system-prompt').inputValue(),'');assert.equal(await page.locator('#preset-select').inputValue(),'empty');assert(await page.locator('[data-action="update-preset"]').isDisabled());assert(await page.locator('[data-action="delete-preset"]').isDisabled());const before=await sampling();
  await page.locator('#preset-select').selectOption('saved-0');assert.equal(await page.locator('#system-prompt').inputValue(),'旧版设定');assert.deepEqual(await sampling(),before);await saved();
  await page.locator('#system-prompt').fill('新设定：角色保持一致。');await page.locator('[data-action="save-preset"]').click();await confirm('故事设定');assert.equal((await store.get()).data.presets.length,2);assert.deepEqual((await store.get()).data.presets[1],{name:'故事设定',params:{system:'新设定：角色保持一致。'}});assert.deepEqual(await sampling(),before);
  await page.locator('#system-prompt').fill('更新后的故事设定');await page.locator('[data-action="update-preset"]').click();await confirm('故事设定第二版');assert.equal((await store.get()).data.presets.length,2);assert.equal((await store.get()).data.presets[1].params.system,'更新后的故事设定');assert.deepEqual(await sampling(),before);
  await page.reload();await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));await panel();assert.equal(await page.locator('#system-prompt').inputValue(),'更新后的故事设定');await page.locator('#preset-select').selectOption('saved-1');await page.locator('[data-action="delete-preset"]').click();await page.locator('.modal [data-action="confirm"]').click();await saved();assert.equal((await store.get()).data.presets.length,1);assert.equal(await page.locator('#system-prompt').inputValue(),'更新后的故事设定');
  await page.locator('#preset-select').selectOption('empty');assert.equal(await page.locator('#system-prompt').inputValue(),'');await saved();assert.deepEqual(await sampling(),before);assert.equal((await configs.get(base,'prompt-model')).params.system,'不应覆盖对话的共享提示词');
  await closePanel();await sidebar();await page.locator('[data-chat="b"]').click();await page.waitForFunction(()=>document.querySelector('#conversation')?.dataset.chat==='b');await panel();assert.equal(await page.locator('#system-prompt').inputValue(),'另一个对话的设定');await page.locator('#system-prompt').fill('对话 B 的新设定');await saved();
  await closePanel();await sidebar();await page.locator('[data-action="new-chat"]').click();await panel();assert.equal(await page.locator('#system-prompt').inputValue(),'');await saved();
  await page.locator('#system-prompt').fill('只用于这次请求的设定');assert.equal(await page.locator('#preset-select').inputValue(),'');await saved();await closePanel();await page.locator('#prompt').fill('继续剧情');await page.locator('#send').click();await wait(()=>requests.length>=(mobile?2:1),'generation');await wait(async()=>(await store.get()).data.chats.some(c=>c.messages.at(-1)?.content==='模拟回复'),'completion');
  const request=requests.at(-1);assert.deepEqual(request.messages[0],{role:'system',content:'只用于这次请求的设定'});assert.equal(request.temperature,.37);assert.equal(request.top_p,.82);assert.equal(request.max_tokens,4096);assert.equal((await configs.get(base,'prompt-model')).params.system,'不应覆盖对话的共享提示词');
  await panel();await page.screenshot({path:join(qa,mobile?'mobile.png':'desktop.png')});assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await context.close();console.log('PASS '+(mobile?'mobile':'desktop')+': empty/default, legacy prompt-only apply, create/update/delete, reload, independent chats and unchanged request parameters');
 }
}finally{await browser?.close();if(server?.exitCode===null){const exit=once(server,'exit');server.kill();await exit;}mock.closeAllConnections();await new Promise(r=>mock.close(r));}
