import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {googleBase} from '../src/relay.js';

const root=fileURLToPath(new URL('../',import.meta.url)),qa=join(root,'work/connections-qa');await mkdir(qa,{recursive:true});
const directory=await mkdtemp(join(qa,'data-')),requests=[],streams=[];let browser,server,output='';
const mock=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 requests.push({path:req.url,authorization:req.headers.authorization,payload:raw?JSON.parse(raw):null});
 if(req.url==='/v1/models'||req.url==='/v1beta/openai/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:req.url.startsWith('/v1beta')?'gemini-test':'existing-model'}]}));return;}
 if(req.url==='/v1beta/openai/chat/completions'){streams.push(res);res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return;}
 res.writeHead(404);res.end('{}');
});await new Promise(r=>mock.listen(0,'127.0.0.1',r));const mockURL='http://127.0.0.1:'+mock.address().port;
// Redirect only Google's upstream traffic inside the test server. No real API
// calls, credentials or paid model requests are used by this test.
const preload=join(directory,'mock-google.mjs');await writeFile(preload,`const realFetch=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=new URL(input);if(url.hostname==='generativelanguage.googleapis.com')return realFetch(${JSON.stringify(mockURL)}+url.pathname,options);return realFetch(input,options);};`);
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url='http://127.0.0.1:'+port;
const wait=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(r=>setTimeout(r,40));}throw new Error('Timeout: '+label+'\n'+output);};
const record=async()=>(await(await fetch(url+'/api/workspace')).json());
const disk=async()=>JSON.parse(await readFile(join(directory,'workspace.json'),'utf8'));
try{
 server=spawn(process.execPath,['--import',pathToFileURL(preload).href,'scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_DATA_DIR:directory},windowsHide:true,stdio:'pipe'});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 await wait(async()=>{try{return(await fetch(url+'/health')).ok;}catch{return false;}},'startup');browser=await chromium.launch({channel:'chrome',headless:true});
 for(const mobile of [false,true]){
  requests.length=0;streams.length=0;const label=mobile?'mobile':'desktop';
  const profile={id:'existing',name:'Existing API',baseUrl:mockURL,mode:'proxy',remember:true};
  const original={id:'kept',title:'Keep this chat',messages:[{id:'u',role:'user',content:'Existing story setting'},{id:'a',role:'assistant',content:'Existing story text'}]};
  const data={parameterPolicyVersion:1,profile,profiles:[profile],keys:{existing:'test-existing'},chats:[original],active:'kept',projects:[]};
  assert.equal((await fetch(url+'/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:(await record()).revision,data})})).status,200);
  const context=await browser.newContext({locale:mobile?'en-US':'zh-CN',viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile}),page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const go=async section=>{if(mobile&&!await page.locator('#shell').evaluate(el=>el.classList.contains('show-sidebar')))await page.locator('[data-action="sidebar"]').click();await page.locator('[data-page="'+section+'"]').first().click();};
  const connected=()=>page.waitForFunction(()=>/API 已连接|API connected/.test(document.querySelector('.statusbar')?.textContent||''));
  await page.goto(url);await connected();await go('connection');assert.equal(await page.locator('[data-action="delete-profile"]').count(),1);
  await page.locator('[data-action="new-profile"]').click();await page.locator('[data-provider="google"]').waitFor();await page.locator('[data-action="close-modal"]').click();assert.equal(await page.locator('#connection-name').inputValue(),'Existing API');
  await page.locator('[data-action="new-profile"]').click();await page.locator('[data-provider="openai"]').click();assert.equal(await page.locator('#base-url').inputValue(),'https://api.openai.com/v1');assert.equal(await page.locator('#api-key').inputValue(),'');assert.equal(await page.locator('[data-action="delete-profile"]').count(),0);
  await page.locator('[data-profile="existing"]').click();await connected();await page.locator('[data-action="new-profile"]').click();await page.locator('[data-provider="google"]').click();
  assert.equal(await page.locator('#base-url').inputValue(),googleBase);assert.equal(await page.locator('#api-key').inputValue(),'');
  await page.locator('#api-key').fill('test-google-secret');await page.locator('[data-action="discover"]').click();await connected();
  await wait(async()=>(await record()).data.profiles.some(p=>p.name==='Google Gemini'&&p.hasKey),'Google connection saved');const google=(await record()).data.profiles.find(p=>p.name==='Google Gemini');
  assert.equal((await disk()).data.keys[google.id],'test-google-secret');assert(!JSON.stringify(await record()).includes('test-google-secret'));
  assert(requests.some(r=>r.path==='/v1beta/openai/models'&&r.authorization==='Bearer test-google-secret'));assert(!requests.some(r=>r.path.includes('openai/v1/')||r.path.includes('openai/api/')));
  await page.screenshot({path:join(qa,label+'-google-connection.png')});
  await go('chat');await page.locator('#prompt').fill('Continue the story using Gemini');await page.locator('#send').click();await wait(()=>streams.length===1,'Google chat');
  const sent=requests.find(r=>r.path==='/v1beta/openai/chat/completions');assert.equal(sent.authorization,'Bearer test-google-secret');assert.equal(sent.payload.model,'gemini-test');assert.equal(sent.payload.stream,true);assert(sent.payload.messages.some(m=>m.content==='Existing story setting'));
  streams[0].end('data: '+JSON.stringify({choices:[{delta:{content:'**Gemini streamed reply**'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  await page.locator('.message-content strong').filter({hasText:'Gemini streamed reply'}).waitFor();await wait(async()=>(await record()).data.chats[0].messages.at(-1)?.status==='complete','reply saved');
  await go('connection');await page.reload();await connected();await go('connection');assert.equal(await page.locator('#api-key').inputValue(),'');assert.match(await page.locator('#api-key').getAttribute('placeholder'),/Saved on server|已保存在服务器/);
  await page.locator('[data-action="delete-profile"]').click();await page.locator('.modal [data-action="close-modal"]').first().click();assert((await record()).data.profiles.some(p=>p.id===google.id));
  await page.locator('[data-action="delete-profile"]').click();await page.locator('.modal [data-action="confirm"]').click();await wait(async()=>(await record()).data.profiles.length===1,'Google deletion');await connected();assert.equal((await disk()).data.keys[google.id],undefined);assert.equal((await disk()).data.keys.existing,'test-existing');
  const kept=(await record()).data.chats[0];assert.deepEqual(kept.messages.slice(0,2),original.messages);assert.match(kept.messages.at(-1).content,/Gemini streamed reply/);
  await page.reload();await connected();await go('connection');assert.equal(await page.locator('.profile-tab').count(),1);assert.equal(await page.locator('#connection-name').inputValue(),'Existing API');
  // The optional browser-direct mode uses the same Google URL adapter.
  await page.locator('[data-action="new-profile"]').click();await page.locator('[data-provider="google"]').click();await page.locator('#remember-key').uncheck();await page.locator('#connection-mode').selectOption('direct');await page.locator('#api-key').fill('test-direct-google');let direct=0;
  await page.route('https://generativelanguage.googleapis.com/**',async route=>{assert.equal(route.request().url(),googleBase+'/models');assert.equal(route.request().headers().authorization,'Bearer test-direct-google');direct++;await route.fulfill({status:200,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},body:JSON.stringify({data:[{id:'gemini-direct-test'}]})});});
  await page.locator('[data-action="discover"]').click();await connected();assert(direct>0);const directProfile=(await record()).data.profiles.find(p=>p.name==='Google Gemini');assert(!directProfile.hasKey);assert.equal((await disk()).data.keys[directProfile.id],'');
  await page.locator('[data-action="delete-profile"]').click();await page.locator('.modal [data-action="confirm"]').click();await wait(async()=>(await record()).data.profiles.length===1,'direct deletion');await connected();
  await page.locator('[data-action="delete-profile"]').click();await page.locator('.modal [data-action="confirm"]').click();await wait(async()=>(await record()).data.profiles.length===0,'last connection deletion');assert.deepEqual((await disk()).data.keys,{});assert.equal((await record()).data.profile.baseUrl,'');
  await page.reload();await page.locator('#msg-u').waitFor();await go('connection');assert.equal(await page.locator('#base-url').inputValue(),'');assert.equal(await page.locator('[data-action="delete-profile"]').count(),0);
  if(mobile){const text=await page.locator('#main-page').innerText();assert(!/\p{Script=Han}/u.test(text),text);await page.locator('[data-action="new-profile"]').click();assert(!/\p{Script=Han}/u.test(await page.locator('.modal').innerText()));await page.locator('[data-action="close-modal"]').click();}
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await context.close();console.log('PASS '+label+': provider chooser, official Google discovery/streaming, saved-key reload, direct mode, delete/cancel/fallback and preserved chats');
 }
}finally{await browser?.close();for(const stream of streams)stream.destroy();if(server?.exitCode===null){const stopped=once(server,'exit');server.kill();await stopped;}mock.closeAllConnections();await new Promise(r=>mock.close(r));}
