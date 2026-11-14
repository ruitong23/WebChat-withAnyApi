import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {vertexBase,vertexModels} from '../src/vertex-express.js';

const root=fileURLToPath(new URL('../',import.meta.url)),qa=join(root,'work/vertex-qa');await mkdir(qa,{recursive:true});
const directory=await mkdtemp(join(qa,'data-')),requests=[],streams=[];let browser,server,output='';
const native=(text,finishReason,extra={})=>({candidates:[{index:0,content:{role:'model',parts:[{text}]},...(finishReason?{finishReason}:{})}],...extra});
const push=(response,value)=>response.write('data: '+JSON.stringify(value)+'\n\n');
const mock=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;const payload=raw?JSON.parse(raw):null;
 requests.push({path:req.url,key:req.headers['x-goog-api-key'],authorization:req.headers.authorization,payload});
 if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'existing-model'}]}));return;}
 if(req.url.startsWith('/v1/publishers/google/models/')){
  if(req.headers['x-goog-api-key']!=='test-vertex-key'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Invalid Express key'}}));return;}
  if(req.url.endsWith(':countTokens')){res.setHeader('Content-Type','application/json');if(req.url.includes('/'+vertexModels[0]+':')){res.statusCode=404;res.end(JSON.stringify({error:{message:'Publisher model not found'}}));}else res.end(JSON.stringify({totalTokens:1}));return;}
  if(req.url.endsWith(':generateContent')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(native('Non-streamed Vertex reply','STOP')));return;}
  if(req.url.endsWith(':streamGenerateContent?alt=sse')){streams.push(res);res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return;}
 }
 res.writeHead(404);res.end('{}');
});await new Promise(r=>mock.listen(0,'127.0.0.1',r));const mockURL='http://127.0.0.1:'+mock.address().port;
// Native calls go through the actual app relay and saved-key lookup, with only
// the final Google network hop redirected to our local fake upstream.
const preload=join(directory,'mock-vertex.mjs');await writeFile(preload,`const realFetch=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=new URL(input);if(url.hostname==='aiplatform.googleapis.com')return realFetch(${JSON.stringify(mockURL)}+url.pathname+url.search,options);return realFetch(input,options);};`);
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url='http://127.0.0.1:'+port;
const wait=async(check,label)=>{for(let i=0;i<300;i++){if(await check())return;await new Promise(r=>setTimeout(r,40));}throw new Error('Timeout: '+label+'\n'+output);};
const record=async()=>(await(await fetch(url+'/api/workspace')).json());
const disk=async()=>JSON.parse(await readFile(join(directory,'workspace.json'),'utf8'));
try{
 server=spawn(process.execPath,['--import',pathToFileURL(preload).href,'scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_DATA_DIR:directory},windowsHide:true,stdio:'pipe'});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 await wait(async()=>{try{return(await fetch(url+'/health')).ok;}catch{return false;}},'startup');browser=await chromium.launch({channel:'chrome',headless:true});
 for(const mobile of [false,true]){
  requests.length=0;streams.length=0;const label=mobile?'mobile':'desktop';
  for(const model of [vertexModels[0],'gemini-3-flash-preview']){const value=await(await fetch(url+'/api/model-config?'+new URLSearchParams({source:vertexBase,model}))).json();assert.equal((await fetch(url+'/api/model-config',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:vertexBase,model,revision:value.record.revision,patch:{stream:true}})})).status,200);}
  const profile={id:'old',name:'Existing API',baseUrl:mockURL,mode:'proxy',remember:true};const messages=[{id:'old-u',role:'user',content:'Original novel setting'},{id:'old-a',role:'assistant',content:'Original chapter'}];
  const data={parameterPolicyVersion:1,profile,profiles:[profile],keys:{old:'test-old-key'},chats:[{id:'novel',title:'Keep this novel',messages}],active:'novel',projects:[]};assert.equal((await fetch(url+'/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:(await record()).revision,data})})).status,200);
  const context=await browser.newContext({locale:mobile?'en-US':'zh-CN',viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile}),page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const connected=()=>page.waitForFunction(()=>/API 已连接|API connected/.test(document.querySelector('.statusbar')?.textContent||'')&&!/连接中|Connecting|正在获取|Fetching/.test(document.querySelector('#connection-result')?.textContent||''));
  const go=async section=>{if(mobile&&!await page.locator('#shell').evaluate(el=>el.classList.contains('show-sidebar')))await page.locator('[data-action="sidebar"]').click();await page.locator('[data-page="'+section+'"]').first().click();};
  const done=async status=>{await page.waitForFunction(()=>document.querySelector('[data-action="stop"]')===null);await wait(async()=>(await record()).data.chats[0].messages.at(-1)?.status===status,'saved '+status);};
  await page.goto(url);await connected();await go('connection');await page.locator('[data-action="new-profile"]').click();assert.match(await page.locator('[data-provider="google"]').textContent(),/AI Studio/);await page.screenshot({path:join(qa,label+'-provider-chooser.png')});await page.locator('[data-provider="vertex"]').click();
  assert.equal(await page.locator('#base-url').inputValue(),vertexBase);assert(await page.locator('#base-url').getAttribute('readonly')!==null);assert(await page.locator('#connection-mode').isDisabled());
  await page.locator('#api-key').fill('test-wrong-key');await page.locator('[data-action="discover"]').click();await page.locator('.connection-result.fail').waitFor();assert.match(await page.locator('#connection-result').textContent(),/401/);assert.equal(streams.length,0);
  await page.locator('#api-key').fill('test-vertex-key');await page.locator('[data-action="discover"]').click();await connected();await wait(async()=>(await record()).data.profiles.some(p=>p.provider==='vertex'&&p.hasKey),'key save');const vertex=(await record()).data.profiles.find(p=>p.provider==='vertex');
  assert.equal((await disk()).data.keys[vertex.id],'test-vertex-key');assert.equal((await disk()).data.keys.old,'test-old-key');assert(!JSON.stringify(await record()).includes('test-vertex-key'));assert(requests.some(r=>r.path.endsWith(':countTokens')));assert.equal(streams.length,0);assert.match(await page.locator('#connection-result').textContent(),/候选|candidate/i);
  assert.equal(await page.locator('#vertex-model-choice').inputValue(),'');assert.equal(await page.locator('#vertex-model-choice option:not([disabled])').count(),vertexModels.length-1);assert.equal(await page.locator('#vertex-model-choice option[value="'+vertexModels[0]+'"]').count(),0);await page.locator('#vertex-model-choice').selectOption(vertexModels[1]);
  await page.screenshot({path:join(qa,label+'-key-connected.png')});await go('chat');await page.locator('#prompt').fill('Continue my novel');await page.locator('#send').click();await wait(()=>streams.length===1,'native stream started');
  const sent=requests.find(r=>r.path.includes(':streamGenerateContent'));assert.equal(sent.key,'test-vertex-key');assert.equal(sent.authorization,undefined);assert.equal(sent.payload.contents[0].parts[0].text,'Original novel setting');assert.equal(sent.payload.contents[1].role,'model');assert.equal(sent.payload.generationConfig.maxOutputTokens,undefined);
  push(streams[0],{candidates:[{content:{parts:[{text:'Planning the next chapter.',thought:true}]}}]});push(streams[0],native('**Live Vertex reply**\n\nFirst paragraph.'));
  await page.locator('.message-content strong').filter({hasText:'Live Vertex reply'}).waitFor();assert.equal((await record()).data.chats[0].messages.at(-1).content,'');
  push(streams[0],native('\n\nSecond paragraph.','STOP',{usageMetadata:{promptTokenCount:20,candidatesTokenCount:12,thoughtsTokenCount:4,cachedContentTokenCount:8,totalTokenCount:36}}));streams[0].end();await done('complete');
  let saved=(await record()).data.chats[0].messages.at(-1);assert.equal(saved.reasoning,'Planning the next chapter.');assert.equal(saved.usage.completion_tokens,16);assert.equal(saved.usage.prompt_tokens_details.cached_tokens,8);assert.deepEqual((await record()).data.chats[0].messages.slice(0,2),messages);
  await page.reload();await connected();await page.getByText('Second paragraph.',{exact:false}).first().waitFor();await go('connection');assert.equal(await page.locator('#api-key').inputValue(),'');assert.equal(await page.locator('#base-url').inputValue(),vertexBase);assert.equal((await disk()).data.keys.old,'test-old-key');
  // Optional model override is persisted and is used for the key probe and chat.
  await page.locator('details.advanced summary').click();await page.locator('#vertex-model').fill('gemini-3-flash-preview');await page.locator('[data-action="discover"]').click();await connected();assert(requests.some(r=>r.path.includes('/gemini-3-flash-preview:countTokens')));await go('chat');
  await page.locator('#prompt').fill('A partial chapter');await page.locator('#send').click();await wait(()=>streams.length===2,'interrupted stream started');push(streams[1],native('Keep this partial chapter.'));streams[1].end();await done('interrupted');saved=(await record()).data.chats[0].messages.at(-1);assert.equal(saved.content,'Keep this partial chapter.');
  await page.locator('#prompt').fill('A stopped chapter');await page.locator('#send').click();await wait(()=>streams.length===3,'stopped stream started');push(streams[2],native('Stop this chapter here.'));await page.getByText('Stop this chapter here.',{exact:false}).first().waitFor();await page.locator('#send').click();await done('stopped');assert.equal((await record()).data.chats[0].messages.at(-1).content,'Stop this chapter here.');
  // Send one non-streaming request through the real persisted per-model config.
  await page.evaluate(async()=>{const source='https://aiplatform.googleapis.com',model='gemini-3-flash-preview';const value=await(await fetch('/api/model-config?'+new URLSearchParams({source,model}))).json();const result=await fetch('/api/model-config',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,model,revision:value.record.revision,patch:{stream:false}})});if(!result.ok)throw new Error('Config fixture failed');});
  await page.reload();await connected();await page.locator('#prompt').fill('One full answer');await page.locator('#send').click();await page.getByText('Non-streamed Vertex reply',{exact:false}).first().waitFor();await done('complete');assert(requests.some(r=>r.path.endsWith(':generateContent')));
  await page.reload();await connected();await go('connection');await page.locator('[data-action="delete-profile"]').click();await page.locator('.modal [data-action="confirm"]').click();await wait(async()=>(await record()).data.profiles.length===1,'vertex deletion');await connected();assert.equal((await disk()).data.keys[vertex.id],undefined);assert.equal((await disk()).data.keys.old,'test-old-key');assert.deepEqual((await record()).data.chats[0].messages.slice(0,2),messages);
  assert(!requests.some(r=>r.path.startsWith('/v1beta/openai')||r.path.includes('/projects/')||r.path.includes('key=')));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await context.close();console.log('PASS '+label+': key-only Express native auth, streaming, thoughts/usage, completion-only saves, interrupted/stopped replies, JSON output, reload and preserved original configuration');
 }
}finally{await browser?.close();for(const stream of streams)stream.destroy();if(server?.exitCode===null){const stopped=once(server,'exit');server.kill();await stopped;}mock.closeAllConnections();await new Promise(r=>mock.close(r));}
