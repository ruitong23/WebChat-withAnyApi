import {chromium} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),captures=new URL('../work/project-qa/',import.meta.url);
await mkdir(captures,{recursive:true});const dataDirectory=await mkdtemp(fileURLToPath(new URL('data-',captures)));
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
let server,browser,output='';const url=`http://127.0.0.1:${port}`;
const record=async()=>(await fetch(url+'/api/workspace')).json();
const wait=async(check,label)=>{for(let i=0;i<200;i++){try{if(await check())return;}catch{}await new Promise(r=>setTimeout(r,30));}throw new Error('Timeout: '+label+'\n'+output);};
const start=async()=>{server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,PORT:String(port),LUMEN_HOST:'127.0.0.1',LUMEN_DATA_DIR:dataDirectory},windowsHide:true,stdio:'pipe'});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);await wait(async()=>(await fetch(url+'/health')).ok,'startup');};
const stop=async()=>{if(server?.exitCode===null){const stopped=once(server,'exit');server.kill();await stopped;}};
const c1={id:'11111111-1111-4111-8111-111111111111',title:'第一条历史对话',messages:[{id:'u1',role:'user',content:'项目移动前后的正文应完整保留'},{id:'a1',role:'assistant',content:'历史回复完整保留。'}]};
const c2={id:'22222222-2222-4222-8222-222222222222',title:'第二条历史对话',messages:[{id:'u2',role:'user',content:'第二条独立保存的内容'}]};
try{
 await start();assert.equal((await fetch(url+'/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:0,data:{chats:[c1,c2],projects:[],active:c1.id,profile:{name:'API',baseUrl:'',mode:'proxy'},profiles:[],keys:{},presets:[]}})})).status,200);
 browser=await chromium.launch({channel:'chrome',headless:true});const errors=[];
 const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000},acceptDownloads:true}),page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 const saved=()=>page.waitForFunction(()=>document.querySelector('#storage-status')?.textContent.includes('已保存到服务器'));
 const create=async(name,scope)=>{await page.locator('[data-action="new-project"]').click();await page.locator('#project-name').fill(name);await page.locator('#project-create-scope').selectOption(scope);await page.locator('.modal [data-action="confirm"]').click();await saved();return (await record()).data.projects.find(p=>p.name===name);};
 await page.goto(url);await page.locator('button[data-chat="'+c1.id+'"]').waitFor();
 const a=await create('研究项目 A','current');assert(a);assert.match(await page.locator('#msg-u1').textContent(),/正文应完整保留/);
 const projectFile=join(dataDirectory,a.path,'project.json');assert.equal(JSON.parse(await readFile(projectFile,'utf8')).name,'研究项目 A');
 assert.equal(JSON.parse(await readFile(join(dataDirectory,a.path,'conversations',c1.id+'.json'),'utf8')).id,c1.id);
 await assert.rejects(readFile(join(dataDirectory,'conversations',c1.id+'.json')),{code:'ENOENT'});
 assert.equal(await page.locator('#chat-list button[data-chat]').count(),2,'The project and ungrouped chats share the same list budget');
 await page.locator('[data-action="new-chat"]').click();await saved();const draft=(await record()).data.chats.find(c=>c.id!==c1.id&&c.id!==c2.id);
 assert.equal(draft.projectId,a.id,'New chats inherit the selected project');
 await page.locator('[data-delete-chat="'+draft.id+'"]').click();await page.locator('.modal [data-action="confirm"]').click();await page.waitForFunction(id=>document.querySelector('#conversation')?.dataset.chat===id,c1.id);await saved();
 assert.equal(await page.locator('#conversation').getAttribute('data-chat'),c1.id,'Deleting the selected chat stays within its project');
 console.log('PASS project creation moves the current chat into its own directory and keeps its messages');

 await page.locator('[data-action="project-settings:'+a.id+'"]').click();assert.equal(await page.locator('.project-path').textContent(),a.path);
 await page.locator('#project-name').fill('改名后的研究项目');await page.locator('.modal [data-action="confirm"]').click();await saved();
 assert.equal(JSON.parse(await readFile(projectFile,'utf8')).name,'改名后的研究项目');assert.equal((await record()).data.projects.find(p=>p.id===a.id).path,a.path);
 const b=await create('项目 B','empty');if(await page.locator('[data-project="'+a.id+'"]').getAttribute('aria-expanded')!=='true')await page.locator('[data-project="'+a.id+'"]').click();await page.locator('button[data-chat="'+c1.id+'"]').click();
 await page.locator('[data-action="move-chat"]').click();await page.locator('#move-project').selectOption(b.id);await page.locator('.modal [data-action="confirm"]').click();await saved();
 assert.equal(JSON.parse(await readFile(join(dataDirectory,b.path,'conversations',c1.id+'.json'),'utf8')).messages[0].content,c1.messages[0].content);
 await assert.rejects(readFile(join(dataDirectory,a.path,'conversations',c1.id+'.json')),{code:'ENOENT'});
 await page.screenshot({path:fileURLToPath(new URL('desktop-project.png',captures))});
 console.log('PASS project paths survive renaming and moving a chat changes the actual disk location');

 await page.locator('[data-project="*"]').click();const before=(await record()).data.chats.length;
 const bulk=await create('全部归档','group');const grouped=(await record()).data;assert.equal(grouped.chats.filter(c=>c.projectId===bulk.id).length,before);
 for(const chat of grouped.chats)assert.equal(JSON.parse(await readFile(join(dataDirectory,bulk.path,'conversations',chat.id+'.json'),'utf8')).id,chat.id);
 const downloadEvent=page.waitForEvent('download');await page.locator('[data-action="settings"]').click();await page.locator('[data-action="export-all"]').click();const download=await downloadEvent;
 const backup=await readFile(await download.path(),'utf8'),exported=JSON.parse(backup);assert(exported.projects.some(p=>p.id===bulk.id));assert(exported.chats.every(c=>c.projectId===bulk.id));
 await page.locator('[data-action="project-settings:'+bulk.id+'"]').click();await page.locator('.modal [data-action="delete-project"]').click();await page.locator('.modal [data-action="confirm"]').click();await saved();
 const ungrouped=(await record()).data;assert.equal(ungrouped.chats.length,before);assert(ungrouped.chats.every(c=>!c.projectId));
 for(const chat of ungrouped.chats)assert.equal(JSON.parse(await readFile(join(dataDirectory,'conversations',chat.id+'.json'),'utf8')).id,chat.id);
 await assert.rejects(readFile(join(dataDirectory,bulk.path,'project.json')),{code:'ENOENT'});
 console.log('PASS bulk project creation and project deletion move files while preserving every conversation');

 await page.locator('[data-action="settings"]').click();const chooser=page.waitForEvent('filechooser');await page.locator('[data-action="import"]').click();await (await chooser).setFiles({name:'project-backup.json',mimeType:'application/json',buffer:Buffer.from(backup)});
 await wait(async()=>(await record()).data.chats.length===before*2,'project backup import');await saved();
 const imported=(await record()).data,oldIds=new Set(ungrouped.chats.map(c=>c.id)),importedChats=imported.chats.filter(c=>!oldIds.has(c.id));
 assert.equal(importedChats.length,before);assert(importedChats.every(c=>c.projectId&&imported.projects.some(p=>p.id===c.projectId)));
 assert(imported.projects.some(p=>p.name==='全部归档'&&p.id!==bulk.id));
 await context.close();await stop();await start();assert.equal((await record()).data.chats.length,before*2);
 console.log('PASS backup import restores project membership with new IDs and survives a server restart');

 const mobileContext=await browser.newContext({locale:'zh-CN',viewport:{width:390,height:844},isMobile:true,hasTouch:true}),mobile=await mobileContext.newPage();mobile.on('pageerror',e=>errors.push(e.message));
 await mobile.goto(url);await mobile.locator('[data-action="sidebar"]').click();await mobile.locator('[data-action="new-project"]').click();await mobile.locator('#project-name').fill('移动端项目');await mobile.locator('.modal [data-action="confirm"]').click();
 await wait(async()=>(await record()).data.projects.some(p=>p.name==='移动端项目'),'mobile project creation');
 await mobile.locator('[data-action="sidebar"]').click();
 const visibility=await mobile.locator('#project-nav').evaluate(nav=>{const row=document.querySelector('.project-row.selected').getBoundingClientRect(),bounds=document.querySelector('#chat-list').getBoundingClientRect();return {top:row.top,bottom:row.bottom,navTop:bounds.top,navBottom:bounds.bottom,heading:0};});
 assert(visibility.bottom<=visibility.navBottom+1&&visibility.top>=visibility.navTop+visibility.heading-1,'Selected project stays visible: '+JSON.stringify(visibility));
 await mobile.screenshot({path:fileURLToPath(new URL('mobile-projects.png',captures))});
 assert(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await mobileContext.close();
 console.log('PASS mobile project creation, navigation, no horizontal overflow, no browser errors');
}finally{await browser?.close();await stop();}
