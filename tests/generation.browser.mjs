import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),qa=join(root,'work/generation-qa');await mkdir(qa,{recursive:true});
const directory=await mkdtemp(join(qa,'data-')),requests=new Map();let browser,server,output='';
const mock=http.createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c;
 if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'model-one'},{id:'model-two'}]}));return;}
 if(req.url==='/v1/chat/completions'){
  const payload=JSON.parse(raw),key=payload.messages.at(-1).content;
  const request={payload,auth:req.headers.authorization,response:res,closed:false};requests.set(key,request);res.on('close',()=>{request.closed=true;});
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:key+' 第一段。\n'}}]})+'\n\n');return;
 }
 res.writeHead(404);res.end('{}');
});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const url='http://127.0.0.1:'+port,base='http://127.0.0.1:'+mock.address().port;
const wait=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(r=>setTimeout(r,40));}throw new Error('Timeout: '+label+'\n'+output);};
const record=async()=>(await(await fetch(url+'/api/workspace')).json());
const chunk=(key,text)=>requests.get(key).response.write('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n');
const finish=key=>requests.get(key).response.end('data: '+JSON.stringify({choices:[{delta:{content:key+' 最后一段。'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
try{
 server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_DATA_DIR:directory},windowsHide:true,stdio:'pipe'});
 server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 await wait(async()=>{try{return(await fetch(url+'/health')).ok;}catch{return false;}},'server startup');
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const mobile of [false,true]){
  requests.clear();const label=mobile?'mobile':'desktop',profile={id:'p1',name:'Connection one',baseUrl:base,mode:'proxy',remember:true},project={id:'project',name:'Archive'};
  const messages=Array.from({length:3},(_,i)=>[{id:'u'+i,role:'user',content:'历史问题 '+i},{id:'a'+i,role:'assistant',model:'model-one',content:('历史模型回复 '+i+'\n\n').repeat(70)}]).flat();
  const data={parameterPolicyVersion:1,chats:[{id:'a',title:'Conversation A',messages,model:'model-one'},{id:'b',title:'Conversation B',messages:[{id:'bu',role:'user',content:'B 的历史'}],model:'model-one'}],projects:[project],profile,profiles:[profile,{...profile,id:'p2',name:'Connection two'}],keys:{p1:'key-one',p2:'key-two'},active:'a'};
  const revision=(await record()).revision;assert.equal((await fetch(url+'/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,data})})).status,200);
  const context=await browser.newContext({locale:'zh-CN',viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  const sidebar=async()=>{if(mobile&&!(await page.locator('#shell').getAttribute('class')).includes('show-sidebar'))await page.locator('[data-action="sidebar"]').click();};
  const open=async id=>{await sidebar();await page.locator('button[data-chat="'+id+'"]').click();await page.waitForFunction(id=>document.querySelector('#conversation')?.dataset.chat===id,id);if(mobile&&await page.locator('#shell').evaluate(el=>el.classList.contains('show-sidebar')))await page.locator('[data-action="close-drawers"]').click({position:{x:380,y:200}});};
  const saved=()=>page.waitForFunction(()=>document.querySelector('#storage-status')?.textContent.includes('已保存到服务器'));
  const spinner=id=>page.locator('button[data-chat="'+id+'"] .chat-generation-spinner');
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));await saved();
  const offset=await page.locator('#msg-a2').evaluate(el=>el.getBoundingClientRect().top-document.querySelector('#conversation').getBoundingClientRect().top);assert(Math.abs(offset-20)<2);
  await page.locator('#prompt').fill('A-output');await page.locator('#send').click();await wait(()=>requests.has('A-output'),'A request');assert.equal(await spinner('a').count(),1);
  await open('b');await page.locator('#prompt').fill('B 的草稿');chunk('A-output','A 在后台继续生成。\n');
  await open('a');await page.getByText('A 在后台继续生成。',{exact:false}).first().waitFor();assert.equal(await page.locator('#send').getAttribute('data-action'),'stop');
  await open('b');assert.equal(await page.locator('#prompt').inputValue(),'B 的草稿');await page.locator('#prompt').fill('B-output');await page.locator('#send').click();await wait(()=>requests.has('B-output'),'B concurrent request');
  assert.equal(await spinner('a').count(),1);assert.equal(await spinner('b').count(),1);
  assert.equal(await spinner('a').evaluate(el=>getComputedStyle(el).animationName),'spin');
  await sidebar();await page.screenshot({path:join(qa,label+'-generating.png')});if(mobile)await page.locator('[data-action="close-drawers"]').click({position:{x:380,y:200}});
  await open('a');await page.locator('[data-action="move-chat"]').click();await page.locator('#move-project').selectOption(project.id);await page.locator('.modal [data-action="confirm"]').click();await saved();await open('b');
  await page.locator('#prompt').fill('B 的下一条草稿');finish('A-output');await wait(async()=>await spinner('a').count()===0,'A spinner ends');
  assert.equal(await spinner('b').count(),1);assert.equal(await page.locator('#send').getAttribute('data-action'),'stop');assert.equal(await page.locator('#prompt').inputValue(),'B 的下一条草稿');assert.equal(requests.get('B-output').closed,false);
  assert(!(await page.locator('#conversation').textContent()).includes('A 在后台继续生成'));
  console.log('PASS '+label+': opens at last assistant, independent concurrent streams, drafts and sidebar spinners');

  await sidebar();await page.locator('[data-action="new-chat"]').click();const newId=await page.locator('#conversation').getAttribute('data-chat');assert(!['a','b'].includes(newId));
  await sidebar();await page.locator('[data-page="connection"]').first().click();await page.locator('[data-profile="p2"]').click();await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));
  await sidebar();await page.locator('[data-page="chat"]').first().click();
  await page.locator('[data-action="pick-model"]').first().click();await page.locator('[data-pick="model-two"]').click();
  await page.locator('#prompt').fill('C-output');await page.locator('#send').click();await wait(()=>requests.has('C-output'),'C on other connection');
  assert.equal(requests.get('C-output').auth,'Bearer key-two');assert.equal(requests.get('C-output').payload.model,'model-two');assert.equal(requests.get('B-output').auth,'Bearer key-one');assert.equal(requests.get('B-output').payload.model,'model-one');
  await open('b');await page.locator('#send').click();await wait(()=>requests.get('B-output').closed,'stop B only');await wait(async()=>await spinner('b').count()===0,'B spinner stops');assert.equal(requests.get('C-output').closed,false);assert.equal(await spinner(newId).count(),1);
  await sidebar();await page.locator('[data-action="settings"]').click();await page.locator('.page-title').filter({hasText:'设置'}).waitFor();chunk('C-output','C 在设置页面期间继续。\n');finish('C-output');await wait(async()=>await spinner(newId).count()===0,'C completes offscreen');
  assert.match(await page.locator('.page-title').textContent(),/设置/);
  await open(newId);await page.getByText('C 在设置页面期间继续。',{exact:false}).first().waitFor();await saved();
  const persisted=await record(),a=persisted.data.chats.find(c=>c.id==='a'),b=persisted.data.chats.find(c=>c.id==='b'),c=persisted.data.chats.find(c=>c.id===newId);
  assert(a.messages.at(-1).content.includes('A 在后台继续生成'));assert.equal(a.messages.at(-1).status,'complete');assert.equal(a.projectId,project.id);assert.equal(b.messages.at(-1).status,'stopped');assert(!b.messages.at(-1).content.includes('C-output'));assert.equal(c.messages.at(-1).status,'complete');assert.equal(c.messages.at(-1).model,'model-two');
  await open('a');await page.locator('#prompt').fill('D-output');await page.locator('#send').click();await wait(()=>requests.has('D-output'),'D request');await open('b');
  const original=await(await fetch(url+'/api/chats/a')).json();
  assert.equal((await fetch(url+'/api/workspace',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({changes:{chats:[{id:'a',baseEtag:original._etag,chat:{...original.chat,title:'Remote original'}}]}})})).status,200);
  await page.waitForTimeout(220);chunk('D-output','D 在后台冲突后继续。');
  let copy;await wait(async()=>{copy=(await record()).data.chats.find(chat=>chat.id!=='a'&&chat.id!=='b'&&chat.id!==newId);return !!copy;},'background conflict copy');
  await wait(async()=>await spinner(copy.id).count()===1,'spinner follows conflict copy');await open(copy.id);await page.getByText('D 在后台冲突后继续。',{exact:false}).first().waitFor();
  await page.locator('#send').click();await wait(()=>requests.get('D-output').closed,'stop remapped task');await saved();assert.equal((await(await fetch(url+'/api/chats/a')).json()).chat.title,'Remote original');
  await open(newId);
  await page.reload();await page.getByText('C 在设置页面期间继续。',{exact:false}).first().waitFor();assert.equal(await page.locator('.chat-generation-spinner').count(),0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await page.screenshot({path:join(qa,label+'-completed.png')});await context.close();
  console.log('PASS '+label+': new chat, connection/model changes, stop isolation, offscreen completion, moves, conflict copies, disk save and reload');
 }
}finally{await browser?.close();for(const request of requests.values())request.response.destroy();if(server?.exitCode===null){const exit=once(server,'exit');server.kill();await exit;}mock.closeAllConnections();await new Promise(r=>mock.close(r));}
