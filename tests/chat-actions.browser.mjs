import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),qa=join(root,'work/chat-actions-qa');await mkdir(qa,{recursive:true});
const directory=await mkdtemp(join(qa,'data-')),streams=[];let browser,server,output='';
const mock=http.createServer(async(req,res)=>{
 let raw='';for await(const data of req)raw+=data;
 if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'chat-actions-model'}]}));return;}
 if(req.url==='/v1/chat/completions'){streams.push({response:res,payload:JSON.parse(raw)});res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return;}
 res.writeHead(404);res.end('{}');
});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url='http://127.0.0.1:'+port;
const wait=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(r=>setTimeout(r,40));}throw new Error('Timeout: '+label+'\n'+output);};
const record=async()=>(await(await fetch(url+'/api/workspace')).json());
const push=(stream,content,done=false)=>{const frame='data: '+JSON.stringify({choices:[{delta:{content},...(done?{finish_reason:'stop'}:{})}]})+'\n\n';if(done)stream.response.end(frame+'data: [DONE]\n\n');else stream.response.write(frame);};
try{
 server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_DATA_DIR:directory},windowsHide:true,stdio:'pipe'});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 await wait(async()=>{try{return(await fetch(url+'/health')).ok;}catch{return false;}},'startup');
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const mobile of [false,true]){
  streams.length=0;const label=mobile?'mobile':'desktop',first='第一条原始设定：保留换行与 <原文>。',extra='附加人物设定';
  const initial=[{id:'u0',role:'user',content:[{type:'text',text:first},{type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZFUAAAAASUVORK5CYII='}},{type:'text',text:extra}]},{id:'a0',role:'assistant',content:'历史回复。\n'.repeat(100)},{id:'u1',role:'user',content:'后来的用户问题'},{id:'a1',role:'assistant',content:'最后一条历史回复。\n'.repeat(100)}];
  const profile={id:'p',name:'Test connection',baseUrl:'http://127.0.0.1:'+mock.address().port,mode:'proxy'};
  const data={parameterPolicyVersion:1,profile,profiles:[profile],projects:[],active:'a',chats:[{id:'a',title:'小说 A',messages:initial,model:'chat-actions-model'},{id:'b',title:'小说 B',messages:[{id:'bu',role:'user',content:'B 的第一条消息'}],model:'chat-actions-model'}]};
  assert.equal((await fetch(url+'/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:(await record()).revision,data})})).status,200);
  const context=await browser.newContext({locale:'zh-CN',viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile});
  // Capture clipboard writes without changing the desktop user's clipboard.
  await context.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{(window.copiedTexts??=[]).push(text);}}}));
  const page=await context.newPage(),errors=[],reads=[];let downloads=0;page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('download',()=>downloads++);page.on('request',req=>{if(req.method()==='GET'&&req.url().includes('/api/chats/'))reads.push(req.url());});
  const sidebar=async()=>{if(mobile&&!await page.locator('#shell').evaluate(el=>el.classList.contains('show-sidebar')))await page.locator('[data-action="sidebar"]').click();};
  const closeSidebar=async()=>{if(mobile&&await page.locator('#shell').evaluate(el=>el.classList.contains('show-sidebar')))await page.locator('[data-action="close-drawers"]').click({position:{x:380,y:200}});};
  const open=async id=>{await sidebar();await page.locator('[data-chat="'+id+'"]').click();await page.waitForFunction(id=>document.querySelector('#conversation')?.dataset.chat===id,id);await closeSidebar();};
  const saved=()=>page.waitForFunction(()=>document.querySelector('#storage-status')?.textContent.includes('已保存到服务器'));
  const rename=async(id,title)=>{await sidebar();await page.locator('[data-rename-chat="'+id+'"]').click();await page.locator('#modal-input').fill(title);await page.locator('.modal [data-action="confirm"]').click();await wait(async()=>(await record()).data.chats.find(c=>c.id===id)?.title===title,'rename persisted');await saved();await closeSidebar();};
  const replyOffset=()=>page.locator('#messages>.message').last().evaluate(el=>el.getBoundingClientRect().top-document.querySelector('#conversation').getBoundingClientRect().top);
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));await saved();
  await page.locator('[data-action="copy-first-user"]').click();assert.equal(await page.evaluate(()=>window.copiedTexts.at(-1)),first+'\n'+extra);assert.equal(downloads,0);assert.equal(await page.locator('.topbar [data-action="export-chat"]').count(),0);
  const positions=await page.evaluate(()=>{const user=document.querySelector('#msg-u0'),assistant=document.querySelector('#msg-a0'),avatar=user.querySelector('.avatar').getBoundingClientRect(),other=assistant.querySelector('.avatar').getBoundingClientRect();return {userRight:avatar.right,rowRight:user.getBoundingClientRect().right,userLeft:avatar.left,assistantLeft:other.left};});
  assert(Math.abs(positions.userRight-positions.rowRight)<1);assert(positions.userLeft>positions.assistantLeft+100);
  await rename('b','未打开也能改名');assert.equal(await page.locator('#conversation').getAttribute('data-chat'),'a');assert(!reads.some(path=>path.endsWith('/api/chats/b')));
  await rename('a','第一章 · 自定义标题');assert.equal(await page.locator('#chat-title').textContent(),'第一章 · 自定义标题');
  await page.locator('#msg-u1').scrollIntoViewIfNeeded();await page.screenshot({path:join(qa,label+'-message-layout.png')});
  const longPrompt=('这是很长的新问题，要直接看到本次模型回复的开头。\n').repeat(100);await page.locator('#prompt').fill(longPrompt);await page.locator('#send').click();await wait(()=>streams.length===1,'model request');
  assert(Math.abs(await replyOffset()-20)<2,'Long prompt must not keep the viewport above the reply');const top=await page.locator('#conversation').evaluate(el=>el.scrollTop);
  push(streams[0],'新剧情的第一段。');await page.getByText('新剧情的第一段。',{exact:true}).waitFor();assert(Math.abs(await replyOffset()-20)<2);assert(Math.abs((await page.locator('#conversation').evaluate(el=>el.scrollTop))-top)<=1);
  await rename('a','生成期间也能改名');assert.equal(await page.locator('[data-chat="a"] .chat-generation-spinner').count(),1);
  await open('b');await page.locator('[data-action="copy-first-user"]').click();assert.equal(await page.evaluate(()=>window.copiedTexts.at(-1)),'B 的第一条消息');
  push(streams[0],'\n后续剧情继续。',true);await wait(async()=>await page.locator('[data-chat="a"] .chat-generation-spinner').count()===0,'completion');await saved();
  await open('a');await page.getByText('后续剧情继续。',{exact:false}).first().waitFor();assert.equal(await page.locator('#chat-title').textContent(),'生成期间也能改名');
  await page.locator('[data-action="copy-first-user"]').click();assert.equal(await page.evaluate(()=>window.copiedTexts.at(-1)),first+'\n'+extra);
  await page.screenshot({path:join(qa,label+'-conversation.png')});await page.reload();await page.getByText('后续剧情继续。',{exact:false}).first().waitFor();assert.equal(await page.locator('#chat-title').textContent(),'生成期间也能改名');
  const persisted=(await record()).data.chats.find(c=>c.id==='a');assert.deepEqual(persisted.messages[0].content,initial[0].content);assert.equal(persisted.messages.at(-2).content,longPrompt.trim());assert.match(persisted.messages.at(-1).content,/后续剧情继续/);
  await sidebar();await page.locator('[data-action="new-chat"]').click();await closeSidebar();const emptyId=await page.locator('#conversation').getAttribute('data-chat');await page.locator('[data-action="copy-first-user"]').click();await page.locator('#toast').filter({hasText:'当前对话没有用户消息'}).waitFor();
  await rename(emptyId,'空白时设置的名字');await page.locator('#prompt').fill('新对话的第一个问题');await page.locator('#send').click();await wait(()=>streams.length===2,'new chat model request');push(streams[1],'新对话的回答。',true);await saved();await wait(async()=>(await record()).data.chats.find(c=>c.id===emptyId)?.messages.at(-1)?.status==='complete','new reply persisted');assert.equal((await record()).data.chats.find(c=>c.id===emptyId).title,'空白时设置的名字');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);assert.equal(downloads,0);await context.close();
  console.log('PASS '+label+': first-user copy, right-side avatars, active/inactive/running renames, long-prompt reply positioning, persistence and empty chat');
 }
}finally{await browser?.close();for(const stream of streams)stream.response.destroy();if(server?.exitCode===null){const exit=once(server,'exit');server.kill();await exit;}mock.closeAllConnections();await new Promise(r=>mock.close(r));}
