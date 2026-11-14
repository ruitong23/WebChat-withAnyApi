import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVertexCatalog,parseVertexCatalog,vertexCatalogURL} from '../src/vertex-catalog.js';
const date=Date.parse('2026-11-14T12:00:00Z');
const page=id=>`<table><tr><td><a><code>${id}</code></a></td><td>November 12, 2026</td><td>No retirement date announced</td><td></td></tr></table>`;
test('official lifecycle rows discover unseen active chat models and exclude retired, replacement-only and non-chat entries',()=>{
 const html=page('gemini-9-new')+`<nav>gemini-fake-navigation</nav><table><tr><td><code>gemini-2.5-flash</code></td><td>June 17, 2025</td><td>October 20, 2026</td><td>gemini-replacement-only</td></tr><tr><td>gemini-image-preview</td><td>November 1, 2026</td><td>No retirement date announced</td></tr></table>`;
 assert.deepEqual(parseVertexCatalog(html,date),['gemini-9-new']);assert.throws(()=>parseVertexCatalog('<html>Sign in</html>',date));
});
test('catalog refreshes introduce new models without a code change and never send API credentials or conversation data',async()=>{
 let calls=0,time=date;const catalog=createVertexCatalog({now:()=>time,fetcher:async(url,options)=>{calls++;assert.equal(url,vertexCatalogURL);assert.deepEqual(Object.keys(options.headers).sort(),['Accept','Accept-Language']);assert.equal(options.body,undefined);return new Response(page(calls===1?'gemini-9-first':'gemini-10-next'));}});
 assert.deepEqual((await catalog.get()).models,['gemini-9-first']);assert.equal((await catalog.get()).source,'official_cache');assert.equal(calls,1);
 assert.deepEqual((await catalog.get({refresh:true})).models,['gemini-10-next']);assert.equal(calls,2);time+=7*60*60*1000;await catalog.get();assert.equal(calls,3);
});
test('catalog outages expose a stale or bundled source and later refreshes can recover',async()=>{
 let fail=true;const catalog=createVertexCatalog({now:()=>date,fetcher:async()=>{if(fail)throw new Error('Offline');return new Response(page('gemini-9-recovered'));}});
 assert.equal((await catalog.get()).source,'bundled');fail=false;assert.equal((await catalog.get({refresh:true})).source,'official');fail=true;const stale=await catalog.get({refresh:true});assert.equal(stale.source,'stale_cache');assert.deepEqual(stale.models,['gemini-9-recovered']);
});
test('simultaneous connections share only the public catalog request, never an account key',async()=>{
 let calls=0,release;const catalog=createVertexCatalog({fetcher:()=>{calls++;return new Promise(resolve=>{release=()=>resolve(new Response(page('gemini-9-shared')));});}});
 const a=catalog.get(),b=catalog.get();assert.equal(calls,1);release();assert.deepEqual((await a).models,(await b).models);
});
