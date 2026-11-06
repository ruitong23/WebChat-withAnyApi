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

export function matchingProfile(profiles,base,id){
 const normalized=normalizeBase(base);
 return (id?profiles.filter(p=>p.id===id):profiles).find(p=>[p.baseUrl,p.nativeUrl].filter(Boolean).some(url=>normalizeBase(url)===normalized));
}
