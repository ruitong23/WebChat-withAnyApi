import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkspaceStore} from '../src/workspace-store.mjs';
import {createGenerationRunner} from '../src/generation-runner.mjs';
import {readGenerationOutput} from '../src/generation-output.mjs';
const root=fileURLToPath(new URL('../work/generation-unit/',import.meta.url));await mkdir(root,{recursive:true});
const frame=delta=>'data: '+JSON.stringify({choices:[{delta}]})+'\n\n';
const wait=async check=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Generation timeout');};
async function fixture(options={}){
 const directory=await mkdtemp(join(root,'data-')),store=createWorkspaceStore(join(directory,'workspace.json'));
 await store.update(0,{projects:[],profiles:[{id:'p',name:'Mock',baseUrl:'https://models.example',mode:'proxy'}],keys:{p:'PRIVATE_TEST_KEY'},chats:[{id:'chat',title:'Original',params:{system:'Private prompt'},messages:[{id:'u',role:'user',content:'PRIVATE_NOVEL_TEXT'},{id:'job',generationId:'job',role:'assistant',content:'',status:'pending'}]}]});
 let calls=0,controller,signal;
 const runner=createGenerationRunner({directory:join(directory,'generation-tasks'),store,relayRequest:async request=>{calls++;signal=request.signal;return new Response(new ReadableStream({start(c){controller=c;signal.addEventListener('abort',()=>c.error(new DOMException('Aborted','AbortError')),{once:true});}}),{headers:{'Content-Type':'text/event-stream'}});},...options});
 const request={id:'job',chatId:'chat',messageId:'job',baseUrl:'https://models.example',profileId:'p',payload:{model:'mock',stream:true,messages:[{role:'user',content:'PRIVATE_NOVEL_TEXT'}]}};
 return {directory,store,runner,request,get calls(){return calls;},send:delta=>controller.enqueue(new TextEncoder().encode(frame(delta))),finish:()=>controller.close(),get signal(){return signal;}};
}
test('durable task IDs deduplicate requests, observers can disconnect and final text is saved once',async()=>{
 const f=await fixture();try{
  const first=await f.runner.start(f.request);await wait(()=>f.calls===1);const second=await f.runner.start(f.request);assert.equal(first.id,second.id);assert.equal(f.calls,1);
  const observer=new AbortController();const watching=f.runner.get('job',first.version,observer.signal);observer.abort();await watching;assert.equal(f.signal.aborted,false);
  f.send({content:'第一段'});await wait(async()=>(await f.runner.get('job')).assistant.content==='第一段');assert.equal((await f.store.getChat('chat')).chat.messages.at(-1).content,'');
  const before=await f.store.getChat('chat');await f.store.patch({chats:[{id:'chat',baseEtag:before._etag,meta:{title:'Renamed during generation'},metaBase:{title:before.chat.title}}]});
  f.send({reasoning_content:'思考内容',content:'第二段'});f.send({content:'第三段'});f.finish();await wait(async()=>(await f.runner.get('job')).done);
  const saved=(await f.store.getChat('chat')).chat;assert.equal(saved.title,'Renamed during generation');assert.equal(saved.messages.at(-1).content,'第一段第二段第三段');assert.equal(saved.messages.at(-1).reasoning,'思考内容');assert.equal(f.calls,1);assert.equal((await f.store.get()).data.chats.length,1);
  assert.equal((await f.runner.start(f.request)).done,true);assert.equal(f.calls,1);
  const ledger=await readFile(join(f.directory,'generation-tasks/job.json'),'utf8');assert(!ledger.includes('PRIVATE_TEST_KEY'));assert(!ledger.includes('PRIVATE_NOVEL_TEXT'));assert(!ledger.includes('思考内容'));
 }finally{await f.runner.shutdown();}
});
test('combined reasoning and answer estimate stops generation, retains text and never retries upstream',async()=>{
 const f=await fixture({limit:10});try{
  await f.runner.start(f.request);await wait(()=>f.calls===1);f.send({reasoning_content:'一二三四五六'});await wait(async()=>(await f.runner.get('job')).assistant.reasoning?.length===6);f.send({content:'七八九十'});
  await wait(async()=>(await f.runner.get('job')).done);const task=await f.runner.get('job');assert.equal(task.assistant.status,'stopped');assert.equal(task.assistant.stopReason,'output_limit');assert.equal(task.assistant.content,'七八九十');assert.equal(task.assistant.reasoning,'一二三四五六');assert.equal(f.signal.aborted,true);assert.equal(f.calls,1);
 }finally{await f.runner.shutdown();}
});
test('explicit stop and restart recovery preserve results without automatically creating another request',async()=>{
 const f=await fixture();await f.runner.start(f.request);await wait(()=>f.calls===1);f.send({content:'停止前的正文'});await wait(async()=>(await f.runner.get('job')).assistant.content==='停止前的正文');await f.runner.stop('job');assert.equal((await f.runner.get('job')).assistant.status,'stopped');await f.runner.shutdown();
 const restarted=createGenerationRunner({directory:join(f.directory,'generation-tasks'),store:f.store,relayRequest:()=>assert.fail('must never resend')});await restarted.recover();assert.equal((await restarted.start(f.request)).assistant.content,'停止前的正文');await restarted.shutdown();
});
test('server startup marks unfinished task interrupted instead of silently replaying it',async()=>{
 const f=await fixture();const {writeFile}=await import('node:fs/promises');await mkdir(join(f.directory,'generation-tasks'));await writeFile(join(f.directory,'generation-tasks/job.json'),JSON.stringify({id:'job',chatId:'chat',messageId:'job',status:'running',startedAt:1,fingerprint:'old'}));await f.runner.recover();assert.equal((await f.runner.get('job')).assistant.status,'interrupted');assert.equal((await f.store.getChat('chat')).chat.messages.at(-1).status,'interrupted');assert.equal(f.calls,0);await f.runner.shutdown();
});
test('metadata edits based on pending output merge with server completion without a duplicate conversation',async()=>{
 const f=await fixture();const before=await f.store.getChat('chat');await f.store.finishGeneration('chat','job','job',{content:'Completed on server',status:'complete'});const result=await f.store.patch({chats:[{id:'chat',baseEtag:before._etag,meta:{title:'New title'},metaBase:{title:'Original'}}]});assert.deepEqual(result.conflicts,[]);assert.equal((await f.store.get()).data.chats.length,1);const final=await f.store.getChat('chat');assert.equal(final.chat.messages.at(-1).content,'Completed on server');assert.equal(final.chat.title,'New title');await f.runner.shutdown();
});
test('native signed parts, split think tags, tool calls and non-stream replies remain supported',async()=>{
 const m={content:''};const stream=new ReadableStream({start(c){for(const delta of [{content:'<thi'},{content:'nk>想法</think>正文',tool_calls:[{index:0,id:'t',function:{name:'lookup',arguments:'{"a":'}}]},{tool_calls:[{index:0,function:{arguments:'1}'}}],vertex_parts:[{offset:0,part:{thoughtSignature:'signed'}}]}])c.enqueue(new TextEncoder().encode(frame(delta)));c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));c.close();}});
 await readGenerationOutput(new Response(stream,{headers:{'Content-Type':'text/event-stream'}}),m);assert.equal(m.reasoning,'想法');assert.equal(m.content,'正文');assert.equal(m.tool_calls[0].function.arguments,'{"a":1}');assert.equal(m.vertexParts[0].part.thoughtSignature,'signed');
 const n={content:''};await readGenerationOutput(Response.json({choices:[{message:{content:'JSON reply'},finish_reason:'stop'}]}),n);assert.equal(n.content,'JSON reply');
});

test('a reconnect concurrent with task creation cannot mistake the new ledger for an interrupted job',async()=>{
 const f=await fixture();try{const starting=f.runner.start(f.request),reading=f.runner.get('job');await starting;const state=await reading;assert.equal(state.status,'running');assert.equal(state.assistant.status,'pending');await wait(()=>f.calls===1);assert.equal(f.calls,1);}finally{await f.runner.shutdown();}
});

test('an oversized single response is clipped at the combined estimate and multiple non-stream tools keep their identity',async()=>{
 const m={content:''};let stopped=false;await readGenerationOutput(Response.json({choices:[{message:{content:'文'.repeat(12),reasoning_content:'思'.repeat(12)},finish_reason:'stop'}]}),m,{limit:10,stop:()=>{stopped=true;}});assert.equal(stopped,true);assert.equal(m.content.length+(m.reasoning||'').length,10);
 const n={content:''};await readGenerationOutput(Response.json({choices:[{message:{tool_calls:[{id:'one',function:{name:'a',arguments:'{}'}},{id:'two',function:{name:'b',arguments:'{}'}}]},finish_reason:'tool_calls'}]}),n);assert.deepEqual(n.tool_calls.map(t=>t.id),['one','two']);
});
