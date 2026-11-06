export const unavailableMessage='服务器存储不可用，请启动 Node 服务并配置 Nginx 的 /api/ 转发。';
export async function loadWorkspace(){
 const response=await fetch('/api/workspace?view=sidebar',{cache:'no-store',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error(unavailableMessage);
 let record;try{record=await response.json();}catch{throw new Error(unavailableMessage);}
 if(!Number.isSafeInteger(record.revision)||!record.data||typeof record.data!=='object'||Array.isArray(record.data))throw new Error(unavailableMessage);
 if(record.activeId){const chat=await loadChat(record.activeId);const i=record.data.chats.findIndex(c=>c.id===chat.id);if(i<0)record.data.chats.push(chat);else record.data.chats[i]=chat;record.data.active=chat.id;}
 return record;
}
export async function loadChat(id){const response=await fetch('/api/chats/'+encodeURIComponent(id),{cache:'no-store',signal:AbortSignal.timeout(15000)});const result=await response.json();if(!response.ok)throw new Error(result.error||unavailableMessage);return {...result.chat,_etag:result._etag};}
export async function loadSidebar({expandedProjects,limit,focus,filter='',since}){const query=new URLSearchParams({view:'sidebar',expanded:JSON.stringify(expandedProjects),limit:String(limit),focus,filter});if(since!==undefined)query.set('since',since);const response=await fetch('/api/workspace?'+query,{cache:'no-store',signal:AbortSignal.timeout(15000)});if(response.status===304)return null;if(!response.ok)throw new Error(unavailableMessage);return response.json();}

const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Merge different chats/connections without allowing an older device to overwrite
// a newer edit to the same record. Missing IDs represent explicit deletions.
export function mergeWorkspace(base,local,remote){
 const conflicts=[],result={...remote,...local};
 for(const field of ['chats','profiles','projects']){
  const identity=item=>field==='profiles'?item.baseUrl:item.id;
  const maps=[base,local,remote].map(data=>new Map((data[field]||[]).map(item=>[identity(item),item])));
  const ids=new Set([...maps[1].keys(),...maps[2].keys(),...maps[0].keys()]);result[field]=[];
  for(const id of ids){const [before,mine,theirs]=maps.map(map=>map.get(id));let value;
   if(equal(before,mine))value=theirs;else if(equal(before,theirs)||equal(mine,theirs))value=mine;else{conflicts.push(field+':'+id);value=mine;}
   if(value!==undefined)result[field].push(value);
  }
 }
 result.keys={};
 for(const key of new Set([...Object.keys(base.keys||{}),...Object.keys(local.keys||{}),...Object.keys(remote.keys||{})])){
  const before=base.keys?.[key],mine=local.keys?.[key],theirs=remote.keys?.[key];let value;
  if(equal(before,mine))value=theirs;else if(equal(before,theirs)||equal(mine,theirs))value=mine;else{conflicts.push('keys:'+key);value=mine;}
  if(value!==undefined)result.keys[key]=value;
 }
 const before=base.presets||[],mine=local.presets||[],theirs=remote.presets||[];
 if(equal(before,mine))result.presets=theirs;else if(equal(before,theirs)||equal(mine,theirs))result.presets=mine;
 else result.presets=[...mine,...theirs.filter(p=>!mine.some(m=>equal(m,p)))];
 const projects=new Set(result.projects.map(p=>p.id));
 for(const chat of result.chats)if(chat.projectId&&!projects.has(chat.projectId))conflicts.push('projects:'+chat.projectId);
 return {data:result,conflicts};
}

export function createWorkspacePersistence({initial,read,apply,onStatus,onSaved}){
 if(initial.partial)return createPartialPersistence({initial,read,onStatus,onSaved});
 let record=initial,generation=0,saved=0,timer=0,inFlight=null,blocked=false;
 const status=(state,message='')=>onStatus?.(state,message);
 const schedule=delay=>{if(!timer&&!blocked)timer=setTimeout(()=>{timer=0;flush();},delay);};
 function save(){generation++;if(!blocked)status('pending');schedule(750);}
 async function flush({keepalive=false}={}){
  if(inFlight)return inFlight;
  clearTimeout(timer);timer=0;if(generation===saved)return true;
  blocked=false;status('saving');
  inFlight=(async()=>{
   for(let attempt=0;attempt<3;attempt++){
    const snapshot=read(),sent=generation,body=JSON.stringify({revision:record.revision,data:snapshot});
    const response=await fetch('/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json'},body,keepalive:keepalive&&new Blob([body]).size<60000,signal:AbortSignal.timeout(20000)});
    let result;try{result=await response.json();}catch{throw new Error(unavailableMessage);}
    if(response.status===409&&result.record){
     const merged=mergeWorkspace(record.data,read(),result.record.data);
     if(merged.conflicts.length){blocked=true;throw new Error('服务器已有较新的修改，当前修改尚未保存。请先导出对话，再刷新页面。');}
     record=result.record;apply(merged.data);generation++;continue;
    }
    if(!response.ok||!result.record)throw new Error(result.error||unavailableMessage);
    record=result.record;saved=sent;status(generation===saved?'saved':'pending');return true;
   }
   throw new Error('服务器正在被其他页面修改，请稍后重试保存。');
  })().catch(error=>{status('error',error.message);if(!blocked)schedule(5000);return false;});
  try{return await inFlight;}finally{inFlight=null;if(generation!==saved&&!blocked)schedule(750);}
 }
 return {save,flush,get dirty(){return generation!==saved;}};
}

