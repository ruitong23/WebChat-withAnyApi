import {readFile,mkdir,writeFile,rename,rm,rmdir} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {publicProfile,matchingProfile} from './workspace-public.mjs';

const fields=new Set(['parameterPolicyVersion','profile','profiles','chats','projects','active','activeProject','sidebar','theme','inspector','presets','keys']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const token=id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)?id:'id-'+createHash('sha256').update(id).digest('hex');
export const projectPath=id=>'projects/'+token(id);
export const conversationPath=chat=>(chat.projectId?projectPath(chat.projectId)+'/':'')+'conversations/'+token(chat.id)+'.json';
export function validateWorkspace(value){
 if(!object(value)||Object.keys(value).some(key=>!fields.has(key)))throw new Error('工作空间数据格式无效');
 for(const name of ['profile'])if(value[name]!==undefined&&!object(value[name]))throw new Error('连接配置格式无效');
 if(value.profiles!==undefined&&(!Array.isArray(value.profiles)||!value.profiles.every(p=>object(p)&&typeof p.baseUrl==='string'&&typeof p.name==='string')))throw new Error('连接配置格式无效');
 if(value.chats!==undefined&&(!Array.isArray(value.chats)||!value.chats.every(c=>object(c)&&typeof c.id==='string'&&c.id.length>0&&typeof c.title==='string'&&Array.isArray(c.messages)&&c.messages.every(m=>object(m)&&typeof m.id==='string'&&['user','assistant','tool','system'].includes(m.role)&&(typeof m.content==='string'||Array.isArray(m.content)&&m.content.every(p=>object(p)&&(p.type==='text'&&typeof p.text==='string'||p.type==='image_url'&&object(p.image_url)&&typeof p.image_url.url==='string')))))))throw new Error('对话数据格式无效');
 if(value.chats&&new Set(value.chats.map(c=>c.id)).size!==value.chats.length)throw new Error('对话 ID 重复');
 if(value.projects!==undefined&&(!Array.isArray(value.projects)||!value.projects.every(p=>object(p)&&typeof p.id==='string'&&p.id.length>0&&typeof p.name==='string'&&p.name.trim().length>0&&p.name.length<=100&&(p.path===undefined||p.path===projectPath(p.id)))))throw new Error('项目数据格式无效');
 const projectIds=new Set((value.projects||[]).map(p=>p.id));if(projectIds.size!==(value.projects||[]).length)throw new Error('项目 ID 重复');
 if(value.chats?.some(c=>c.projectId!==undefined&&c.projectId!==''&&(!projectIds.has(c.projectId)||typeof c.projectId!=='string')))throw new Error('对话所属项目不存在');
 if(value.activeProject!==undefined&&typeof value.activeProject!=='string')throw new Error('项目数据格式无效');
 if(value.sidebar!==undefined&&(!object(value.sidebar)||!Array.isArray(value.sidebar.expandedProjects)||!value.sidebar.expandedProjects.every(id=>typeof id==='string')||!Number.isSafeInteger(value.sidebar.limit)||value.sidebar.limit<15||value.sidebar.limit>100000||value.sidebar.filter!==undefined&&typeof value.sidebar.filter!=='string'||value.sidebar.scrollTop!==undefined&&(!Number.isFinite(value.sidebar.scrollTop)||value.sidebar.scrollTop<0)))throw new Error('目录加载设置无效');
 if(value.presets!==undefined&&(!Array.isArray(value.presets)||!value.presets.every(p=>object(p)&&typeof p.name==='string'&&object(p.params))))throw new Error('预设格式无效');
 if(value.keys!==undefined&&(!object(value.keys)||!Object.entries(value.keys).every(([base,key])=>{try{return (/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(base)||['http:','https:'].includes(new URL(base).protocol))&&!['constructor','prototype','__proto__'].includes(base)&&typeof key==='string'&&key.length<=16000&&!/[\r\n]/.test(key);}catch{return false;}})))throw new Error('API Key 格式不正确');
 if(value.active!==undefined&&typeof value.active!=='string'||value.theme!==undefined&&!['light','dark'].includes(value.theme)||value.inspector!==undefined&&typeof value.inspector!=='boolean')throw new Error('工作空间数据格式无效');
 return structuredClone(value);
}

