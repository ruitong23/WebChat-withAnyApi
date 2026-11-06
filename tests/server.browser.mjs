import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),captures=new URL('../work/server-qa/',import.meta.url);
await mkdir(captures,{recursive:true});const temporary=await mkdtemp(fileURLToPath(new URL('data-',captures)));
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
let browser,server,output='',requests=0;
const mock=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 if(req.headers.authorization!=='Bearer server-test-key'){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":{"message":"Invalid test key"}}');return;}
 if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end('{"data":[{"id":"server-test-model"}]}');return;}
 if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end('{}');return;}
 requests++;assert(JSON.parse(body).messages.some(m=>m.role==='user'));
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();let i=0;
 const timer=setInterval(()=>{
  res.write('data: '+JSON.stringify({choices:[{delta:{content:`服务器测试回答第 ${++i} 段。\n`}}]})+'\n\n');
  if(i===30){clearInterval(timer);res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}
 },80);res.on('close',()=>clearInterval(timer));
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${mock.address().port}`;
const backend=`http://127.0.0.1:${port}`;
// Exercise the deployment arrangement: static frontend and an /api/ reverse proxy.
const proxy=http.createServer(async(req,res)=>{
 if(req.url.startsWith('/api/')){
  const upstream=http.request(backend+req.url,{method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);res.on('close',()=>upstream.destroy());return;
 }
 const assets=new Set(['index.html','app.js','i18n.js','response-utils.js','workspace-client.js','style.css']);
 const path=req.url==='/'?'index.html':req.url.slice(1);
 if(!assets.has(path)){res.writeHead(404);res.end();return;}
 try{const data=await readFile(new URL('../dist/public/'+path,import.meta.url));res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(data);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${proxy.address().port}`;
const wait=async(check,label)=>{for(let i=0;i<150;i++){if(await check())return;await new Promise(r=>setTimeout(r,40));}throw new Error('Timeout: '+label+'\n'+output);};
const record=async()=>{const response=await fetch(url+'/api/workspace');assert.equal(response.status,200);return response.json();};
const start=async()=>{
 server=spawn(process.execPath,['dist/server/index.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_DATA_DIR:temporary},windowsHide:true,stdio:'pipe'});
 server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 await wait(async()=>{try{return (await fetch(backend+'/health')).ok;}catch{return false;}},'server startup');
};
const stop=async()=>{if(server?.exitCode===null){const stopped=once(server,'exit');server.kill();await stopped;}};
try{
 await start();browser=await chromium.launch({channel:'chrome',headless:true});
 const errors=[],context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}}),page=await context.newPage();
 page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.locator('.welcome h1').waitFor();
 await page.locator('[data-page="connection"]').first().click();await page.locator('#base-url').fill(base);await page.locator('#api-key').fill('server-test-key');
 assert(await page.locator('#remember-key').isChecked());await page.locator('[data-action="save-connection"]').click();
 await wait(async()=>(await record()).data.keys?.[base]==='server-test-key','server key save');
 await page.locator('[data-action="discover"]').click();await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));
 await page.locator('[data-page="chat"]').first().click();
 const chooser=page.waitForEvent('filechooser');await page.locator('[data-action="attach"]').click();await (await chooser).setFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('需要保留在服务器的附件内容')});
 await page.locator('#prompt').fill('这条消息应保存到服务器');await page.locator('#send').click();
 await wait(async()=>(await record()).data.chats?.some(c=>c.messages.some(m=>m.role==='assistant'&&m.status==='pending'&&m.content?.length>0)),'partial stream saved before completion');
 console.log('PASS ongoing streaming output is periodically saved to disk');
 await page.waitForFunction(()=>document.querySelector('#send')?.dataset.action==='send');
 await page.waitForFunction(()=>document.querySelector('#storage-status')?.textContent.includes('已保存到服务器'));
 const saved=await record(),active=saved.data.chats.find(c=>c.id===saved.data.active);
 assert.match(active.messages[0].content,/需要保留在服务器的附件内容/);assert.match(active.messages[1].content,/第 30 段/);
 assert.deepEqual(await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)})),{local:[],session:[]});
 const index=JSON.parse(await readFile(join(temporary,'workspace.json'),'utf8'));assert.equal(index.data.chats[0].messages,undefined);
 assert.match(await readFile(join(temporary,index.data.chats.find(c=>c.id===active.id).path),'utf8'),/这条消息应保存到服务器/);
 await page.screenshot({path:fileURLToPath(new URL('desktop-saved.png',captures))});
 console.log('PASS conversation, attachment and API key are on server disk, browser storage stays empty');

 const peerContext=await browser.newContext({locale:'zh-CN',viewport:{width:390,height:844},isMobile:true,hasTouch:true}),peer=await peerContext.newPage();peer.on('pageerror',e=>errors.push(e.message));
 await peer.goto(url);await peer.locator('#msg-'+active.messages[0].id).waitFor();
 await peer.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('API 已连接'));
 assert.match(await peer.locator('.message-content').last().textContent(),/第 30 段/);
 assert(await peer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await peer.screenshot({path:fileURLToPath(new URL('mobile-shared.png',captures))});await peerContext.close();
 console.log('PASS a fresh mobile browser loads the same conversation and saved API connection');

 await page.route('**/api/workspace',route=>['PUT','PATCH'].includes(route.request().method())?route.fulfill({status:503,json:{error:'temporary failure'}}):route.continue());
 await page.locator('[data-action="theme"]').click();await page.waitForFunction(()=>document.querySelector('#storage-status')?.textContent.includes('保存失败'));
 await page.unroute('**/api/workspace');await page.locator('#storage-status').click();await page.waitForFunction(()=>document.querySelector('#storage-status')?.textContent.includes('已保存到服务器'));
 assert.equal((await record()).data.theme,'dark');console.log('PASS failed writes stay visible and can be retried');

 // A browser's old records migrate only when its owner clicks the import action.
 await page.evaluate(()=>localStorage.setItem('lumen.v1',JSON.stringify({chats:[{id:'legacy-chat',title:'旧浏览器对话',messages:[{id:'legacy-user',role:'user',content:'旧的本地记录'}]}]})));
 await page.locator('[data-action="settings"]').click();await page.locator('[data-action="import-browser"]').click();
 await wait(async()=>(await record()).data.chats.some(c=>c.id==='legacy-chat'),'legacy import');
 assert((await record()).data.chats.some(c=>c.id===active.id),'Import must keep existing server conversations');
 await page.locator('[data-action="settings"]').click();await page.locator('[data-action="import-browser"]').click();
 await wait(async()=>(await record()).data.chats.filter(c=>c.id==='legacy-chat').length===1,'idempotent legacy import');
 console.log('PASS explicit browser migration preserves server chats and does not duplicate IDs');
 await context.close();await stop();await start();
 const restored=await record();assert(restored.data.chats.some(c=>c.id===active.id));assert.equal(restored.data.keys[base],'server-test-key');
 const restartContext=await browser.newContext({locale:'en-US'}),restartPage=await restartContext.newPage();restartPage.on('pageerror',e=>errors.push(e.message));
 await restartPage.goto(url);await restartPage.locator('#msg-legacy-user').waitFor();assert.match(await restartPage.locator('#storage-status').textContent(),/Saved on server/);await restartContext.close();
 console.log('PASS service restart restores chats and keys from the same data directory');

 const originResponse=await fetch(backend+'/api/workspace',{method:'PUT',headers:{Origin:'https://other.test','Content-Type':'application/json'},body:'{}'});assert.equal(originResponse.status,403);
 const httpsRelay=await fetch(backend+'/api/relay',{method:'POST',headers:{Origin:'https://127.0.0.1:'+port,'Content-Type':'application/json'},body:JSON.stringify({baseUrl:base,path:'/v1/models',apiKey:'server-test-key'})});assert.equal(httpsRelay.status,200,'HTTPS proxy origin must work: '+await httpsRelay.text());
 assert.equal((await fetch(backend+'/data/workspace.json')).status,404);assert.equal((await fetch(url+'/data/workspace.json')).status,404);
 console.log('PASS HTTPS proxy origins, cross-site write rejection, and non-public data paths');
 const offlineContext=await browser.newContext({locale:'zh-CN'}),offline=await offlineContext.newPage();
 await offline.route('**/api/workspace**',route=>route.fulfill({status:404,body:'not found'}));await offline.goto(url);await offline.locator('#retry-storage').waitFor();
 assert.match(await offline.locator('#app').textContent(),/Nginx/);await offlineContext.close();
 assert.deepEqual(errors,[]);assert.equal(requests,1);console.log('PASS missing backend is explained, no silent local fallback, no browser runtime errors');
}finally{
 await browser?.close();await stop();proxy.closeAllConnections();mock.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>mock.close(r))]);
}
