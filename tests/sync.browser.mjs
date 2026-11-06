import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createWorkspaceStore} from '../src/workspace-store.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(join(root,'work/sync-qa'),{recursive:true});
const directory=await mkdtemp(join(root,'work/sync-qa/data-')),file=join(directory,'workspace.json');
let browser,server,output='',privateAllowed=true;
const auth=[],sentAfterSave=[];
const mock=http.createServer(async(req,res)=>{
 let text='';for await(const b of req)text+=b;
 auth.push(req.headers.authorization);
 if(!['Bearer test-one','Bearer test-two'].includes(req.headers.authorization)){res.writeHead(401);res.end('{}');return;}
 res.setHeader('Content-Type','application/json');
 if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'upgrade-test'}]}));
 if(req.url==='/v1/chat/completions'){
  const body=JSON.parse(text),index=JSON.parse(await readFile(file,'utf8'));
  const saved=await Promise.all(index.data.chats.map(c=>readFile(join(directory,c.path),'utf8').then(JSON.parse)));
  sentAfterSave.push(saved.some(c=>c.messages.some(m=>m.role==='user'&&m.content===body.messages.at(-1).content)));
  res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content:'模拟模型回答'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;
 }
 res.writeHead(404);res.end('{}');
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+mock.address().port;
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url='http://127.0.0.1:'+port;
const profiles=['one','two'].map(id=>({id,name:'连接 '+id,baseUrl:base,mode:'proxy',remember:true}));
await createWorkspaceStore(file).update(0,{parameterPolicyVersion:1,chats:[{id:'seed',title:'小说对话',messages:[{id:'seed-user',role:'user',content:'原来的正文'}],model:'upgrade-test',created:1}],projects:[],profiles,profile:profiles[0],keys:{one:'test-one',two:'test-two'},active:'seed'});
const wait=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timeout: '+label+'\n'+output);};
const start=async()=>{
 server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_PUBLIC_ORIGIN:url,LUMEN_ALLOW_PRIVATE:String(privateAllowed),LUMEN_WORKSPACE_FILE:file,LUMEN_CONFIG_FILE:join(directory,'model-configs.json')},windowsHide:true,stdio:'pipe'});
 server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 await wait(async()=>{try{return (await fetch(url+'/health')).ok;}catch{return false;}},'startup');
};
const stop=async()=>{if(server?.exitCode===null){const exited=once(server,'exit');server.kill();await exited;}};
const record=async()=>(await fetch(url+'/api/workspace?view=sidebar')).json();
const chat=async id=>(await (await fetch(url+'/api/chats/'+id)).json());
const patch=async changes=>{const response=await fetch(url+'/api/workspace',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({changes})});assert.equal(response.status,200);return response.json();};
const connected=page=>page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));
const saved=page=>page.waitForFunction(()=>document.querySelector('#storage-status')?.textContent.includes('已保存到服务器'));
try{
 await start();browser=await chromium.launch({channel:'chrome',headless:true});
 const errors=[],context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}}),page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 const responses=[];page.on('response',r=>{if(r.url().includes('/api/workspace')&&r.status()===200)r.text().then(s=>responses.push(s)).catch(()=>{});});
 await page.goto(url);await page.locator('#msg-seed-user').waitFor();await connected(page);assert(auth.includes('Bearer test-one'));
 await page.locator('[data-page="connection"]').first().click();assert.equal(await page.locator('#api-key').inputValue(),'');assert.match(await page.locator('#api-key').getAttribute('placeholder'),/留空保持不变/);
 await page.locator('[data-action="save-connection"]').click();await saved(page);
 await page.locator('[data-profile="two"]').click();await connected(page);assert(auth.includes('Bearer test-two'));assert.equal(await page.locator('.profile-tab.active').getAttribute('data-profile'),'two');
 await page.locator('[data-profile="one"]').click();await connected(page);await saved(page);
 assert(responses.every(s=>!s.includes('test-one')&&!s.includes('test-two')));assert.equal((await record()).data.keys,undefined);
 assert.equal(JSON.parse(await readFile(file,'utf8')).data.keys.one,'test-one');
 await page.locator('[data-page="chat"]').first().click();
 console.log('PASS server configuration, same-URL profiles, blank key preservation and secret-free responses');

 const peerContext=await browser.newContext({locale:'zh-CN'}),peer=await peerContext.newPage();peer.on('pageerror',e=>errors.push(e.message));
 await peer.goto(url);await connected(peer);await saved(peer);await peer.locator('#prompt').fill('保留我正在写的草稿');
 let original=await chat('seed');await patch({chats:[{id:'seed',baseEtag:original._etag,chat:{...original.chat,messages:[{id:'seed-user',role:'user',content:'其他设备修改后的正文'}]}}]});
 await peer.bringToFront();await peer.locator('#msg-seed-user').filter({hasText:'其他设备修改后的正文'}).waitFor();assert.equal(await peer.locator('#prompt').inputValue(),'保留我正在写的草稿');
 await page.bringToFront();await page.locator('#msg-seed-user').filter({hasText:'其他设备修改后的正文'}).waitFor();
 const rev=(await record()).revision;assert.equal((await fetch(url+'/api/workspace?view=sidebar&since='+rev)).status,304);
 console.log('PASS revision polling updates active messages across browsers without losing a draft');

 // Keep this page stale until it submits; the server must preserve both versions.
 await page.route('**/api/workspace?**',route=>route.request().url().includes('since=')?route.fulfill({status:304}):route.continue());
 original=await chat('seed');await patch({chats:[{id:'seed',baseEtag:original._etag,chat:{...original.chat,title:'远端新标题'}}]});
 await page.locator('#prompt').fill('并发情况下继续写小说');await page.locator('#send').click();await page.getByText('模拟模型回答',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('#send')?.dataset.action==='send');await saved(page);
 const index=JSON.parse(await readFile(file,'utf8')),copy=index.data.chats.find(c=>c.id!=='seed');assert(copy);assert.match(copy.title,/冲突副本/);
 assert.equal((await chat('seed')).chat.title,'远端新标题');assert((await chat(copy.id)).chat.messages.some(m=>m.content==='模拟模型回答'));assert(sentAfterSave.every(Boolean));
 assert.equal((await record()).data.active,copy.id);await page.reload();await page.getByText('模拟模型回答',{exact:true}).waitFor();await connected(page);
 console.log('PASS concurrent send preserves the remote original and saves all output to a conflict copy before and after reload');

 await page.route('**/api/workspace',route=>route.request().method()==='PATCH'?route.fulfill({status:503,json:{error:'temporary storage failure'}}):route.continue());
 const requestsBefore=sentAfterSave.length;await page.locator('#prompt').fill('保存失败时先不要请求模型');await page.locator('#send').click();
 await page.waitForFunction(()=>document.querySelector('#storage-status')?.textContent.includes('保存失败'));assert.equal(sentAfterSave.length,requestsBefore);
 assert(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}));
 await page.unroute('**/api/workspace');await page.locator('#storage-status').click();await saved(page);
 console.log('PASS failed saves block model requests, retain the question, and enable the unsaved leave-page guard');

 await page.locator('[data-action="settings"]').click();await page.evaluate(()=>localStorage.setItem('lumen.presets',JSON.stringify([{name:'旧版小说预设',params:{temperature:.8}}])));
 await page.locator('[data-action="import-browser"]').click();await saved(page);await wait(async()=>(await record()).data.presets?.some(p=>p.name==='旧版小说预设'),'presets-only import');
 assert.equal(await page.evaluate(()=>localStorage.getItem('lumen.presets')),null);
 await context.close();await peerContext.close();
 console.log('PASS legacy browser presets can be imported independently of lumen.v1');

 await stop();privateAllowed=false;await start();
 const response=await fetch(url+'/api/relay',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({baseUrl:base,profileId:'one',path:'/v1/models'})});assert.equal(response.status,400);
 const denied=await fetch(url+'/api/workspace',{method:'PATCH',headers:{Origin:'https://other.test','Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
 assert.equal((await record()).data.profiles.length,2);assert.deepEqual(errors,[]);
 console.log('PASS restart keeps server data; LUMEN_ALLOW_PRIVATE=false and the configured public origin remain effective');
}finally{await browser?.close();await stop();mock.closeAllConnections();await new Promise(r=>mock.close(r));}
