import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeBase} from './relay.js';
export const parameterRules={
 temperature:[0,2],top_p:[0,1],top_k:[0,10000],max_tokens:[0,2000000],repeat_penalty:[0,3],presence_penalty:[-2,2],frequency_penalty:[-2,2],seed:[-1,4294967295],history:[0,10000],context_length:[1,10000000],eval_batch_size:[1,1000000],num_experts:[0,10000],
 system:'string',stop:'string',reasoning:'string',extra:'string',tools:'string',stream:'boolean',json:'boolean',extended:'boolean',flash_attention:'boolean',offload_kv_cache_to_gpu:'boolean',include_usage:'boolean'
};
for(const name of ['temperature','top_p','top_k','max_tokens','repeat_penalty','presence_penalty','frequency_penalty','seed','stop','json','reasoning','context_length','eval_batch_size','flash_attention','offload_kv_cache_to_gpu','num_experts'])parameterRules['override_'+name]='boolean';
export function validatePatch(patch){
 if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('参数必须为对象');
 const clean={};
 for(const [key,value] of Object.entries(patch)){
  if(!Object.hasOwn(parameterRules,key))throw new Error('不支持的参数：'+key);
  const rule=parameterRules[key];
  if(Array.isArray(rule)){if(typeof value!=='number'||!Number.isFinite(value)||value<rule[0]||value>rule[1])throw new Error('参数超出范围：'+key);}
  else if(typeof value!==rule)throw new Error('参数类型不正确：'+key);
  if(typeof value==='string'&&value.length>100000)throw new Error('配置文本过长');
  if(key==='extra'){let parsed;try{parsed=JSON.parse(value||'{}');}catch{throw new Error('额外参数 JSON 无效');}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('额外参数必须为 JSON 对象');for(const restricted of ['model','messages','stream','tools'])if(Object.hasOwn(parsed,restricted))throw new Error('额外参数不能覆盖 '+restricted);}
  if(key==='tools'&&value.trim()){let parsed;try{parsed=JSON.parse(value);}catch{throw new Error('工具定义 JSON 无效');}if(!Array.isArray(parsed))throw new Error('工具定义必须为数组');}
  if(key==='reasoning'&&!['default','none','off','on','low','medium','high'].includes(value))throw new Error('思考强度无效');
  clean[key]=value;
 }
 return clean;
}
export function createModelConfigStore(filePath){
 let queue=Promise.resolve();
 const load=async()=>{try{const parsed=JSON.parse(await readFile(filePath,'utf8'));if(parsed.version!==1||typeof parsed.models!=='object'||!parsed.models)throw new Error('共享配置文件格式无效');return parsed;}catch(e){if(e.code==='ENOENT')return {version:1,models:{}};throw e;}};
 const identity=(baseUrl,model)=>{const source=normalizeBase(baseUrl);if(typeof model!=='string'||!model.trim()||model.length>1000)throw new Error('模型 ID 无效');return {source,model,key:createHash('sha256').update(JSON.stringify([source,model])).digest('hex')};};
 const empty=id=>({source:id.source,model:id.model,revision:0,params:{},updatedAt:null});
 return {
  async get(baseUrl,model){await queue;const id=identity(baseUrl,model),db=await load();return db.models[id.key]||empty(id);},
  update(baseUrl,model,expectedRevision,patch){const operation=queue.then(async()=>{const id=identity(baseUrl,model),clean=validatePatch(patch);if(!Number.isInteger(expectedRevision)||expectedRevision<0)throw new Error('配置版本无效');const db=await load(),previous=db.models[id.key]||empty(id);if(previous.revision!==expectedRevision)return {conflict:true,record:previous};const record={source:id.source,model:id.model,revision:previous.revision+1,params:{...previous.params,...clean},updatedAt:new Date().toISOString()};db.models[id.key]=record;await mkdir(dirname(filePath),{recursive:true});const temp=filePath+'.tmp';await writeFile(temp,JSON.stringify(db,null,2),'utf8');await rename(temp,filePath);return {record};});queue=operation.then(()=>{},()=>{});return operation;}
 };
}
