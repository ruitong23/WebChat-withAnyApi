// Vertex AI Express uses native Gemini requests, not the AI Studio compatibility API.
export const vertexBase='https://aiplatform.googleapis.com';
export const vertexModels=['gemini-2.5-flash','gemini-2.5-pro','gemini-2.5-flash-lite','gemini-3-flash-preview','gemini-3.1-pro-preview'];
export const isVertexBase=raw=>{try{const u=new URL(raw);return u.origin===vertexBase&&['','/','/v1','/v1/','/v1beta1','/v1beta1/'].includes(u.pathname)&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}};
export function vertexModel(raw=vertexModels[0]){
 const id=String(raw||vertexModels[0]).replace(/^(?:publishers\/google\/models\/|google\/)/,'');
 if(!/^gemini-[a-zA-Z0-9._-]{1,100}$/.test(id))throw new Error('Vertex Express 模型 ID 无效');
 return id;
}
const textParts=value=>typeof value==='string'?(value?[{text:value}]:[]):(value||[]).map(p=>{
 if(p.type==='text')return {text:p.text};
 if(p.type==='image_url'){
  const match=p.image_url?.url?.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/);
  if(!match)throw new Error('Vertex Express 图片必须为上传的图片');
  return {inlineData:{mimeType:match[1],data:match[2].replace(/[\r\n]/g,'')}};
 }
 throw new Error('Vertex Express 不支持此消息内容');
});
const parseArgs=raw=>{const value=typeof raw==='string'?JSON.parse(raw||'{}'):raw||{};if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('工具参数必须为 JSON 对象');return value;};
export function vertexPayload(payload){
 if(!Array.isArray(payload.messages))throw new Error('Vertex Express 消息格式无效');
 const contents=[],system=[],calls=new Map();
 for(const m of payload.messages){
  if(m.role==='system'||m.role==='developer'){system.push(...textParts(m.content));continue;}
  if(m.role==='tool'){
   const name=calls.get(m.tool_call_id);if(!name)throw new Error('Vertex Express 工具结果缺少对应调用');
   let response;try{response=JSON.parse(m.content);}catch{response={result:m.content};}
   if(!response||typeof response!=='object'||Array.isArray(response))response={result:response};
   const part={functionResponse:{name,response}};
   if(contents.at(-1)?.role==='user'&&contents.at(-1).parts.every(p=>p.functionResponse))contents.at(-1).parts.push(part);else contents.push({role:'user',parts:[part]});continue;
  }
  let parts=textParts(m.content);
  if(m.role==='assistant'){
   for(const call of m.tool_calls||[])calls.set(call.id,call.function.name);
   // Preserve signed native parts at their original text offsets without storing
   // a second copy of an entire novel-length answer.
   if(m.vertex_parts?.length&&typeof m.content==='string'){
    parts=[];let offset=0;
    for(const saved of m.vertex_parts){
     if(!saved?.part||!Number.isSafeInteger(saved.offset)||saved.offset<offset||saved.offset>m.content.length)throw new Error('Vertex Express 历史签名格式无效');
     if(saved.offset>offset)parts.push({text:m.content.slice(offset,saved.offset)});
     parts.push(saved.part);offset=saved.offset+(saved.part.thought?0:(saved.part.text||'').length);
    }
    if(offset<m.content.length)parts.push({text:m.content.slice(offset)});
   }
   if(!parts.some(p=>p.functionCall))for(const call of m.tool_calls||[])parts.push({functionCall:{name:call.function.name,args:parseArgs(call.function.arguments)}});
  }else if(m.role!=='user')throw new Error('Vertex Express 消息角色无效');
  if(parts.length)contents.push({role:m.role==='assistant'?'model':'user',parts});
 }
 const generationConfig={thinkingConfig:{includeThoughts:true},...(payload.generationConfig||{})};
 const mapping={temperature:'temperature',top_p:'topP',top_k:'topK',max_tokens:'maxOutputTokens',max_completion_tokens:'maxOutputTokens',presence_penalty:'presencePenalty',frequency_penalty:'frequencyPenalty',seed:'seed'};
 for(const [source,target]of Object.entries(mapping))if(payload[source]!==undefined)generationConfig[target]=payload[source];
 if(payload.stop!==undefined)generationConfig.stopSequences=typeof payload.stop==='string'?[payload.stop]:payload.stop;
 if(payload.response_format)generationConfig.responseMimeType=payload.response_format.type==='text'?'text/plain':'application/json';
 if(payload.response_format?.json_schema?.schema)generationConfig.responseJsonSchema=payload.response_format.json_schema.schema;
 if(payload.reasoning_effort&&payload.reasoning_effort!=='default'){
  const effort=payload.reasoning_effort;const model=vertexModel(payload.model);
  generationConfig.thinkingConfig={includeThoughts:true,...(model.startsWith('gemini-2.5-')?{thinkingBudget:({none:0,low:1024,medium:8192,high:24576})[effort]}:{thinkingLevel:effort==='none'?'MINIMAL':effort.toUpperCase()})};
 }
 const body={contents,generationConfig};if(system.length)body.systemInstruction={parts:system};
 if(payload.tools?.length){
  const declarations=payload.tools.filter(t=>t.type==='function').map(t=>({name:t.function.name,...(t.function.description?{description:t.function.description}:{}),...(t.function.parameters?{parametersJsonSchema:t.function.parameters}:{})}));
  body.tools=[...(declarations.length?[{functionDeclarations:declarations}]:[]),...payload.tools.filter(t=>!t.type)];
 }
 if(payload.tool_choice){const choice=payload.tool_choice;body.toolConfig={functionCallingConfig:{mode:choice==='none'?'NONE':choice==='required'||choice?.type==='function'?'ANY':'AUTO',...(choice?.function?.name?{allowedFunctionNames:[choice.function.name]}:{})}};}
 for(const key of ['safetySettings','toolConfig','cachedContent','systemInstruction','labels'])if(payload[key]!==undefined)body[key]=payload[key];
 const supported=new Set(['model','messages','stream','stream_options','n','tools','tool_choice','response_format','reasoning_effort','stop','generationConfig','safetySettings','toolConfig','cachedContent','systemInstruction','labels',...Object.keys(mapping)]);
 for(const key of Object.keys(payload))if(!supported.has(key))throw new Error('Vertex Express 不支持参数：'+key);
 if(payload.n>1)throw new Error('Vertex Express 每次只支持一个回复');
 return body;
}
function usage(value){
 if(!value)return undefined;
 return {prompt_tokens:value.promptTokenCount||0,completion_tokens:(value.candidatesTokenCount||0)+(value.thoughtsTokenCount||0),total_tokens:value.totalTokenCount??((value.promptTokenCount||0)+(value.candidatesTokenCount||0)+(value.thoughtsTokenCount||0)),prompt_tokens_details:{cached_tokens:value.cachedContentTokenCount||0},completion_tokens_details:{reasoning_tokens:value.thoughtsTokenCount||0}};
}
export function vertexFrame(event,state){
 if(event.error)throw new Error(event.error.message||'Vertex Express 请求失败');
 if(event.promptFeedback?.blockReason)throw new Error('Vertex Express: '+event.promptFeedback.blockReason);
 const candidate=event.candidates?.find(c=>(c.index??0)===0),delta={};let content='',reasoning='';
 for(const part of candidate?.content?.parts||[]){
  if(part.functionCall||part.thoughtSignature)(delta.vertex_parts??=[]).push({offset:state.offset,part});
  if(part.text){if(part.thought)reasoning+=part.text;else{content+=part.text;state.offset+=part.text.length;}}
  if(part.functionCall){const call=part.functionCall;(delta.tool_calls??=[]).push({index:state.tools,id:'vertex-call-'+state.tools++,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args||{})}});}
 }
 if(content)delta.content=content;if(reasoning)delta.reasoning_content=reasoning;
 const reason=candidate?.finishReason;let finish=null;
 if(reason&&reason!=='FINISH_REASON_UNSPECIFIED'){
  if(!['STOP','MAX_TOKENS'].includes(reason))throw new Error('Vertex Express: '+reason+(candidate.finishMessage?' — '+candidate.finishMessage:''));
  finish=reason==='MAX_TOKENS'?'length':state.tools?'tool_calls':'stop';state.finished=true;
 }
 return {choices:[{index:0,delta,finish_reason:finish}],...(event.usageMetadata?{usage:usage(event.usageMetadata)}:{})};
}
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
export async function vertexRelay(data,request,options={}){
 const key=data.apiKey;if(typeof key!=='string'||!key.trim()||key.length>16000||/[\r\n]/.test(key))return json({error:{message:'请输入有效的 Vertex Express API Key'}},400);
 const redact=message=>String(message).replaceAll(key,'[REDACTED]');
 const fetcher=options.fetch||fetch,headers={'Content-Type':'application/json','x-goog-api-key':key};
 const probe=data.path==='/v1/models';
 if(!probe&&data.path!=='/v1/chat/completions')return json({error:{message:'Vertex Express 不支持此接口'}},400);
 const model=vertexModel(probe?data.vertexModel:data.payload?.model),stream=!probe&&data.payload?.stream===true;
 const url=vertexBase+'/v1/publishers/google/models/'+model+':'+(probe?'countTokens':stream?'streamGenerateContent?alt=sse':'generateContent');
 const payload=probe?{contents:[{role:'user',parts:[{text:'Hello'}]}]}:vertexPayload(data.payload||{});
 const response=await fetcher(url,{method:'POST',headers:{...headers,Accept:stream?'text/event-stream':'application/json'},body:JSON.stringify(payload),signal:probe?AbortSignal.any([request.signal,AbortSignal.timeout(20000)]):request.signal,redirect:'manual'});
 if(!response.ok){let message='Vertex Express 请求失败';try{const value=await response.json();message=value.error?.message||value.message||message;}catch{}
  return json({error:{message:redact(message)}},response.status>=300&&response.status<400?502:response.status);
 }
 if(probe){const result=await response.json();if(result.error||typeof result.totalTokens!=='number')return json({error:{message:redact(result.error?.message||'Vertex Express 验证响应无效')}},502);
  return json({data:[...new Set([model,...vertexModels])].map(id=>({id,object:'model',owned_by:'google',type:'llm'})),modelListSource:'preset'});
 }
 const state={offset:0,tools:0,finished:false};
 if(stream&&response.headers.get('content-type')?.includes('text/event-stream')){
  const decoder=new TextDecoder(),encoder=new TextEncoder();let buffer='';
  const frame=(block,controller)=>{
   const text=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!text||text==='[DONE]')return;
   const value=vertexFrame(JSON.parse(text),state);controller.enqueue(encoder.encode('data: '+JSON.stringify(value)+'\n\n'));
  };
  const failure=(error,controller)=>{controller.enqueue(encoder.encode('data: '+JSON.stringify({error:{message:redact(error.message)}})+'\n\n'));controller.terminate();};
  const transform=new TransformStream({transform(chunk,controller){
   try{buffer+=decoder.decode(chunk,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let end;
    while((end=buffer.indexOf('\n\n'))>=0){frame(buffer.slice(0,end),controller);buffer=buffer.slice(end+2);}
   }catch(error){failure(error,controller);}
  },flush(controller){try{buffer+=decoder.decode();if(buffer.trim())frame(buffer,controller);controller.enqueue(encoder.encode(state.finished?'data: [DONE]\n\n':'data: '+JSON.stringify({error:{message:'Vertex Express 流连接提前中断，已保留收到的内容'}})+'\n\n'));}catch(error){failure(error,controller);}}});
  return new Response(response.body.pipeThrough(transform),{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store'}});
 }
 const raw=await response.json(),message={role:'assistant',content:''};let finalUsage,finish;
 for(const event of Array.isArray(raw)?raw:[raw]){
  const value=vertexFrame(event,state),delta=value.choices[0].delta;message.content+=delta.content||'';
  if(delta.reasoning_content)message.reasoning_content=(message.reasoning_content||'')+delta.reasoning_content;
  if(delta.tool_calls)(message.tool_calls??=[]).push(...delta.tool_calls);
  if(delta.vertex_parts)(message.vertex_parts??=[]).push(...delta.vertex_parts);
  if(value.usage)finalUsage=value.usage;if(value.choices[0].finish_reason)finish=value.choices[0].finish_reason;
 }
 if(!state.finished)return json({error:{message:'Vertex Express 响应未包含完成状态'}},502);
 return json({choices:[{index:0,message,finish_reason:finish}],usage:finalUsage});
}