const clean=value=>{const {_etag,...rest}=value;return rest;};
const cleanProfile=value=>{const {_etag,hasKey,...rest}=value;return rest;};
function createPartialPersistence({initial,read,onStatus,onSaved}){
 let baseline=structuredClone(initial.data),latestRecord=initial,generation=0,saved=0,timer=0,inFlight=null,blocked=false;
 const deletions=new Map(),moves=[],keys=new Map();let clearKeys=false;
 const schedule=delay=>{if(!timer&&!blocked)timer=setTimeout(()=>{timer=0;flush();},delay);};
 const save=()=>{generation++;if(!blocked)onStatus?.('pending');schedule(750);};
 function changesFor(snapshot){
  const settings={},settingsBase={},chats=[],projects=[],profiles=[];
  for(const key of Object.keys(snapshot))if(!['chats','projects','profiles','keys'].includes(key)&&!equal(baseline[key],snapshot[key])){settings[key]=snapshot[key];settingsBase[key]=baseline[key];}
  const oldProfiles=new Map((baseline.profiles||[]).map(p=>[p.id,p]));
  for(const p of snapshot.profiles||[]){const old=oldProfiles.get(p.id);if(!old||!equal(cleanProfile(old),cleanProfile(p))||keys.has(p.id))profiles.push({id:p.id,baseEtag:p._etag??old?._etag??null,profile:cleanProfile(p),...(keys.has(p.id)?{apiKey:keys.get(p.id)}:{})});oldProfiles.delete(p.id);}
  for(const p of oldProfiles.values())profiles.push({id:p.id,baseEtag:p._etag??null,deleted:true});
  const before=new Map((baseline.chats||[]).map(c=>[c.id,c]));
  for(const c of snapshot.chats||[]){if(deletions.has(c.id))continue;const old=before.get(c.id),baseEtag=old?._etag??c._etag??null;
   if(Array.isArray(c.messages)){if(!old||Array.isArray(old.messages)&&!equal(clean(old),clean(c)))chats.push({id:c.id,baseEtag,chat:clean(c)});}
   else if(old&&(old.projectId||'')!==(c.projectId||'')||old&&old.title!==c.title)chats.push({id:c.id,baseEtag,projectId:c.projectId||'',title:c.title});
  }
  for(const [id,baseEtag]of deletions)chats.push({id,baseEtag,deleted:true});
  const oldProjects=new Map((baseline.projects||[]).map(p=>[p.id,p]));
  for(const p of snapshot.projects||[]){const old=oldProjects.get(p.id);if(!old||!equal(clean(old),clean(p)))projects.push({id:p.id,baseEtag:old?._etag??null,project:clean(p)});oldProjects.delete(p.id);}
  for(const p of oldProjects.values())projects.push({id:p.id,baseEtag:p._etag??null,deleted:true});
  return {settings,settingsBase,chats,projects,profiles,clearKeys,moves:[...moves]};
 }
 async function flush({keepalive=false}={}){
  if(inFlight)return inFlight;clearTimeout(timer);timer=0;if(generation===saved)return true;blocked=false;onStatus?.('saving');
  inFlight=(async()=>{
   const snapshot=read(),sent=generation,changes=changesFor(snapshot),body=JSON.stringify({changes});
   if(!Object.keys(changes.settings).length&&!changes.chats.length&&!changes.projects.length&&!changes.moves.length&&!changes.profiles.length&&!changes.clearKeys){baseline=snapshot;saved=sent;onSaved?.(latestRecord,{clean:true,etags:{},projectEtags:{}});onStatus?.('saved');return true;}
   const response=await fetch('/api/workspace',{method:'PATCH',headers:{'Content-Type':'application/json'},body,keepalive:keepalive&&new Blob([body]).size<60000,signal:AbortSignal.timeout(20000)});
   let result;try{result=await response.json();}catch{throw new Error(unavailableMessage);}
   if(response.status===409){blocked=true;throw new Error('服务器已有较新的修改，当前修改尚未保存。请先导出对话，再刷新页面。');}
   if(!response.ok||!result.record)throw new Error(result.error||unavailableMessage);
   baseline=snapshot;latestRecord=result.record;saved=sent;
   for(const c of baseline.chats||[]){const id=result.remaps?.chats?.[c.id];if(id){if(baseline.active===c.id)baseline.active=id;c.id=id;const summary=result.record.data.chats.find(v=>v.id===id);c.title=summary?.title||c.title+'（冲突副本）';}}
   baseline.profiles=sent===generation?(result.record.data.profiles||baseline.profiles):(baseline.profiles||[]).map(p=>{
    const id=result.remaps?.profiles?.[p.id]||p.id,remote=changes.profiles.some(v=>v.id===p.id)?result.record.data.profiles?.find(v=>v.id===id):null;
    return {...p,id,...(id!==p.id?{name:remote?.name||p.name+'（冲突副本）'}:{}),...(remote?{_etag:remote._etag,hasKey:remote.hasKey}:{})};
   });
   if(result.remaps?.profiles?.[baseline.profile?.id])baseline.profile={...baseline.profile,id:result.remaps.profiles[baseline.profile.id]};
   for(const p of changes.profiles)if(keys.get(p.id)===p.apiKey)keys.delete(p.id);
   if(changes.clearKeys)clearKeys=false;
   for(const c of baseline.chats||[])if(result.etags?.[c.id])c._etag=result.etags[c.id];
   for(const p of baseline.projects||[])if(result.projectEtags?.[p.id])p._etag=result.projectEtags[p.id];
   for(const c of changes.chats)if(c.deleted&&deletions.get(c.id)===c.baseEtag)deletions.delete(c.id);
   for(const move of changes.moves){const i=moves.indexOf(move);if(i>=0)moves.splice(i,1);}
   onSaved?.(result.record,{clean:sent===generation,etags:result.etags,projectEtags:result.projectEtags,remaps:result.remaps,conflicts:result.conflicts,acknowledgedProfiles:changes.profiles.map(p=>result.remaps?.profiles?.[p.id]||p.id)});
   onStatus?.(sent===generation?'saved':'pending');return true;
  })().catch(error=>{onStatus?.('error',error.message);if(!blocked)schedule(5000);return false;});
  try{return await inFlight;}finally{inFlight=null;if(generation!==saved&&!blocked)schedule(750);}
 }
 return {save,flush,get dirty(){return generation!==saved;},get revision(){return latestRecord.revision;},get generation(){return generation;},get savedGeneration(){return saved;},setKey(id,key){keys.set(id,key);},clearKeys(){keys.clear();clearKeys=true;},acceptRemote(record){if(generation!==saved||inFlight)return false;baseline=structuredClone(record.data);latestRecord=record;return true;},hydrate(chat){baseline.chats=baseline.chats||[];const i=baseline.chats.findIndex(c=>c.id===chat.id);if(i<0)baseline.chats.push(structuredClone(chat));else baseline.chats[i]=structuredClone(chat);},acceptListing(record){latestRecord=record;for(const chat of record.data.chats){const i=(baseline.chats||[]).findIndex(c=>c.id===chat.id);if(i<0)(baseline.chats??=[]).push(structuredClone(chat));else if(!Array.isArray(baseline.chats[i].messages))baseline.chats[i]=structuredClone(chat);}},deleteChat(id){const chat=(baseline.chats||[]).find(c=>c.id===id);deletions.set(id,chat?._etag??null);},moveGroup(from,to){moves.push({from,to});}};
}
