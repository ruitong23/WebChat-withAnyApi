import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const captures=new URL('../work/scroll-qa/',import.meta.url);
await mkdir(captures,{recursive:true});
let stream;
const upstream=http.createServer(async(req,res)=>{
 for await(const chunk of req){};
 res.setHeader('Content-Type','application/json');
 if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'scroll-test'}]}));
 if(req.url==='/v1/chat/completions'){
  res.setHeader('Content-Type','text/event-stream');res.flushHeaders();stream=res;return;
 }
 res.statusCode=404;res.end('{}');
});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_CONFIG_FILE:fileURLToPath(new URL('model-configs.json',captures)),LUMEN_WORKSPACE_FILE:fileURLToPath(new URL('workspace.json',captures))},windowsHide:true,stdio:'pipe'});
let browser,output='';server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
const url=`http://127.0.0.1:${port}`;
const seed={parameterPolicyVersion:1,active:'history',profile:{name:'Scroll QA',baseUrl:`http://127.0.0.1:${upstream.address().port}`,mode:'proxy'},chats:[
 {id:'history',title:'历史滚动测试',model:'scroll-test',messages:Array.from({length:4},(_,i)=>[
  {id:`u${i}`,role:'user',content:`第 ${i+1} 个问题`},
  {id:`a${i}`,role:'assistant',content:('这是保留的历史回答，方便验证长对话中的阅读位置。\n').repeat(60)}
 ]).flat()},
 {id:'other',title:'另一段对话',messages:[{id:'other-u',role:'user',content:'另一段对话的问题'},{id:'other-a',role:'assistant',content:'另一段对话的回答。'}]}
]};
const position=page=>page.locator('#conversation').evaluate(c=>({top:c.scrollTop,gap:c.scrollHeight-c.scrollTop-c.clientHeight}));
const settled=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const stable=async(page,top,label)=>{await settled(page);const actual=await position(page);assert(Math.abs(actual.top-top)<=1,`${label}: expected top ${top}, actual ${JSON.stringify(actual)}`);};
const lastAnswerVisible=page=>page.evaluate(()=>{
 const c=document.querySelector('#conversation'),m=document.querySelector('#msg-a3');
 return Math.abs(m.getBoundingClientRect().top-c.getBoundingClientRect().top-20)<=1;
});
try{
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(url+'/health')).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,50));}
 assert(ready,output);
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const mobile of [false,true]){
  const label=mobile?'mobile':'desktop',errors=[];
  const context=await browser.newContext({locale:'zh-CN',viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile});
  const existing=await (await fetch(url+'/api/workspace')).json();
  const seeded=await fetch(url+'/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:existing.revision,data:seed})});assert.equal(seeded.status,200);
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));
  assert(await lastAnswerVisible(page),'Opening history must align the last model answer');
  assert((await position(page)).gap>100,'Opening history must not jump to the answer bottom');
  await page.screenshot({path:fileURLToPath(new URL(label+'-history.png',captures))});
  const readingTop=(await position(page)).top;
  if(mobile)await page.locator('[data-action="sidebar"]').click();
  await page.locator('[data-action="theme"]').click();await stable(page,readingTop,'Theme rerender must retain reading position');
  if(mobile)await page.locator('[data-action="sidebar"]').click();
  await page.locator('[data-chat="other"]').click();await page.waitForFunction(()=>document.querySelector('#conversation')?.dataset.chat==='other');
  if(mobile)await page.locator('[data-action="sidebar"]').click();
  await page.locator('[data-chat="history"]').click();await page.waitForFunction(()=>document.querySelector('#conversation')?.dataset.chat==='history');assert(await lastAnswerVisible(page),'Switching chats must locate the last model answer');
  await page.reload();await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));
  assert(await lastAnswerVisible(page),'Reload must locate the last model answer');

  stream=null;await page.locator('#prompt').fill('请持续生成一段长回答');await page.locator('#send').click();
  for(let i=0;!stream&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,20));assert(stream,'SSE request started');
  let sequence=0;
  const push=async()=>{
   await page.waitForTimeout(210);const marker=`输出片段 ${++sequence}`;
   stream.write('data: '+JSON.stringify({choices:[{delta:{content:(marker+'，这里是持续增长的回答内容。\n').repeat(30)}}]})+'\n\n');
   await page.waitForFunction(marker=>document.querySelector('.message:last-child .message-content')?.textContent.includes(marker),marker);
   await settled(page);
  };
  const initialTop=(await position(page)).top;
  await push();await push();await stable(page,initialTop,'New output must not enable following by itself');
  const conversation=page.locator('#conversation');await conversation.focus();await page.keyboard.press('End');
  await page.waitForFunction(()=>{const c=document.querySelector('#conversation');return c.scrollHeight-c.scrollTop-c.clientHeight<=1;});
  await push();assert((await position(page)).gap<=1,'Actively returning to bottom must enable following');

  if(mobile){
   const box=await conversation.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
   const cdp=await context.newCDPSession(page);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+35}]});
   await page.waitForTimeout(150);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }else{
   const box=await conversation.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-8);
  }
  await page.waitForFunction(()=>{const c=document.querySelector('#conversation'),gap=c.scrollHeight-c.scrollTop-c.clientHeight;return gap>1&&gap<100;});
  await page.waitForTimeout(250);const pausedTop=(await position(page)).top;
  await push();await stable(page,pausedTop,'A small upward gesture must immediately stop following');
  if(mobile)await page.locator('[data-action="sidebar"]').click();
  await page.locator('[data-action="theme"]').click();await stable(page,pausedTop,'Rerender must preserve paused following');
  await push();await stable(page,pausedTop,'Rerender must not re-enable following');
  await page.screenshot({path:fileURLToPath(new URL(label+'-paused.png',captures))});

  await conversation.focus();await page.keyboard.press('End');
  await page.waitForFunction(()=>{const c=document.querySelector('#conversation');return c.scrollHeight-c.scrollTop-c.clientHeight<=1;});
  await push();assert((await position(page)).gap<=1,'Following must resume after intentionally reaching bottom');
  await page.keyboard.press('ArrowUp');await page.waitForFunction(()=>{const c=document.querySelector('#conversation');return c.scrollHeight-c.scrollTop-c.clientHeight>1;});
  await page.waitForTimeout(200);const keyboardTop=(await position(page)).top;
  await push();await stable(page,keyboardTop,'Keyboard upward scrolling must stop following');
  stream.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  await page.waitForFunction(()=>document.querySelector('#send')?.dataset.action==='send');
  await stable(page,keyboardTop,'Completing and formatting the answer must not jump to bottom');
  await page.waitForFunction(()=>document.querySelector('#storage-status')?.textContent.includes('已保存到服务器'));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal page overflow');
  assert.deepEqual(errors,[]);await context.close();console.log('PASS '+label+': history, reload, chat switch, streaming pause/resume, rerender, keyboard, completion');
 }
}finally{
 await browser?.close();stream?.destroy();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
 if(server.exitCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
}
