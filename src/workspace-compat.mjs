import {normalizeBase} from './relay.js';

// These are response projections, never the values used for disk commits.
export function publicProfile(profile,keys={}){
 if(!profile)return profile;
 const {apiKey,hasKey,_etag,...value}=profile;
 return {...value,hasKey:!!(keys[value.id]??keys[value.baseUrl]??apiKey)};
}
export function publicRecord(record){
 if(!record?.data)return record;
 const {keys={},...data}=record.data;
 const profiles=(data.profiles||[]).map(p=>({...publicProfile(p,keys),_etag:p._etag}));
 const selected=profiles.find(p=>p.id===data.profile?.id)||data.profile;
 return {...record,data:{...data,profiles,profile:selected?{...publicProfile(selected,keys),...(selected._etag?{_etag:selected._etag}:{})}:undefined}};
}
export function publicResult(result){return result.record?{...result,record:publicRecord(result.record)}:result;}

export async function readLegacySQLite(path){
 let DatabaseSync;
 try{({DatabaseSync}=await import('node:sqlite'));}catch{throw new Error('迁移旧 SQLite 数据需要 Node.js 22.13 或更高版本');}
 // A read transaction includes committed WAL pages and gives one consistent snapshot.
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  db.exec('PRAGMA busy_timeout=5000; BEGIN');
  const rows=db.prepare('SELECT kind,id,value FROM items ORDER BY updated DESC,id').all();
  const data={chats:[],profiles:[],projects:[],keys:{}};
  for(const row of rows){
   const {_revision,apiKey,...value}=JSON.parse(row.value);
   if(value.id!==row.id)throw new Error('旧数据库中的记录 ID 不一致');
   if(row.kind==='chat'){value.messages=value.messages.map(m=>({...m,content:m.content??''}));data.chats.push(value);}
   else if(row.kind==='profile'){
    data.profiles.push({...value,mode:'proxy',remember:!!apiKey});
    if(apiKey)data.keys[value.id]=apiKey;
   }else throw new Error('旧数据库包含不支持的记录类型');
  }
  const revision=Number(db.prepare("SELECT value FROM meta WHERE key='revision'").get().value);
  data.profile=data.profiles[0];if(!data.profile)delete data.profile;
  data.active=data.chats[0]?.id||'';
  db.exec('COMMIT');
  return {version:2,revision:Math.max(1,revision),data,migratedFrom:'sqlite',updatedAt:new Date().toISOString()};
 }finally{db.close();}
}

export function matchingProfile(profiles,base,id){
 const normalized=normalizeBase(base);
 return (id?profiles.filter(p=>p.id===id):profiles).find(p=>[p.baseUrl,p.nativeUrl].filter(Boolean).some(url=>normalizeBase(url)===normalized));
}
