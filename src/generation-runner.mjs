import {mkdir,readFile,writeFile,rename,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {relay} from './relay.js';
import {readGenerationOutput,outputTokenLimit} from './generation-output.mjs';

const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);
const failure=(text,status=400)=>Object.assign(new Error(text),{status});
export function createGenerationRunner({directory,store,allowPrivate=false,relayRequest=relay,limit=outputTokenLimit}){
 const tasks=new Map();let queue=Promise.resolve(),closing=false;
 const file=id=>join(directory,id+'.json');
 const ledger=task=>({id:task.id,chatId:task.chatId,messageId:task.messageId,fingerprint:task.fingerprint,status:task.status,startedAt:task.startedAt});
 const writeLedger=async task=>{await mkdir(directory,{recursive:true,mode:0o700});const temporary=file(task.id)+'.tmp';await writeFile(temporary,JSON.stringify(ledger(task)),{mode:0o600});await rename(temporary,file(task.id));};
 const bump=task=>{task.version++;if(task.notice)return;task.notice=setTimeout(()=>{task.notice=null;for(const listener of task.listeners)listener();task.listeners.clear();},150);task.notice.unref?.();};
 const snapshot=task=>({id:task.id,chatId:task.chatId,messageId:task.messageId,status:task.status,version:task.version,startedAt:task.startedAt,assistant:structuredClone(task.assistant),saveError:task.saveError||'',done:task.status==='finished'});
 const load=async id=>{
  if(!validId(id))throw failure('生成任务编号无效');if(tasks.has(id))return tasks.get(id);
  let record;try{record=JSON.parse(await readFile(file(id),'utf8'));}catch(error){if(error.code==='ENOENT')throw failure('生成任务不存在',404);throw error;}
  const result=await store.getChat(record.chatId).catch(error=>{if(error.status===404)return null;throw error;});
  let assistant=result?.chat.messages.find(m=>m.id===record.messageId);
  if(!assistant)assistant={id:record.messageId,role:'assistant',content:'',status:'interrupted',interrupted:true,errorInfo:'原对话或消息已删除'};
  if(record.status!=='finished'&&assistant.status==='pending'){
   assistant={...assistant,status:'interrupted',interrupted:true,thinking:false,finishedAt:Date.now(),errorInfo:'服务器已重启，生成未自动重试，请手动继续或重试。'};
   await store.finishGeneration(record.chatId,record.messageId,id,assistant);
  }
  const task={...record,status:'finished',assistant,version:1,listeners:new Set()};if(record.status!=='finished')await writeLedger(task);return task;
 };
 async function persist(task){
  try{
   await store.finishGeneration(task.chatId,task.messageId,task.id,task.assistant);task.status='finished';await writeLedger(task);task.saveError='';bump(task);
   // Terminal results are durable in the conversation and can be read again by
   // ID. Keep only active tasks in memory, even after many short generations.
   tasks.delete(task.id);
  }catch(error){task.status='saving';task.saveError='生成结果保存失败，服务器正在重试';bump(task);if(!closing){task.retry=setTimeout(()=>persist(task),5000);task.retry.unref?.();}}
 }
 async function run(task,data){
  const message=task.assistant;
  try{
   const apiKey=data.apiKey||await store.keyFor(data.baseUrl,data.profileId);
   task.controller.signal.throwIfAborted();
   const request=new Request('http://generation.internal/api/relay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseUrl:data.baseUrl,apiKey,path:'/v1/chat/completions',payload:{...data.payload,stream:true}}),signal:task.controller.signal});
   const response=await relayRequest(request,{allowPrivate});
   if(!response.ok){const body=await response.json().catch(()=>({}));let text=body.error?.message||'模型请求失败（'+response.status+'）';if(apiKey)text=text.split(apiKey).join('[REDACTED]');throw new Error(text);}
   message.connectedAt=Date.now();bump(task);
   const {limited}=await readGenerationOutput(response,message,{limit,onUpdate:()=>bump(task),stop:()=>task.controller.abort()});
   if(limited||task.controller.signal.aborted)message.status='stopped';
   else message.status=['length','max_tokens','max_output_tokens'].includes(message.finishReason)?'truncated':!message.content&&message.reasoning&&!message.tool_calls?.length?'reasoning_only':'complete';
   if(!message.content&&!message.reasoning&&!message.tool_calls?.length&&message.status!=='stopped')throw new Error('接口未返回任何文本或工具调用');
  }catch(error){
   const partial=!!message.content||!!message.reasoning||!!message.tool_calls?.length;
   if(task.controller.signal.aborted){message.status='stopped';if(!partial)message.content='生成已停止。';}
   else{message.status=partial?'interrupted':'error';message.interrupted=partial;message.error=!partial;message.errorInfo=error.message;if(!partial)message.content=error.message;}
  }finally{message.finishedAt=Date.now();message.ms=message.finishedAt-task.startedAt;message.thinking=false;await persist(task);}
 }
 return {
  async recover(){await mkdir(directory,{recursive:true,mode:0o700});for(const name of await readdir(directory))if(name.endsWith('.json')){const id=name.slice(0,-5);if(!validId(id))continue;const record=JSON.parse(await readFile(file(id),'utf8'));if(record.status!=='finished')await load(id);}},
  start(data){const operation=queue.then(async()=>{
   if(closing)throw failure('服务器正在停止，请稍后重试',503);
   if(!validId(data.id)||data.messageId!==data.id||typeof data.chatId!=='string'||!data.payload||!Array.isArray(data.payload.messages)||typeof data.payload.model!=='string')throw failure('生成任务数据格式无效');
   const fingerprint=createHash('sha256').update(JSON.stringify([data.chatId,data.messageId,data.baseUrl,data.profileId,data.payload])).digest('hex');
   let existing;try{existing=await load(data.id);}catch(error){if(error.status!==404)throw error;}
   if(existing){if(existing.fingerprint!==fingerprint)throw failure('此任务编号已用于其他请求',409);return snapshot(existing);}
   if([...tasks.values()].some(t=>t.status!=='finished'&&t.chatId===data.chatId))throw failure('这个对话已有正在生成的任务',409);
   if([...tasks.values()].filter(t=>t.status!=='finished').length>=4)throw failure('同时生成的任务过多，请稍后重试',429);
   const {chat}=await store.getChat(data.chatId),message=chat.messages.find(m=>m.id===data.messageId);
   if(!message||message.role!=='assistant'||message.status!=='pending'||message.generationId!==data.id)throw failure('请先保存本次问题和生成任务',409);
   const task={id:data.id,chatId:data.chatId,messageId:data.messageId,fingerprint,status:'running',startedAt:Date.now(),assistant:{...message,content:'',receivedEvents:0,receivedBytes:0},version:1,controller:new AbortController(),listeners:new Set()};
   await mkdir(directory,{recursive:true,mode:0o700});await writeFile(file(data.id),JSON.stringify(ledger(task)),{flag:'wx',mode:0o600});tasks.set(task.id,task);task.promise=run(task,data);return snapshot(task);
  });queue=operation.catch(()=>{});return operation;},
  list(){return [...tasks.values()].filter(t=>t.status!=='finished').map(t=>({id:t.id,chatId:t.chatId,messageId:t.messageId,startedAt:t.startedAt}));},
  async get(id,after,signal){await queue;const task=await load(id);if(task.status!=='finished'&&task.version===after){await new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);task.listeners.delete(done);signal?.removeEventListener('abort',done);resolve();};task.listeners.add(done);signal?.addEventListener('abort',done,{once:true});timer=setTimeout(done,1000);if(signal?.aborted)done();});}return snapshot(task);},
  async stop(id){await queue;const task=await load(id);if(task.status==='running'){task.assistant.stopReason='user';task.controller.abort();await task.promise;}return snapshot(task);},
  async shutdown(){closing=true;await queue;for(const task of tasks.values())if(task.status==='running'){task.assistant.stopReason='server_shutdown';task.controller.abort();}await Promise.allSettled([...tasks.values()].map(t=>t.promise));for(const t of tasks.values())clearTimeout(t.retry);}
 };
}
