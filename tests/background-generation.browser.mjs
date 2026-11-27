import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkspaceStore} from '../src/workspace-store.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),qa=join(root,'work/background-generation-qa');await mkdir(qa,{recursive:true});const directory=await mkdtemp(join(qa,'data-')),store=createWorkspaceStore(join(directory,'workspace.json')),streams=[];let server,browser,output='';
const mock=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'background-model'}]}));}if(req.url==='/v1/chat/completions'){streams.push({response:res,payload:JSON.parse(raw)});res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return;}res.writeHead(404);res.end('{}');});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url='http://127.0.0.1:'+port;
const wait=async(check,label)=>{for(let i=0;i<350;i++){if(await check())return;await new Promise(r=>setTimeout(r,40));}throw new Error('Timeout: '+label+'\n'+output);};
const push=(index,delta,done=false)=>{const frame='data: '+JSON.stringify({choices:[{delta,...(done?{finish_reason:'stop'}:{})}]})+'\n\n';if(done)streams[index].response.end(frame+'data: [DONE]\n\n');else streams[index].response.write(frame);};
const disk=async()=>{const index=JSON.parse(await readFile(join(directory,'workspace.json'),'utf8')),ref=index.data.chats.find(c=>c.id==='a'),path=join(directory,ref.path);return {chat:JSON.parse(await readFile(path,'utf8')),mtime:(await stat(path)).mtimeMs};};
try{
 server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_DATA_DIR:directory},windowsHide:true,stdio:'pipe'});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);await wait(async()=>{try{return(await fetch(url+'/health')).ok;}catch{return false;}},'startup');browser=await chromium.launch({channel:'chrome',headless:true});
 for(const mobile of [false,true]){
  const old=await store.get(),profile={id:'p',name:'Mock',baseUrl:'http://127.0.0.1:'+mock.address().port,mode:'proxy'};
  await store.update(old.revision,{parameterPolicyVersion:1,profiles:[profile],profile,projects:[],chats:[{id:'a',title:'后台小说',model:'background-model',params:{system:'本次使用的设定'},messages:[]},{id:'b',title:'另一对话',model:'background-model',params:{system:'另一个设定'},messages:[]}],active:'a',presets:[{name:'当前预设',params:{system:'本次使用的设定'}}]});
  const errors=[],contexts=[],options={locale:'zh-CN',viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile};
  const open=async()=>{const context=await browser.newContext(options);contexts.push(context);const page=await context.newPage();page.setDefaultTimeout(14000);page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));return {context,page};};
  const sidebar=async page=>{if(mobile&&!await page.locator('#shell').evaluate(el=>el.classList.contains('show-sidebar')))await page.locator('[data-action="sidebar"]').click();};
  const base=streams.length;let {context,page}=await open(),submitted;
  page.on('request',request=>{if(request.method()==='POST'&&request.url()===url+'/api/generations')submitted=request.postDataJSON();});
  await page.locator('#prompt').fill('生成不能被关闭网页取消');await page.locator('#send').click();await wait(()=>streams.length===base+1,'model request');push(base,{content:'第一段。',reasoning_content:'思考一。'});await page.locator('#messages>.message').last().locator('.message-content').filter({hasText:'第一段。'}).waitFor();const before=await disk();assert.equal(before.chat.messages.at(-1).content,'');assert(submitted?.id);
  await context.close();push(base,{content:'关闭页面后继续。'});await wait(async()=>(await(await fetch(url+'/api/generations/'+submitted.id)).json()).task.assistant.content.includes('关闭页面后继续'),'server kept reading');assert.equal(streams[base].response.destroyed,false);assert.equal((await disk()).mtime,before.mtime);
  ({context,page}=await open());await page.locator('#messages>.message').last().locator('.message-content').filter({hasText:'关闭页面后继续。'}).waitFor();assert.equal(streams.length,base+1);
  const duplicate=await fetch(url+'/api/generations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(submitted)});assert.equal(duplicate.status,200);assert.equal(streams.length,base+1);
  await sidebar(page);await page.locator('[data-page="models"]').first().click();push(base,{content:'切换站内页面也继续。'});await sidebar(page);await page.locator('[data-page="chat"]').first().click();await page.locator('#messages>.message').last().locator('.message-content').filter({hasText:'切换站内页面也继续。'}).waitFor();
  await context.setOffline(true);push(base,{content:'手机断网时仍在生成。'});await wait(async()=>(await(await fetch(url+'/api/generations/'+submitted.id)).json()).task.assistant.content.includes('手机断网'),'offline server progress');await context.setOffline(false);await page.locator('#messages>.message').last().locator('.message-content').filter({hasText:'手机断网时仍在生成。'}).waitFor();assert.equal(streams.length,base+1);assert.equal((await disk()).mtime,before.mtime);
  await context.close();push(base,{content:'关闭后完成。'},true);await wait(async()=>(await disk()).chat.messages.at(-1).status==='complete','background save');const saved=await disk();assert.equal(saved.chat.messages.at(-1).content,'第一段。关闭页面后继续。切换站内页面也继续。手机断网时仍在生成。关闭后完成。');assert.equal(saved.chat.messages.at(-1).reasoning,'思考一。');assert.equal((await store.get()).data.chats.length,2);
  ({context,page}=await open());await page.locator('#messages>.message').last().locator('.message-content').filter({hasText:'关闭后完成。'}).waitFor();assert.equal(streams.length,base+1);assert.equal((await(await fetch(url+'/api/generations')).json()).tasks.length,0);
  await page.locator('#prompt').fill('检查回答和思考合计上限');await page.locator('#send').click();await wait(()=>streams.length===base+2,'limit request');push(base+1,{reasoning_content:'思'.repeat(16000)});push(base+1,{content:'文'.repeat(14000)});
  await wait(async()=>(await disk()).chat.messages.at(-1).stopReason==='output_limit','limit saved');await page.locator('.completion-notice').filter({hasText:'30,000'}).waitFor();const limited=(await disk()).chat.messages.at(-1);assert.equal(limited.status,'stopped');assert.equal(limited.reasoning.length+limited.content.length,30000);await wait(()=>streams[base+1].response.destroyed,'upstream cancelled at limit');assert.equal(streams.length,base+2);
  assert.deepEqual(errors,[]);for(const c of contexts)await c.close().catch(()=>{});console.log('PASS '+(mobile?'mobile':'desktop')+': close/reopen/offline/navigation keep one request, final-only saving, idempotency and 30k reasoning+answer auto-stop');
 }
}finally{await browser?.close();for(const stream of streams)stream.response.destroy();if(server?.exitCode===null){const exit=once(server,'exit');server.kill();await exit;}mock.closeAllConnections();await new Promise(r=>mock.close(r));}
