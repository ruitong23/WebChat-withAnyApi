// API text helpers. Estimates are explicitly approximate and independent of SSE
// packet boundaries; a transport chunk is never treated as a model token.
export function responseText(value){
 if(typeof value==='string')return value;
 if(value&&typeof value==='object'&&!Array.isArray(value))return typeof value.text==='string'?value.text:typeof value.content==='string'?value.content:typeof value.summary==='string'?value.summary:'';
 if(!Array.isArray(value))return '';
 return value.map(part=>typeof part==='string'?part:typeof part?.text==='string'?part.text:typeof part?.content==='string'?part.content:'').join('');
}
export function apiDeltaText(delta){
 const parts=Array.isArray(delta.content)?delta.content:null;
 const isReason=part=>typeof part==='object'&&/reason|think/i.test(part?.type||'');
 return {content:responseText(parts?parts.filter(p=>!isReason(p)):delta.content),reasoning:responseText(delta.reasoning_content??delta.reasoning??delta.thinking)||responseText(delta.reasoning_details)||responseText(parts?.filter(isReason))};
}
export function splitThinking(raw,{final=false}={}){
 let body='',reasoning='',thinking=false,pos=0;
 const tags=/<\/?(?:think|thinking)>/gi;let match;
 while((match=tags.exec(raw))){const part=raw.slice(pos,match.index);if(thinking)reasoning+=part;else body+=part;thinking=!match[0].startsWith('</');pos=tags.lastIndex;}
 let tail=raw.slice(pos);
 // A tag may be split across network frames, including its leading '<'.
 const partial=tail.match(/<(?:\/?(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?)?$/i);
 if(!final&&partial&&partial[0]&&partial.index!==undefined)tail=tail.slice(0,partial.index);
 if(thinking)reasoning+=tail;else body+=tail;
 return {content:body,reasoning,thinking};
}
export function createThinkingParser(){
 let thinking=false,pending='';
 const tags=['<think>','</think>','<thinking>','</thinking>'];
 return {push(chunk,{final=false}={}){
  const text=pending+chunk;pending='';let content='',reasoning='',pos=0,match;
  const expression=/<\/?(?:think|thinking)>/gi;
  while((match=expression.exec(text))){const part=text.slice(pos,match.index);if(thinking)reasoning+=part;else content+=part;thinking=!match[0].startsWith('</');pos=expression.lastIndex;}
  let tail=text.slice(pos);
  if(!final){const start=tail.lastIndexOf('<');if(start>=0&&tags.some(tag=>tag.startsWith(tail.slice(start).toLowerCase()))){pending=tail.slice(start);tail=tail.slice(0,start);}}
  if(thinking)reasoning+=tail;else content+=tail;
  return {content,reasoning,thinking,pendingLength:pending.length};
 }};
}
function estimateUnits(text){let units=0,chars=0;for(const char of text){chars++;units+=/[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(char)?1:char.codePointAt(0)>0xffff?1:.25;}return {units,chars};}
export function addReceivedText(message,text){if(!text)return;const count=estimateUnits(text);message.receivedTextChars=(message.receivedTextChars||0)+count.chars;message.receivedEstimateUnits=(message.receivedEstimateUnits||0)+count.units;}
const receptionCache=new WeakMap();
export function estimatedTokens(text){
 if(!text)return 0;
 let units=0;for(const char of text)units+=/[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(char)?1:char.codePointAt(0)>0xffff?1:.25;
 return Math.ceil(units);
}
export function receptionStats(message){
 if(!message)return {chars:0,tokens:0,exact:false,events:0};
 if(message.received&&(message.error||message.status==='stopped'||message.status==='interrupted'))return message.received;
 if(message.error)return {chars:0,tokens:0,exact:false,events:message.receivedEvents||0};
 const usage=message.usage||{};
 const reported=usage.completion_tokens??usage.output_tokens;
 const exact=typeof reported==='number'&&Number.isFinite(reported)&&reported>=0;
 if(message.receivedTextChars!==undefined)return {chars:message.receivedTextChars,tokens:exact?reported:Math.ceil(message.receivedEstimateUnits||0),exact,events:message.receivedEvents||0};
 const key=[typeof message.content==='string'?message.content.length:message.content,typeof message.reasoning==='string'?message.reasoning.length:0,reported,message.receivedEvents,message.tool_calls];const old=receptionCache.get(message);if(old&&key.every((value,i)=>value===old.key[i]))return old.result;
 const count=estimateUnits(responseText(message.content)+(message.reasoning||'')+(message.tool_calls||[]).map(t=>t.function?.arguments||'').join(''));
 const result={chars:count.chars,tokens:exact?reported:Math.ceil(count.units),exact,events:message.receivedEvents||0};receptionCache.set(message,{key,result});return result;
}
