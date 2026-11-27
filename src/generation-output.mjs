import {apiDeltaText,createThinkingParser,addReceivedText,receptionStats} from './response-utils.js';

export const outputTokenLimit=30000;
export async function readGenerationOutput(response,message,{onUpdate=()=>{},stop=()=>{},limit=outputTokenLimit}={}){
 const parser=createThinkingParser(),tools=new Map();let sawDone=false,limited=false;
 const clipped=text=>{
  const remaining=Math.max(0,limit-(message.receivedEstimateUnits||0));let units=0,end=0;
  for(const char of text){const weight=/[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(char)?1:char.codePointAt(0)>0xffff?1:.25;if(units+weight>remaining)break;units+=weight;end+=char.length;}
  if(end<text.length){limited=true;message.stopReason='output_limit';message.outputTokenLimit=limit;stop();}return text.slice(0,end);
 };
 const accept=(content='',reasoning='')=>{
  content=clipped(content);message.content+=content;addReceivedText(message,content);reasoning=clipped(reasoning);if(reasoning){message.reasoning=(message.reasoning||'')+reasoning;message.reasoningPreview=message.reasoning.slice(-240);}addReceivedText(message,reasoning);message.thinking=!!message.reasoning&&!message.content;
  if(Math.ceil(message.receivedEstimateUnits||0)>=limit){limited=true;message.stopReason='output_limit';message.outputTokenLimit=limit;stop();}
 };
 const event=value=>{
  if(value.error)throw new Error(value.error.message||'接口返回错误');
  message.receivedEvents=(message.receivedEvents||0)+1;message.lastActivityAt=Date.now();
  if(value.usage)message.usage={...(message.usage||{}),...value.usage};
  const choice=value.choices?.[0]||{};if(choice.finish_reason||value.finish_reason||value.stop_reason)message.finishReason=choice.finish_reason||value.finish_reason||value.stop_reason;
  const delta=choice.delta||choice.message||{},fields=apiDeltaText(delta),parsed=parser.push(fields.content);accept(parsed.content,fields.reasoning+parsed.reasoning);
  if(delta.vertex_parts?.length)(message.vertexParts??=[]).push(...delta.vertex_parts.filter(saved=>saved.offset<=message.content.length&&(saved.part?.thought||saved.offset+(saved.part?.text||'').length<=message.content.length)));
  for(const [position,tool] of (delta.tool_calls||[]).entries()){const index=tool.index??(choice.message?position:0),old=tools.get(index)||{id:'',type:'function',function:{name:'',arguments:''}};if(tool.id)old.id=tool.id;if(tool.function?.name)old.function.name+=tool.function.name;if(tool.function?.arguments){const argumentsPart=clipped(tool.function.arguments);old.function.arguments+=argumentsPart;addReceivedText(message,argumentsPart);}tools.set(index,old);}
  if(tools.size)message.tool_calls=[...tools.values()];
  if(Math.ceil(message.receivedEstimateUnits||0)>=limit){limited=true;message.stopReason='output_limit';message.outputTokenLimit=limit;stop();}
  onUpdate();
 };
 if(response.headers.get('content-type')?.includes('text/event-stream')){
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  const frame=block=>{const raw=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!raw)return;if(raw.trim()==='[DONE]'){sawDone=true;return;}let value;try{value=JSON.parse(raw);}catch{throw new Error('API 流式响应格式无效（不是合法 JSON）');}event(value);};
  try{
   while(!limited&&!sawDone){const {value,done}=await reader.read();if(value?.length){message.receivedBytes=(message.receivedBytes||0)+value.length;message.lastActivityAt=Date.now();}buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});buffer=buffer.replace(/\r\n/g,'\n');let end;while(!limited&&!sawDone&&(end=buffer.indexOf('\n\n'))>=0){frame(buffer.slice(0,end));buffer=buffer.slice(end+2);}if(done){if(!limited&&buffer.trim())frame(buffer);break;}}
  }finally{if(limited||sawDone)await reader.cancel().catch(()=>{});reader.releaseLock();const tail=parser.push('',{final:true});accept(tail.content,tail.reasoning);onUpdate();}
  if(!limited&&!sawDone&&!message.finishReason)throw new Error('流连接在返回结束标记前断开，已保留全部已接收内容。可继续生成或重试。');
 }else{
  const raw=await response.text();message.receivedBytes=new TextEncoder().encode(raw).length;let value;try{value=JSON.parse(raw);}catch{throw new Error('接口返回格式无效');}
  if(!value.choices?.[0]?.message&&!value.error)throw new Error('响应缺少 choices[0].message');event(value);const tail=parser.push('',{final:true});accept(tail.content,tail.reasoning);
 }
 message.received=receptionStats(message);return {limited};
}
