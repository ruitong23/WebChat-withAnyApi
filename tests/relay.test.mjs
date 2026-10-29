import {test} from 'node:test';
import assert from 'node:assert/strict';
import {relay,normalizeBase} from '../src/relay.js';
const request=(data,extra={})=>new Request('https://studio.test/api/relay',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://studio.test',...extra.headers},body:JSON.stringify(data)});
test('normalize host, /v1, full completion endpoint and reverse proxy prefix',()=>{
 for(const [input,expected] of [['https://example.test/','https://example.test'],['https://example.test/v1/','https://example.test'],['https://example.test/llm/v1/chat/completions','https://example.test/llm'],['https://example.test/api/v1','https://example.test']])assert.equal(normalizeBase(input),expected);
 assert.throws(()=>normalizeBase('https://user:pass@example.test'));assert.throws(()=>normalizeBase('file:///etc/passwd'));
});
test('models discovery forwards bearer key only to supplied API and keeps server response',async()=>{
 let target,opts;const res=await relay(request({baseUrl:'https://example.test/v1',apiKey:'test-secret',path:'/v1/models'}),{fetch:async(url,options)=>{target=url;opts=options;return Response.json({data:[{id:'model-a'}]});}});
 assert.equal(target,'https://example.test/v1/models');assert.equal(opts.headers.Authorization,'Bearer test-secret');assert.equal(opts.method,'GET');assert.equal(opts.body,undefined);assert.equal(res.headers.get('Cache-Control'),'no-store');assert.deepEqual(await res.json(),{data:[{id:'model-a'}]});
});
test('supports streamed chat and parameter payload without buffering',async()=>{
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'));c.close();}});
 const payload={model:'model-a',messages:[{role:'user',content:'test'}],stream:true,temperature:.4};
 const res=await relay(request({baseUrl:'https://example.test',path:'/v1/chat/completions',payload}),{fetch:async(url,o)=>{assert.deepEqual(JSON.parse(o.body),payload);return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});}});
 assert.match(res.headers.get('content-type'),/event-stream/);assert.match(await res.text(),/你好/);
});
test('passes native management payloads and upstream 401 accurately',async()=>{
 const res=await relay(request({baseUrl:'https://example.test',path:'/api/v1/models/load',payload:{model:'qwen',context_length:8192}}),{fetch:async(u,o)=>{assert.match(u,/models\/load$/);assert.equal(JSON.parse(o.body).context_length,8192);return Response.json({error:{message:'bad token'}},{status:401});}});assert.equal(res.status,401);assert.equal((await res.json()).error.message,'bad token');
});
test('rejects arbitrary paths, private networks, embedded credentials and external origins',async()=>{
 const noFetch={fetch:()=>{throw new Error('must not fetch');}};
 for(const baseUrl of ['http://127.0.0.1','http://10.0.0.1','http://192.168.0.1','http://[::1]','http://169.254.169.254','http://2130706433'])assert.equal((await relay(request({baseUrl,path:'/v1/models'}),noFetch)).status,400);
 assert.equal((await relay(request({baseUrl:'https://example.test',path:'/admin'}),noFetch)).status,400);
 assert.equal((await relay(request({baseUrl:'https://example.test',path:'/v1/models'},{headers:{Origin:'https://evil.test'}}),noFetch)).status,403);
});
test('does not follow redirects and reports network failures',async()=>{
 const res=await relay(request({baseUrl:'https://example.test',path:'/v1/models'}),{fetch:async()=>new Response(null,{status:302,headers:{Location:'http://localhost'}})});assert.equal(res.status,502);assert.match((await res.json()).error.message,/重定向/);
 const err=await relay(request({baseUrl:'https://example.test',path:'/v1/models'}),{fetch:async()=>{throw new Error('fetch failed');}});assert.match((await err.json()).error.message,/无法连接/);
});
