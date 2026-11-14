import {test} from 'node:test';
import assert from 'node:assert/strict';
import {relay} from '../src/relay.js';
import {vertexBase,vertexModels,isVertexBase,vertexPayload,vertexModel} from '../src/vertex-express.js';
const request=(path,payload,extra={})=>new Request('https://studio.test/api/relay',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://studio.test'},body:JSON.stringify({baseUrl:vertexBase,path,apiKey:'test-vertex-key',payload,...extra})});
const body=(text,finishReason='STOP',usageMetadata)=>({candidates:[{index:0,content:{role:'model',parts:[{text}]},finishReason}],usageMetadata});
const frame=value=>'data: '+JSON.stringify(value)+'\r\n\r\n';

test('Express key validation uses countTokens, the global native endpoint and a private header',async()=>{
 let calls=0;const result=await relay(request('/v1/models'),{fetch:async(url,options)=>{
  calls++;assert.equal(url,vertexBase+'/v1/publishers/google/models/'+vertexModels[0]+':countTokens');assert(!url.includes('test-vertex-key'));assert.equal(options.method,'POST');assert.equal(options.headers['x-goog-api-key'],'test-vertex-key');assert.equal(options.headers.Authorization,undefined);assert.equal(options.redirect,'manual');assert.deepEqual(JSON.parse(options.body),{contents:[{role:'user',parts:[{text:'Hello'}]}]});return Response.json({totalTokens:1});
 }});assert.equal(result.status,200);const value=await result.json();assert.equal(value.modelListSource,'preset');assert.equal(value.data[0].id,vertexModels[0]);assert.equal(calls,1);assert(!JSON.stringify(value).includes('test-vertex-key'));
 assert(isVertexBase(vertexBase+'/v1'));assert(!isVertexBase('https://aiplatform.googleapis.com.evil.test'));assert.throws(()=>vertexModel('../secret'));assert.equal(vertexModel('publishers/google/models/gemini-2.5-pro'),'gemini-2.5-pro');
});
test('Express rejects wrong/empty keys, redirects and invalid model paths before generation',async()=>{
 const bad=await relay(request('/v1/models'),{fetch:async()=>Response.json({error:{message:'Invalid test-vertex-key'}},{status:401})});assert.equal(bad.status,401);assert(!JSON.stringify(await bad.json()).includes('test-vertex-key'));
 assert.equal((await relay(request('/v1/models',null,{apiKey:''}),{fetch:()=>assert.fail('must not fetch')})).status,400);
 assert.equal((await relay(request('/v1/chat/completions',{model:'../bad',messages:[]}),{fetch:()=>assert.fail('must not fetch')})).status,502);
 assert.equal((await relay(request('/api/v1/models'),{fetch:()=>assert.fail('must not fetch')})).status,400);
 assert.equal((await relay(request('/v1/models'),{fetch:async()=>new Response(null,{status:302})})).status,502);
});
test('native message, image, system and optional parameter mapping keeps defaults unbounded',()=>{
 const converted=vertexPayload({model:vertexModels[0],stream:true,messages:[{role:'system',content:'Novel setting'},{role:'user',content:[{type:'text',text:'Continue'},{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}]},{role:'assistant',content:'Previous chapter'},{role:'user',content:'Next chapter'}]});
 assert.deepEqual(converted.systemInstruction,{parts:[{text:'Novel setting'}]});assert.equal(converted.contents[1].role,'model');assert.deepEqual(converted.contents[0].parts[1],{inlineData:{mimeType:'image/png',data:'AAAA'}});assert.equal(converted.generationConfig.maxOutputTokens,undefined);assert.equal(converted.generationConfig.temperature,undefined);assert.equal(converted.generationConfig.thinkingConfig.thinkingBudget,undefined);
 const configured=vertexPayload({messages:[],model:vertexModels[0],temperature:.4,top_p:.9,top_k:20,max_tokens:8000,stop:['END'],reasoning_effort:'low',response_format:{type:'json_object'},generationConfig:{seed:123}}).generationConfig;
 assert.equal(configured.maxOutputTokens,8000);assert.equal(configured.temperature,.4);assert.equal(configured.thinkingConfig.thinkingBudget,1024);assert.equal(configured.responseMimeType,'application/json');assert.deepEqual(configured.stopSequences,['END']);assert.equal(configured.seed,123);
 assert.throws(()=>vertexPayload({messages:[],repeat_penalty:1.1}),/repeat_penalty/);
});
test('signed tool calls and results survive a native history round trip without duplicating text',()=>{
 const call={functionCall:{name:'lookup',args:{person:'A'}},thoughtSignature:'test-signature'};
 const converted=vertexPayload({model:vertexModels[0],messages:[{role:'assistant',content:'Look up A.',tool_calls:[{id:'call',function:{name:'lookup',arguments:'{"person":"A"}'}}],vertex_parts:[{offset:10,part:call}]},{role:'tool',tool_call_id:'call',content:'{"age":20}'},{role:'user',content:'Continue'}],tools:[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{person:{type:'string'}}}}}]});
 assert.deepEqual(converted.contents[0].parts,[{text:'Look up A.'},call]);assert.deepEqual(converted.contents[1].parts,[{functionResponse:{name:'lookup',response:{age:20}}}]);assert.equal(converted.tools[0].functionDeclarations[0].parametersJsonSchema.type,'object');
});
test('native SSE is delivered incrementally, handles split UTF-8/CRLF, thoughts, usage and completion',async()=>{
 let upstream;const source=new ReadableStream({start(c){upstream=c;}}),encoder=new TextEncoder();
 const result=await relay(request('/v1/chat/completions',{model:vertexModels[0],stream:true,messages:[{role:'user',content:'Write'}]}),{fetch:async(url,options)=>{assert.equal(url,vertexBase+'/v1/publishers/google/models/'+vertexModels[0]+':streamGenerateContent?alt=sse');assert.equal(JSON.parse(options.body).contents[0].parts[0].text,'Write');return new Response(source,{headers:{'Content-Type':'text/event-stream'}});}});
 const reader=result.body.getReader();upstream.enqueue(encoder.encode(frame({candidates:[{index:0,content:{parts:[{text:'Think',thought:true}]}}]})));
 const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/reasoning_content/);assert(!first.includes('[DONE]'));
 const native=encoder.encode(frame({candidates:[{content:{parts:[{text:'你好 **剧情**'}]}}]})+frame(body('', 'MAX_TOKENS',{promptTokenCount:12,candidatesTokenCount:8,thoughtsTokenCount:3,cachedContentTokenCount:5,totalTokenCount:23})));
 for(let i=0;i<native.length;i+=7)upstream.enqueue(native.slice(i,i+7));upstream.close();let rest='';while(true){const next=await reader.read();if(next.done)break;rest+=new TextDecoder().decode(next.value);}
 assert.match(rest,/你好 \*\*剧情\*\*/);assert.match(rest,/"finish_reason":"length"/);assert.match(rest,/"completion_tokens":11/);assert.match(rest,/"cached_tokens":5/);assert.match(rest,/\[DONE\]/);
});
test('native non-streamed and JSON-array fallback responses use the existing chat schema',async()=>{
 for(const stream of [false,true]){
  const raw=stream?[{candidates:[{content:{parts:[{text:'First '}]}}]},body('last')]:body('Full answer');
  const result=await relay(request('/v1/chat/completions',{model:vertexModels[0],stream,messages:[{role:'user',content:'Hi'}]}),{fetch:async()=>Response.json(raw)});
  assert.equal(result.status,200);const value=await result.json();assert.equal(value.choices[0].message.content,stream?'First last':'Full answer');assert.equal(value.choices[0].finish_reason,'stop');
 }
});
test('early disconnect and safety/native errors never invent a successful stream ending',async()=>{
 for(const tail of ['',frame({error:{message:'Invalid test-vertex-key'}}),frame(body('','SAFETY'))]){
  const result=await relay(request('/v1/chat/completions',{model:vertexModels[0],stream:true,messages:[]}),{fetch:async()=>new Response(frame({candidates:[{content:{parts:[{text:'Partial answer'}]}}]})+tail,{headers:{'Content-Type':'text/event-stream'}})});
  const text=await result.text();assert.match(text,/Partial answer/);assert.match(text,/error/);assert(!text.includes('[DONE]'));assert(!text.includes('test-vertex-key'));
 }
});