// The index commits a collection of independent project/chat files. A small
// write-ahead journal lets a restarted process finish interrupted multi-file saves.
export function createWorkspaceStore(filePath){
 filePath=resolve(filePath);const root=dirname(filePath),journalPath=filePath+'.pending.json';let queue=Promise.resolve();
 const enqueue=work=>{const operation=queue.then(work);queue=operation.then(()=>{},()=>{});return operation;};
 const target=path=>{const full=resolve(root,path);if(!full.startsWith(root+sep)||! /^(?:conversations\/[a-z0-9-]+\.json|projects\/[a-z0-9-]+\/(?:project\.json|conversations\/[a-z0-9-]+\.json))$/.test(path))throw new Error('存储路径无效');return full;};
 const read=async path=>JSON.parse(await readFile(path,'utf8'));
 const atomicWrite=async(path,value)=>{await mkdir(dirname(path),{recursive:true});const temporary=path+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,JSON.stringify(value),{encoding:'utf8',mode:0o600});await rename(temporary,path);}finally{await rm(temporary,{force:true});}};
 const etag=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const projectRef=p=>({id:p.id,name:p.name,created:p.created,path:projectPath(p.id)+'/project.json',_etag:etag(p)});
 const chatRef=c=>({id:c.id,title:c.title,created:c.created,model:c.model,projectId:c.projectId||'',path:conversationPath(c),_etag:etag(c)});
 const indexFor=record=>({...record,catalogVersion:1,data:{...record.data,projects:(record.data.projects||[]).map(projectRef),chats:(record.data.chats||[]).map(chatRef)}});
 const entries=data=>[...(data.projects||[]).map(p=>({path:projectPath(p.id)+'/project.json',value:p})),...(data.chats||[]).map(c=>({path:conversationPath(c),value:c}))];
 const validateIndex=index=>{
  if(index.version!==2||!Number.isSafeInteger(index.revision)||index.revision<0||!Array.isArray(index.data?.projects)||!Array.isArray(index.data?.chats))throw new Error('服务器工作空间文件格式无效');
  validateWorkspace({...index.data,projects:[],chats:[]});
  const projects=new Set();for(const p of index.data.projects){if(typeof p.id!=='string'||p.path!==projectPath(p.id)+'/project.json'||projects.has(p.id))throw new Error('项目数据格式无效');target(p.path);projects.add(p.id);}
  const chats=new Set();for(const c of index.data.chats){if(typeof c.id!=='string'||c.path!==conversationPath(c)||chats.has(c.id)||c.projectId&&!projects.has(c.projectId))throw new Error('对话数据格式无效');target(c.path);chats.add(c.id);}
 };
 const finish=async journal=>{
  validateIndex(journal.index);if(journal.version!==1||!Array.isArray(journal.writes)||!Array.isArray(journal.removals))throw new Error('保存恢复记录无效');
  const expected=new Map([...journal.index.data.projects,...journal.index.data.chats].map(item=>[item.path,item.id]));
  for(const write of journal.writes)if(!object(write.value)||expected.get(write.path)!==write.value.id)throw new Error('保存恢复记录无效');else target(write.path);
  for(const path of journal.removals){target(path);if(expected.has(path))throw new Error('保存恢复记录无效');}
  for(const write of journal.writes)await atomicWrite(target(write.path),write.value);
  await atomicWrite(filePath,journal.index);
  for(const path of journal.removals)await rm(target(path),{force:true});
  // Remove empty project directories after moving their last conversation.
  for(const path of journal.removals){const parent=dirname(target(path));for(const directory of [parent,dirname(parent)])if(directory.startsWith(resolve(root,'projects')+sep))try{await rmdir(directory);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;}}
  await rm(journalPath,{force:true});
 };
 const recover=async()=>{let journal;try{journal=await read(journalPath);}catch(error){if(error.code==='ENOENT')return;throw error;}await finish(journal);};
 const commit=async(previous,record)=>{
  const before=new Map(entries(previous.data).map(entry=>[entry.path,entry.value])),after=entries(record.data),paths=new Set(after.map(entry=>entry.path));
  const journal={version:1,index:indexFor(record),writes:after.filter(entry=>JSON.stringify(before.get(entry.path))!==JSON.stringify(entry.value)),removals:[...before.keys()].filter(path=>!paths.has(path))};
  await atomicWrite(journalPath,journal);await finish(journal);
 };
 const materialize=async index=>{
  validateIndex(index);
  const projects=await Promise.all(index.data.projects.map(async p=>{const value=await read(target(p.path));if(value.id!==p.id||value.path!==projectPath(p.id))throw new Error('项目数据格式无效');return value;}));
  const chats=await Promise.all(index.data.chats.map(async c=>{const value=await read(target(c.path));if(value.id!==c.id||conversationPath(value)!==c.path)throw new Error('对话数据格式无效');return value;}));
  const record={...index,data:{...index.data,projects,chats}};validateWorkspace(record.data);return record;
 };
 const loadIndex=async()=>{
  await recover();let index;try{index=await read(filePath);}catch(error){
   if(error.code!=='ENOENT')throw error;
   return {version:2,revision:0,data:{}};
  }
  if(index.version===1){
   if(!Number.isSafeInteger(index.revision)||index.revision<0)throw new Error('服务器工作空间文件格式无效');validateWorkspace(index.data);
   const record={...index,version:2,data:{...index.data,projects:(index.data.projects||[]).map(p=>({...p,path:projectPath(p.id)}))}};
   try{await writeFile(filePath+'.v1.bak',JSON.stringify(index),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
   await commit({data:{}},record);return indexFor(record);
  }
  validateIndex(index);
  if(index.catalogVersion!==1){index=indexFor(await materialize(index));await atomicWrite(filePath,index);}
  return index;
 };
 const load=async()=>{const index=await loadIndex();return index.revision===0&&!index.data.chats?index:materialize(index);};
 const page=(index,options={})=>{
  const projects=(index.data.projects||[]).map(p=>({id:p.id,name:p.name,created:p.created,path:projectPath(p.id),_etag:p._etag})),ids=new Set(projects.map(p=>p.id));
  const saved=index.data.sidebar||{limit:15,expandedProjects:ids.has(index.data.activeProject)?[index.data.activeProject]:[],scrollTop:0};
  const expanded=[...new Set(options.expandedProjects??saved.expandedProjects)].filter(id=>ids.has(id));
  const limit=Math.trunc(Math.max(15,Math.min(100000,Number(options.limit??saved.limit)||15))),focus=options.focus??index.data.activeProject;
  const priority=focus===''?['',...expanded]:[...(expanded.includes(focus)?[focus]:[]),...expanded.filter(id=>id!==focus),''];
  const queryFilter=String(options.filter??saved.filter??''),filter=queryFilter.toLowerCase(),all=index.data.chats||[],counts=Object.fromEntries(['',...ids].map(id=>[id,0])),groups=new Map(priority.map(id=>[id,[]]));
  for(const chat of all){const id=chat.projectId||'';counts[id]=(counts[id]||0)+1;if(groups.has(id)&&(!filter||chat.title.toLowerCase().includes(filter)))groups.get(id).push(chat);}
  const eligible=priority.flatMap(id=>{const group=groups.get(id),active=group.find(c=>c.id===index.data.active);return active?[active,...group.filter(c=>c!==active)]:group;});
  const visible=eligible.slice(0,limit),summaries=visible.map(({path,...c})=>c);
  return {...index,partial:true,data:{...index.data,projects,chats:summaries,sidebar:{...saved,expandedProjects:expanded,limit,filter:queryFilter}},listing:{ids:visible.map(c=>c.id),limit,expandedProjects:expanded,total:all.length,eligible:eligible.length,remaining:Math.max(0,eligible.length-visible.length),counts},activeId:all.some(c=>c.id===index.data.active)?index.data.active:visible[0]?.id||all[0]?.id||''};
 };
 const getChatFrom=async(index,id)=>{const ref=(index.data.chats||[]).find(c=>c.id===id);if(!ref)throw Object.assign(new Error('对话不存在'),{status:404});const chat=await read(target(ref.path));return {chat,_etag:ref._etag,revision:index.revision};};
 const patch=async changes=>{
  if(!object(changes)||!object(changes.settings||{})||!Array.isArray(changes.chats||[])||!Array.isArray(changes.projects||[])||!Array.isArray(changes.moves||[]))throw new Error('工作空间数据格式无效');
  const index=await loadIndex();index.data.chats=index.data.chats||[];index.data.projects=index.data.projects||[];
  const conflicts=[],writes=new Map(),removals=new Set(),etags={},projectEtags={},remaps={chats:{},profiles:{}};
  const settings=changes.settings||{},settingsBase=changes.settingsBase||{};
  if(Object.keys(settings).some(key=>!fields.has(key)||['chats','projects'].includes(key)))throw new Error('工作空间数据格式无效');
  validateWorkspace({...settings,chats:[],projects:[]});
  for(const key of ['keys','presets'])if(Object.hasOwn(settings,key)&&Object.hasOwn(settingsBase,key)&&JSON.stringify(index.data[key])!==JSON.stringify(settingsBase[key])&&JSON.stringify(index.data[key])!==JSON.stringify(settings[key]))conflicts.push(key);
  for(const p of changes.projects||[]){const old=index.data.projects.find(v=>v.id===p.id);if((old?._etag??null)!==(p.baseEtag??null))conflicts.push('projects:'+p.id);}
  if(conflicts.length)return {conflict:true,conflicts,record:page(index)};
  if(!Array.isArray(changes.profiles||[]))throw new Error('连接配置格式无效');
  index.data.profiles=index.data.profiles||[];index.data.keys={...index.data.keys};
  const profileEtag=p=>etag({...publicProfile(p,index.data.keys),hasKey:undefined,secret:index.data.keys[p.id]??index.data.keys[p.baseUrl]??''});
  for(const change of changes.profiles||[]){
   if(typeof change.id!=='string'||!change.id||['constructor','prototype','__proto__'].includes(change.id))throw new Error('连接 ID 无效');
   let old=index.data.profiles.find(p=>p.id===change.id),id=change.id;
   const stale=(old?profileEtag(old):null)!==(change.baseEtag??null);
   if(change.deleted){if(stale){conflicts.push('profiles:'+id);continue;}index.data.profiles=index.data.profiles.filter(p=>p.id!==id);delete index.data.keys[id];continue;}
   let profile={...change.profile,id,mode:'proxy'};delete profile._etag;delete profile.hasKey;delete profile.apiKey;
   validateWorkspace({profiles:[profile]});
   const previousKey=old?(index.data.keys[id]??index.data.keys[old.baseUrl]??''):'';
   let key=Object.hasOwn(change,'apiKey')?change.apiKey:previousKey;validateWorkspace({keys:{[id]:key}});
   if(stale&&(!old||JSON.stringify(publicProfile(profile,{}))!==JSON.stringify(publicProfile(old,{}))||key!==previousKey)){id=randomUUID();remaps.profiles[change.id]=id;profile={...profile,id,name:profile.name+(old?'（冲突副本）':'（恢复副本）')};conflicts.push('profiles:'+change.id);old=null;}
   index.data.profiles=old?index.data.profiles.map(p=>p.id===id?profile:p):[...index.data.profiles,profile];
   index.data.keys[id]=key;
  }
  if(changes.clearKeys===true)index.data.keys={};
  const deletedProjects=new Set();
  for(const change of changes.projects||[]){const old=index.data.projects.find(p=>p.id===change.id);
   if(change.deleted){if(old){deletedProjects.add(old.id);removals.add(old.path);index.data.projects=index.data.projects.filter(p=>p.id!==old.id);}continue;}
   const project={...change.project,path:projectPath(change.id)};if(project.id!==change.id)throw new Error('项目数据格式无效');validateWorkspace({projects:[project]});
   const ref=projectRef(project);index.data.projects=old?index.data.projects.map(p=>p.id===ref.id?ref:p):[...index.data.projects,ref];writes.set(ref.path,project);projectEtags[ref.id]=ref._etag;
  }
  const projectValues=()=>index.data.projects.map(p=>({id:p.id,name:p.name,path:projectPath(p.id)}));
  const saveChat=chat=>{
   validateWorkspace({chats:[chat],projects:projectValues()});const old=index.data.chats.find(c=>c.id===chat.id),ref=chatRef(chat);
   if(old&&old.path!==ref.path){removals.add(old.path);writes.delete(old.path);}
   index.data.chats=old?index.data.chats.map(c=>c.id===ref.id?ref:c):[ref,...index.data.chats];writes.set(ref.path,chat);etags[chat.id]=ref._etag;
  };
  for(const change of changes.chats||[]){const old=index.data.chats.find(c=>c.id===change.id);
   const stale=(old?._etag??null)!==(change.baseEtag??null);
   if(change.deleted){if(stale){conflicts.push('chats:'+change.id);continue;}if(old){removals.add(old.path);index.data.chats=index.data.chats.filter(c=>c.id!==change.id);}continue;}
   let chat;if(change.chat){chat=change.chat;if(chat.id!==change.id)throw new Error('对话数据格式无效');}
   else{if(!old)throw new Error('对话不存在');chat={...(await read(target(old.path))),...Object.fromEntries(['projectId','title'].filter(k=>Object.hasOwn(change,k)).map(k=>[k,change[k]]))};}
   if(stale&&(!old||etag(chat)!==old._etag)){const id=randomUUID();remaps.chats[change.id]=id;chat={...chat,id,title:chat.title+(old?'（冲突副本）':'（恢复副本）')};conflicts.push('chats:'+change.id);}
   if(chat.projectId&&!index.data.projects.some(p=>p.id===chat.projectId))chat={...chat,projectId:''};saveChat(chat);
  }
  for(const move of changes.moves||[]){if(typeof move.from!=='string'||typeof move.to!=='string')throw new Error('项目数据格式无效');if(move.to&&!index.data.projects.some(p=>p.id===move.to))throw new Error('对话所属项目不存在');
   for(const ref of [...index.data.chats])if(move.from==='*'||(ref.projectId||'')===move.from){const chat=writes.get(ref.path)||await read(target(ref.path));saveChat({...chat,projectId:move.to});}
  }
  for(const ref of [...index.data.chats])if(deletedProjects.has(ref.projectId)){const chat=writes.get(ref.path)||await read(target(ref.path));saveChat({...chat,projectId:''});}
  if(settings.profile?.id&&remaps.profiles[settings.profile.id])settings.profile={...settings.profile,id:remaps.profiles[settings.profile.id]};
  if(settings.active&&remaps.chats[settings.active])settings.active=remaps.chats[settings.active];
  if(remaps.chats[index.data.active])index.data.active=remaps.chats[index.data.active];
  if(remaps.profiles[index.data.profile?.id])index.data.profile={...index.data.profile,id:remaps.profiles[index.data.profile.id]};
  Object.assign(index.data,settings);index.revision++;index.updatedAt=new Date().toISOString();index.catalogVersion=1;
  for(const path of writes.keys())removals.delete(path);
  const journal={version:1,index,writes:[...writes].map(([path,value])=>({path,value})),removals:[...removals]};await atomicWrite(journalPath,journal);await finish(journal);
  return {record:withProfileEtags(page(index)),etags,projectEtags,remaps,conflicts};
 };
 const withProfileEtags=record=>({...record,data:{...record.data,profiles:(record.data.profiles||[]).map(p=>({...p,_etag:etag({...publicProfile(p,record.data.keys),hasKey:undefined,secret:record.data.keys?.[p.id]??record.data.keys?.[p.baseUrl]??''})}))}});
 return {get:()=>enqueue(load),revision:()=>enqueue(async()=>(await loadIndex()).revision),keyFor:(base,id)=>enqueue(async()=>{const {data}=await loadIndex();const p=matchingProfile(data.profiles||[],base,id);return p?(data.keys?.[p.id]??data.keys?.[p.baseUrl]??''):'';}),getSidebar:options=>enqueue(async()=>withProfileEtags(page(await loadIndex(),options))),getChat:id=>enqueue(async()=>getChatFrom(await loadIndex(),id)),patch:changes=>enqueue(()=>patch(changes)),update:(revision,data)=>enqueue(async()=>{
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error('工作空间版本无效');
  const clean=validateWorkspace(data),previous=await load();if(revision!==previous.revision)return {conflict:true,record:previous};
  if(!Object.hasOwn(clean,'keys')&&previous.data.keys)clean.keys=previous.data.keys;
  clean.projects=(clean.projects||[]).map(p=>({...p,path:projectPath(p.id)}));clean.chats=clean.chats||[];
  const record={version:2,revision:previous.revision+1,data:clean,updatedAt:new Date().toISOString()};await commit(previous,record);return {record};
 })};
}
