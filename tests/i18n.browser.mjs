import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const temporaryRoot=join(root,'work');await mkdir(temporaryRoot,{recursive:true});
const temporary=await mkdtemp(join(temporaryRoot,'i18n-temp-'));
process.env.TEMP=temporary;process.env.TMP=temporary;
const captures=new URL('../work/i18n-qa/',import.meta.url);await mkdir(captures,{recursive:true});
const server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_CONFIG_FILE:join(temporary,'model-configs.json')},windowsHide:true,stdio:'pipe'});
let browser,output='';server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
const url=`http://127.0.0.1:${port}`;
try{
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(url+'/health')).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,50));}
 assert(ready,output);
 assert.equal((await fetch(url+'/i18n.js')).status,200);
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const [locale,language,title]of [['zh-CN','zh-CN','新对话'],['en-US','en','New chat'],['de-DE','en','New chat']]){
  const context=await browser.newContext({locale,viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(10000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.locator('.welcome h1').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'),language);
  assert.equal(await page.locator('.welcome h1').textContent(),title);
  const english=language==='en';
  const checkCopy=async()=>{
   if(!english)return;
   const copy=await page.evaluate(()=>[document.body.innerText,...[...document.querySelectorAll('[placeholder],[aria-label],[title],option')].flatMap(el=>['placeholder','aria-label','title'].map(attr=>el.getAttribute(attr)||''))].join('\n'));
   assert(!/\p{Script=Han}/u.test(copy),'Untranslated interface copy: '+copy.match(/[^\n]*\p{Script=Han}[^\n]*/gu)?.join('\n'));
  };
  await checkCopy();
  for(const tab of ['load','tools','inference']){await page.locator(`[data-tab="${tab}"]`).click();await checkCopy();}
  for(const action of ['system-presets','save-preset']){await page.locator(`[data-action="${action}"]`).click();await checkCopy();await page.locator('[data-action="close-modal"]').first().click();}
  for(const section of ['connection','models','logs']){await page.locator(`[data-page="${section}"]`).first().click();await checkCopy();}
  await page.locator('[data-action="settings"]').click();await checkCopy();
  await page.locator('[data-action="shortcuts"]').click();await checkCopy();await page.locator('[data-action="close-modal"]').click();
  await page.locator('[data-action="demo"]').click();await page.locator('#prompt').fill('保留原文：模型连接');await page.locator('#send').click();
  await page.locator('[data-action="stop"]').waitFor({state:'hidden'});
  assert.equal(await page.locator('.message').first().locator('.message-content').textContent(),'保留原文：模型连接');
  assert.equal(await page.locator('.message').last().locator('.message-content').textContent(),english?'Demo message.':'演示消息。');
  assert.match(await page.locator('#request-metrics').textContent(),english?/Received/:/已接收/);
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('lumen.v1')||'{}').chats?.[0]?.messages?.length===2);
  // Custom names, prompts and model-returned Chinese must survive English rendering.
  await page.addInitScript(()=>{const value=JSON.parse(localStorage.getItem('lumen.v1'));value.profile={name:'我的中文连接',baseUrl:'',mode:'proxy'};value.chats=[{id:'kept',title:'中文标题',messages:[{id:'u',role:'user',content:'中文问题'},{id:'a',role:'assistant',content:'中文模型回答',reasoning:'原始中文思考'}],params:{system:'保留中文提示词'}}];value.active='kept';value.parameterPolicyVersion=1;localStorage.setItem('lumen.v1',JSON.stringify(value));});
  await page.reload();await page.locator('#msg-a').waitFor();
  assert.equal(await page.locator('#msg-a .message-content').textContent(),'中文模型回答');
  assert.equal(await page.locator('#system-prompt').inputValue(),'保留中文提示词');
  assert.match(await page.locator('.connection-mini').textContent(),/我的中文连接/);
  await page.locator('#msg-a .reasoning summary').click();await page.waitForFunction(()=>document.querySelector('#msg-a .reasoning pre')?.textContent==='原始中文思考');
  await page.screenshot({path:fileURLToPath(new URL(locale+'.png',captures))});
  assert.deepEqual(errors,[]);
  await context.close();console.log('PASS '+locale+' interface and preserved user content');
 }
}finally{
 await browser?.close();if(server.exitCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
 assert(temporary.startsWith(temporaryRoot+sep));await rm(temporary,{recursive:true,force:true});
}
