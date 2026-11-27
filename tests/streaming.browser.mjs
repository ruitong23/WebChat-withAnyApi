import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),qa=join(root,'work/streaming-qa');await mkdir(qa,{recursive:true});
const directory=await mkdtemp(join(qa,'data-')),streams=[];let server,browser,output='';
const mock=http.createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c;
 if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'streaming-model'}]}));return;}
 if(req.url==='/v1/chat/completions'){streams.push(res);res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return;}
 res.writeHead(404);res.end('{}');
});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url='http://127.0.0.1:'+port;
const wait=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(r=>setTimeout(r,40));}throw new Error('Timeout: '+label+'\n'+output);};
const record=async()=>(await(await fetch(url+'/api/workspace')).json());
const send=(res,content,done=false)=>{const frame='data: '+JSON.stringify({choices:[{delta:{content},...(done?{finish_reason:'stop'}:{})}]})+'\n\n';if(done)res.end(frame+'data: [DONE]\n\n');else res.write(frame);};
const disk=async id=>{const index=JSON.parse(await readFile(join(directory,'workspace.json'),'utf8')),path=join(directory,index.data.chats.find(c=>c.id===id).path);return {chat:JSON.parse(await readFile(path,'utf8')),mtime:(await stat(path)).mtimeMs};};
try{
 server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_DATA_DIR:directory},windowsHide:true,stdio:'pipe'});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 await wait(async()=>{try{return(await fetch(url+'/health')).ok;}catch{return false;}},'startup');browser=await chromium.launch({channel:'chrome',headless:true});
 for(const mobile of [false,true]){
  streams.length=0;const label=mobile?'mobile':'desktop',now=Date.now(),profile={id:'p',name:'Mock API',baseUrl:'http://127.0.0.1:'+mock.address().port,mode:'proxy'};
  const chats=['a','b','c'].map((id,i)=>({id,title:'Chat '+id,created:now-20000,messages:[{id:id+'u',role:'user',content:'原始问题 '+id},{id:id+'a',role:'assistant',content:'旧回复 '+id,created:now-10000-i*1000,finishedAt:now-9000-i*1000,status:'complete'}],model:'streaming-model'}));
  assert.equal((await fetch(url+'/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:(await record()).revision,data:{parameterPolicyVersion:1,chats,projects:[],profile,profiles:[profile],active:'a'}})})).status,200);
  const context=await browser.newContext({locale:'zh-CN',viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile}),page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const sidebar=async()=>{if(mobile&&!await page.locator('#shell').evaluate(el=>el.classList.contains('show-sidebar')))await page.locator('[data-action="sidebar"]').click();};
  const open=async id=>{await sidebar();await page.locator('button[data-chat="'+id+'"]').click();await page.waitForFunction(id=>document.querySelector('#conversation')?.dataset.chat===id,id);};
  const saved=()=>page.waitForFunction(()=>document.querySelector('#storage-status')?.textContent.includes('已保存到服务器'));
  const order=()=>page.locator('#chat-list button[data-chat]').evaluateAll(rows=>rows.map(row=>row.dataset.chat));
  const body=()=>page.locator('#messages>.message').last().locator('.message-content');
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));await saved();assert.deepEqual(await order(),['a','b','c']);
  await open('c');await saved();assert.deepEqual(await order(),['a','b','c']);await open('b');await saved();assert.deepEqual(await order(),['a','b','c']);
  await page.locator('#prompt').fill('请按格式输出');await page.locator('#send').click();await wait(()=>streams.length===1,'request');const before=await disk('b');assert.equal(before.chat.messages.at(-1).content,'');
  const markdown='# 实时标题\n**加粗正文** 与 *斜体* 和 `**代码原文**`。\n- 条目一\n- 条目二\n> 引用内容\n```js\nconst text = "<tag>";\n';
  send(streams[0],markdown);await body().locator('strong').filter({hasText:'加粗正文'}).waitFor();assert.equal(await body().locator('h1').textContent(),'实时标题');assert.equal(await body().locator('em').textContent(),'斜体');assert.equal(await body().locator('p code').textContent(),'**代码原文**');assert.match(await body().locator('pre code').textContent(),/<tag>/);assert.equal((await disk('b')).mtime,before.mtime);
  await sidebar();await page.locator('[data-rename-chat="a"]').click();await page.locator('#modal-input').fill('仅修改标题');await page.locator('.modal [data-action="confirm"]').click();await saved();
  await open('c');await saved();assert.deepEqual(await order(),['a','b','c']);assert.equal((await disk('b')).chat.messages.at(-1).content,'','Unrelated saves must not include an unfinished reply');assert.equal((await disk('b')).mtime,before.mtime);
  await open('b');await saved();await page.evaluate(()=>{const body=document.querySelector('#messages>.message:last-child .message-content');window.retainedStrong=body.querySelector('strong');window.retainedCode=body.querySelector('pre');});
  await page.waitForTimeout(220);send(streams[0],'```\n后续 **仍然加粗**。\n<img src=x onerror="window.injected=true">');await body().locator('strong').filter({hasText:'仍然加粗'}).waitFor();
  assert(await page.evaluate(()=>document.querySelector('#messages>.message:last-child strong')===window.retainedStrong));assert(await page.evaluate(()=>document.querySelector('#messages>.message:last-child pre')===window.retainedCode));assert.equal(await page.evaluate(()=>!!window.injected),false);assert.equal(await body().locator('img').count(),0);
  const html=await body().innerHTML(),geometry=await body().evaluate(el=>({height:el.getBoundingClientRect().height,top:document.querySelector('#conversation').scrollTop}));
  await page.evaluate(()=>{window.bodyChanges=0;window.bodyObserver=new MutationObserver(records=>{window.bodyChanges+=records.length;});window.bodyObserver.observe(document.querySelector('#messages>.message:last-child .message-content'),{childList:true,characterData:true,subtree:true});});
  await sidebar();await page.screenshot({path:join(qa,label+'-formatted-stream.png')});send(streams[0],'',true);await wait(async()=>await page.locator('[data-chat="b"] .chat-generation-spinner').count()===0,'completed');await saved();
  assert.equal(await body().innerHTML(),html);assert.equal(await page.evaluate(()=>window.bodyChanges),0,'Completion must not reformat the entire response');assert.equal(await body().evaluate(el=>el.getBoundingClientRect().height),geometry.height);assert(Math.abs((await page.locator('#conversation').evaluate(el=>el.scrollTop))-geometry.top)<=1);
  const completed=await disk('b');assert.equal(completed.chat.messages.at(-1).content,markdown+'```\n后续 **仍然加粗**。\n<img src=x onerror="window.injected=true">');assert.equal(completed.chat.messages.at(-1).status,'complete');assert.deepEqual(await order(),['b','a','c']);
  await open('c');await saved();assert.deepEqual(await order(),['b','a','c']);await page.locator('#prompt').fill('中途停止');await page.locator('#send').click();await wait(()=>streams.length===2,'stop request');send(streams[1],'停止之前的 **内容**');await body().locator('strong').waitFor();assert.equal((await disk('c')).chat.messages.at(-1).content,'');await page.locator('#send').click();await saved();await wait(async()=>(await disk('c')).chat.messages.at(-1).status==='stopped','stopped save');await wait(async()=>await page.locator('[data-chat="c"] .chat-generation-spinner').count()===0,'stop reflected');assert.match((await disk('c')).chat.messages.at(-1).content,/停止之前/);assert.deepEqual(await order(),['c','b','a']);
  await page.locator('#prompt').fill('测试连接中断');await page.locator('#send').click();await wait(()=>streams.length===3,'interrupted request');send(streams[2],'断开前的 **内容**');await body().locator('strong').waitFor();assert.equal((await disk('c')).chat.messages.at(-1).content,'');streams[2].end();await wait(async()=>(await disk('c')).chat.messages.at(-1).status==='interrupted','interrupted save');await wait(async()=>await page.locator('[data-chat="c"] .chat-generation-spinner').count()===0,'interruption reflected');assert.match((await disk('c')).chat.messages.at(-1).content,/断开前/);
  await page.reload();await page.locator('#messages>.message').last().locator('strong').waitFor();assert.deepEqual(await order(),['c','b','a']);assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await context.close();
  console.log('PASS '+label+': no partial disk writes, live Markdown, stable DOM/layout at completion, safe rendering, terminal saves and output-time sorting');
 }
}finally{await browser?.close();for(const response of streams)response.destroy();if(server?.exitCode===null){const exit=once(server,'exit');server.kill();await exit;}mock.closeAllConnections();await new Promise(r=>mock.close(r));}
