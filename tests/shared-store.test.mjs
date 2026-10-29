import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createModelConfigStore,validatePatch} from '../src/shared-store.mjs';
const fixtureRoot=fileURLToPath(new URL('../work/store-tests/',import.meta.url));await mkdir(fixtureRoot,{recursive:true});
const tmpdir=()=>fixtureRoot;
const removeFixture=async dir=>{if(!resolve(dir).startsWith(resolve(fixtureRoot)+sep))throw new Error('Fixture path out of bounds');await rm(dir,{recursive:true});};
test('model config is shared across clients, canonical URLs, and server restarts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lumen-shared-'));try{const path=join(dir,'config.json'),a=createModelConfigStore(path),b=createModelConfigStore(path);const initial=await a.get('https://host.test/v1','model-a');assert.equal(initial.revision,0);const saved=await a.update('https://host.test/v1','model-a',0,{temperature:.35,system:'shared test'});assert.equal(saved.record.revision,1);assert.equal((await b.get('https://host.test','model-a')).params.temperature,.35);assert.equal((await createModelConfigStore(path).get('https://host.test','model-a')).params.system,'shared test');assert.equal((await a.get('https://other.test','model-a')).revision,0);assert.equal((await a.get('https://host.test','model-b')).revision,0);assert(!String(await readFile(path)).includes('apiKey'));}finally{await removeFixture(dir);}
});
test('stale writes conflict and concurrent updates do not silently overwrite',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lumen-revision-'));try{const store=createModelConfigStore(join(dir,'config.json'));const results=await Promise.all([store.update('https://host.test','a',0,{temperature:.2}),store.update('https://host.test','a',0,{temperature:.9})]);assert.equal(results.filter(r=>r.conflict).length,1);assert.equal((await store.get('https://host.test','a')).params.temperature,.2);assert.equal(results.find(r=>r.conflict).record.revision,1);}finally{await removeFixture(dir);}
});
test('only model settings can be stored and invalid parameter JSON is rejected',()=>{
 for(const patch of [{apiKey:'secret'},{messages:[]},{temperature:NaN},{temperature:3},{top_p:-1},{stream:'yes'},{extra:'[]'},{extra:'{"messages":[]}'},{tools:'{}'}])assert.throws(()=>validatePatch(patch));
 assert.deepEqual(validatePatch({temperature:0,system:'',stream:false,include_usage:true}),{temperature:0,system:'',stream:false,include_usage:true});
});
