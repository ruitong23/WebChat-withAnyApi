import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),qa=join(root,'work/rendering-qa');await mkdir(qa,{recursive:true});
const directory=await mkdtemp(join(qa,'data-')),streams=[];let server,browser,output='';
const mock=http.createServer(async(req,res)=>{
 for await(const chunk of req){};
 if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'rendering-model'}]}));return;}
 if(req.url==='/v1/chat/completions'){streams.push(res);res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return;}
 res.writeHead(404);res.end('{}');
});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url='http://127.0.0.1:'+port;
const wait=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(r=>setTimeout(r,40));}throw new Error('Timeout: '+label+'\n'+output);};
const record=async()=>(await(await fetch(url+'/api/workspace')).json());
const send=(content,done=false)=>{const frame='data: '+JSON.stringify({choices:[{delta:{content},...(done?{finish_reason:'stop'}:{})}]})+'\n\n';if(done)streams.at(-1).end(frame+'data: [DONE]\n\n');else streams.at(-1).write(frame);};
const original=String.raw`$\text{距离拉近} \rightarrow \text{身体接触（例如手掌抵住胸膛）}$

2\. $\text{施压} \rightarrow \text{男主后退} \rightarrow \text{后背撞击墙壁的物理反馈（震动、冰冷感）}$

3\. $\text{重心转移} \rightarrow \text{阿莉雅单腿微抬/跨步}$

4\. $\text{高度差调整} \rightarrow \text{臀部与大腿的接触点落实}$

5\. $\text{最终压制状态地达成}$。

行内 \(x^2+1\)，与 **加粗正文**。

\[
\frac{a+b}{c}=\sqrt{x}
\]

| 人物 | 特征 |
| --- | --- |
| 阿莉雅 | 勇敢 |

代码保持原样：`+'`$\\text{原始代码}$`'+'\n\n$$\\begin{matrix}'+Array.from({length:30},(_,i)=>'x_{'+i+'}').join('&')+'\\end{matrix}$$';
try{
 server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_DATA_DIR:directory},windowsHide:true,stdio:'pipe'});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 await wait(async()=>{try{return(await fetch(url+'/health')).ok;}catch{return false;}},'startup');browser=await chromium.launch({channel:'chrome',headless:true});
 const manifest=JSON.parse(await readFile(join(root,'src/vendor/manifest.json'),'utf8'));
 for(const [asset,mime] of Object.entries(manifest)){const response=await fetch(url+'/vendor/'+asset);assert.equal(response.status,200,asset);assert.equal(response.headers.get('content-type'),mime);assert.deepEqual(Buffer.from(await response.arrayBuffer()),await readFile(join(root,'src/vendor',asset)));}
 for(const path of ['/vendor/README.md','/vendor/manifest.json','/data/workspace.json','/vendor/%2e%2e%2fshared-store.mjs'])assert.equal((await fetch(url+path)).status,404);
 for(const mobile of [false,true]){
  const now=Date.now(),profile={id:'p',name:'Mock API',baseUrl:'http://127.0.0.1:'+mock.address().port,mode:'proxy'};
  const chat={id:'math',title:'公式与小说',created:now,model:'rendering-model',messages:[{id:'u',role:'user',content:'请继续'},{id:'history',role:'assistant',content:original,status:'complete',created:now,finishedAt:now}]};
  assert.equal((await fetch(url+'/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:(await record()).revision,data:{parameterPolicyVersion:1,chats:[chat],projects:[],profile,profiles:[profile],active:'math'}})})).status,200);
  const context=await browser.newContext({locale:'zh-CN',viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile});
  await context.addInitScript(()=>{window.copiedTexts=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copiedTexts.push(text)}});});
  const page=await context.newPage(),errors=[],external=[],failed=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(url)&&!r.url().startsWith('data:'))external.push(r.url());});page.on('response',r=>{if(r.status()>=400&&!r.url().includes('/api/'))failed.push(r.url());});
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));
  const history=page.locator('#msg-history .message-content');assert.equal(await history.locator('.katex').count(),8);assert.equal(await history.locator('.katex-error').count(),0);assert.equal(await history.locator('table td').first().textContent(),'阿莉雅');assert.equal(await history.locator('p code').textContent(),'$\\text{原始代码}$');
  await page.evaluate(()=>document.fonts.ready);assert(await history.locator('.math-display').last().evaluate(el=>el.scrollWidth>el.clientWidth));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('[data-action="copy-message:history"]').click();assert.equal(await page.evaluate(()=>window.copiedTexts.at(-1)),original);
  await page.locator('#prompt').fill('流式公式测试');const streamIndex=streams.length;await page.locator('#send').click();await wait(()=>streams.length===streamIndex+1,'stream start');
  const body=page.locator('#messages>.message').last().locator('.message-content');
  const first=String.raw`实时 **粗体**： $\text{施压} \rightarrow `;send(first);await body.locator('strong').waitFor();assert.equal(await body.locator('.katex').count(),0);
  const second=String.raw`\text{男主后退}$`;send(second);await body.locator('.katex').waitFor();assert.equal(await body.locator('.katex-error').count(),0);
  await page.evaluate(()=>{window.retainedMath=document.querySelector('#messages>.message:last-child .katex');window.retainedBold=document.querySelector('#messages>.message:last-child strong');});
  const third='\n\n'+String.raw`$$\frac{1}{2}+x^2$$`+'\n\n后续文字。';send(third);await body.locator('.math-display .katex').waitFor();assert(await page.evaluate(()=>document.querySelector('#messages>.message:last-child .katex')===window.retainedMath));
  await page.evaluate(()=>document.fonts.ready);const html=await body.innerHTML(),height=await body.evaluate(el=>el.getBoundingClientRect().height);
  await page.evaluate(()=>{window.mathChanges=0;window.mathObserver=new MutationObserver(records=>window.mathChanges+=records.length);window.mathObserver.observe(document.querySelector('#messages>.message:last-child .message-content'),{childList:true,characterData:true,subtree:true});});
  send('',true);await wait(async()=>(await record()).data.chats.find(c=>c.id==='math').messages.at(-1)?.status==='complete','saved final');
  assert.equal(await body.innerHTML(),html);assert.equal(await body.evaluate(el=>el.getBoundingClientRect().height),height);assert.equal(await page.evaluate(()=>window.mathChanges),0);assert(await page.evaluate(()=>document.querySelector('#messages>.message:last-child strong')===window.retainedBold));
  const saved=(await record()).data.chats[0];assert.equal(saved.messages.find(m=>m.id==='history').content,original);assert.equal(saved.messages.at(-1).content,first+second+third);
  await page.reload();await page.locator('#messages>.message:last-child .math-display .katex').waitFor();await page.evaluate(()=>document.fonts.ready);assert.equal(await page.locator('.katex-error').count(),0);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#msg-history').scrollIntoViewIfNeeded();await page.screenshot({path:join(qa,mobile?'mobile.png':'desktop.png'),fullPage:true});assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(failed,[]);await context.close();
  console.log('PASS '+(mobile?'mobile':'desktop')+': saved Chinese math, local assets/fonts, Markdown, raw copy/storage, partial streams, retained DOM and unchanged final layout');
 }
}finally{await browser?.close();for(const response of streams)response.destroy();if(server?.exitCode===null){const exit=once(server,'exit');server.kill();await exit;}mock.closeAllConnections();await new Promise(r=>mock.close(r));}
