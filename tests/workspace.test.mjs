import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve,sep} from 'node:path';
import {createWorkspaceStore,validateWorkspace,conversationPath,projectPath} from '../src/workspace-store.mjs';
import {mergeWorkspace,createWorkspacePersistence} from '../src/workspace-client.js';
import {publicRecord} from '../src/workspace-compat.mjs';
import {DatabaseSync} from 'node:sqlite';

const fixtureRoot=fileURLToPath(new URL('../work/workspace-tests/',import.meta.url));await mkdir(fixtureRoot,{recursive:true});
const removeFixture=async directory=>{const full=resolve(directory);assert(full.startsWith(resolve(fixtureRoot)+sep));await rm(full,{recursive:true,force:true});};
const chat=(id,text=id)=>({id,title:id,messages:[{id:'message-'+id,role:'user',content:text}]});
test('workspace persists chats, attachments, connections, keys and presets across store restarts',async()=>{
 const dir=await mkdtemp(join(fixtureRoot,'persist-')),path=join(dir,'workspace.json');
 try{
  const store=createWorkspaceStore(path);assert.equal((await store.get()).revision,0);
  const data={chats:[chat('saved')],profile:{name:'API',baseUrl:'https://api.test'},profiles:[],keys:{'https://api.test':'test-only-key'},presets:[{name:'precise',params:{temperature:.2}}]};
  data.chats[0].messages[0].content=[{type:'text',text:'with attachment'},{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}];
  const result=await store.update(0,data);assert.equal(result.record.revision,1);
  assert.deepEqual((await createWorkspaceStore(path).get()).data,{...data,projects:[]});
  assert.equal(JSON.parse(await readFile(path,'utf8')).data.keys['https://api.test'],'test-only-key');
  assert.equal(JSON.parse(await readFile(path,'utf8')).data.chats[0].messages,undefined);
  assert.deepEqual(JSON.parse(await readFile(join(dir,conversationPath(data.chats[0])),'utf8')),data.chats[0]);
  const changed=structuredClone(data);changed.chats[0].messages[0].content='next edit';
  const results=await Promise.all([store.update(1,changed),store.update(1,data)]);
  assert.equal(results.filter(r=>r.conflict).length,1);assert.equal((await store.get()).data.chats[0].messages[0].content,'next edit');
  await assert.rejects(store.update(2,{chats:[{id:'broken',messages:[]}]}));
  assert.equal((await store.get()).revision,2,'Rejected saves do not change the existing file');
 }finally{await removeFixture(dir);}
});
test('damaged workspace files are reported instead of replaced by an empty workspace',async()=>{
 const dir=await mkdtemp(join(fixtureRoot,'damaged-')),path=join(dir,'workspace.json');
 try{await writeFile(path,'broken JSON');const store=createWorkspaceStore(path);await assert.rejects(store.get());await assert.rejects(store.update(0,{chats:[]}));assert.equal(await readFile(path,'utf8'),'broken JSON');}
 finally{await removeFixture(dir);}
});
test('workspace validation rejects duplicate IDs, broken messages and invalid keys',()=>{
 for(const value of [null,[],{unknown:true},{chats:[chat('x'),chat('x')]},{chats:[{...chat('x'),messages:[{id:'x',role:'invalid',content:'x'}]}]},{keys:{'not a URL':'key'}},{keys:{'https://api.test':'newline\nkey'}},{profiles:[null]},{theme:'invalid'}])assert.throws(()=>validateWorkspace(value));
});
test('projects have independent metadata and moving a chat changes its file location without rewriting other chats',async()=>{
 const dir=await mkdtemp(join(fixtureRoot,'projects-')),path=join(dir,'workspace.json');
 try{
  const store=createWorkspaceStore(path),a=chat('a'),b=chat('b');
  await store.update(0,{chats:[a,b],projects:[]});const originalB=await stat(join(dir,conversationPath(b)));
  await new Promise(r=>setTimeout(r,25));
  const project={id:'project-a',name:'研究 / 同名文件夹',created:1};a.projectId=project.id;
  const saved=await store.update(1,{chats:[a,b],projects:[project]});
  assert.equal(saved.record.data.projects[0].path,projectPath(project.id));
  assert.equal(JSON.parse(await readFile(join(dir,projectPath(project.id),'project.json'),'utf8')).name,project.name);
  assert.equal(JSON.parse(await readFile(join(dir,conversationPath(a)),'utf8')).id,'a');
  await assert.rejects(readFile(join(dir,conversationPath(chat('a')))),{code:'ENOENT'});
  assert.equal((await stat(join(dir,conversationPath(b)))).mtimeMs,originalB.mtimeMs,'Unrelated chat file must not be rewritten');
  const data=(await store.get()).data;data.projects[0].name='改名后路径仍保留';await store.update(2,data);
  assert.equal((await store.get()).data.projects[0].path,projectPath(project.id));
  data.chats[0].projectId='';data.projects=[];await store.update(3,data);
  assert.deepEqual((await createWorkspaceStore(path).get()).data.chats[0],data.chats[0]);
  await assert.rejects(readFile(join(dir,conversationPath(a))),{code:'ENOENT'});
  await assert.rejects(readFile(join(dir,projectPath(project.id),'project.json')),{code:'ENOENT'});
 }finally{await removeFixture(dir);}
});
test('the previous single-file format migrates automatically with an intact backup',async()=>{
 const dir=await mkdtemp(join(fixtureRoot,'migration-')),path=join(dir,'workspace.json');
 try{
  const old={version:1,revision:7,data:{chats:[chat('old')],keys:{'https://api.test':'old-test-key'}}};await writeFile(path,JSON.stringify(old));
  const record=await createWorkspaceStore(path).get();assert.equal(record.version,2);assert.equal(record.revision,7);
  assert.deepEqual(record.data.chats,old.data.chats);assert.deepEqual(JSON.parse(await readFile(path+'.v1.bak','utf8')),old);
  const index=JSON.parse(await readFile(path,'utf8'));assert.equal(index.version,2);assert.equal(index.data.chats[0].messages,undefined);
  assert.deepEqual(JSON.parse(await readFile(join(dir,index.data.chats[0].path),'utf8')),old.data.chats[0]);
 }finally{await removeFixture(dir);}
});
test('an interrupted multi-file save is completed from its journal before serving readers',async()=>{
 const dir=await mkdtemp(join(fixtureRoot,'recovery-')),path=join(dir,'workspace.json');
 try{
  await createWorkspaceStore(path).update(0,{chats:[chat('a')],projects:[]});
  const index=JSON.parse(await readFile(path,'utf8'));index.revision=2;
  const updated=chat('a','recovered text');await writeFile(path+'.pending.json',JSON.stringify({version:1,index,writes:[{path:conversationPath(updated),value:updated}],removals:[]}));
  const restored=await createWorkspaceStore(path).get();assert.equal(restored.revision,2);assert.equal(restored.data.chats[0].messages[0].content,'recovered text');
  await assert.rejects(readFile(path+'.pending.json'),{code:'ENOENT'});
  await rm(join(dir,conversationPath(updated)));await assert.rejects(createWorkspaceStore(path).get(),{code:'ENOENT'});
  assert.equal(JSON.parse(await readFile(path,'utf8')).revision,2,'Missing chat files must not reset the index');
 }finally{await removeFixture(dir);}
});
test('project paths cannot escape the data directory and concurrent project removal preserves unsaved chats',()=>{
 assert.throws(()=>validateWorkspace({projects:[{id:'p',name:'name',path:'../../outside'}]}));
 assert.throws(()=>validateWorkspace({projects:[],chats:[{...chat('a'),projectId:'missing'}]}));
 assert(!projectPath('../../outside').includes('..'));
 const project={id:'p',name:'Project'},base={projects:[project],chats:[]};
 const result=mergeWorkspace(base,{...base,chats:[{...chat('new'),projectId:'p'}]},{projects:[],chats:[]});
 assert(result.conflicts.includes('projects:p'));
});
test('different-device additions and deletes merge, while same-chat edits and delete/edit conflicts do not overwrite',()=>{
 const base={chats:[chat('a'),chat('b')],profiles:[],keys:{},presets:[]};
 const local={...base,chats:[chat('a','local'),chat('b'),chat('new-local')]};
 const remote={...base,chats:[chat('a'),chat('b','remote'),chat('new-remote')]};
 const merged=mergeWorkspace(base,local,remote);assert.deepEqual(merged.conflicts,[]);
 assert.deepEqual(merged.data.chats.map(c=>[c.id,c.messages[0].content]),[['a','local'],['b','remote'],['new-local','new-local'],['new-remote','new-remote']]);
 assert.deepEqual(mergeWorkspace(base,{...base,chats:[chat('b')]},base).data.chats,[chat('b')]);
 assert.deepEqual(mergeWorkspace(base,local,{...base,chats:[chat('a','competing'),chat('b')]}).conflicts,['chats:a']);
 assert.deepEqual(mergeWorkspace(base,{...base,chats:[chat('b')]},{...base,chats:[chat('a','competing'),chat('b')]}).conflicts,['chats:a']);
});
test('server save rebases disjoint edits and keeps conflicting local content available for export',async t=>{
 const initial={revision:1,data:{chats:[chat('a')],profiles:[],keys:{},presets:[]}};
 let local={...initial.data,chats:[chat('a'),chat('mine')]},remote={revision:2,data:{...initial.data,chats:[chat('a'),chat('theirs')]}},calls=0;
 const mocked=t.mock.method(globalThis,'fetch',async(_url,options)=>{
  calls++;const body=JSON.parse(options.body);
  if(body.revision!==remote.revision)return Response.json({record:remote},{status:409});
  remote={revision:remote.revision+1,data:body.data};return Response.json({record:remote});
 });
 const statuses=[],client=createWorkspacePersistence({initial,read:()=>structuredClone(local),apply:data=>local=data,onStatus:(s,m)=>statuses.push([s,m])});
 client.save();assert.equal(await client.flush(),true);assert.equal(calls,2);assert.equal(client.dirty,false);
 assert.deepEqual(remote.data.chats.map(c=>c.id),['a','mine','theirs']);
 remote={revision:4,data:{...remote.data,chats:[chat('a','remote changed'),chat('mine'),chat('theirs')]}};
 local.chats[0]=chat('a','local changed');client.save();assert.equal(await client.flush(),false);assert.equal(client.dirty,true);
 assert.equal(local.chats[0].messages[0].content,'local changed');assert.equal(remote.data.chats[0].messages[0].content,'remote changed');
 assert.equal(statuses.at(-1)[0],'error');assert.match(statuses.at(-1)[1],/导出/);mocked.mock.restore();
});
test('sidebar pages share one limit across folders and do not read conversation bodies',async()=>{
 const dir=await mkdtemp(join(fixtureRoot,'paging-')),path=join(dir,'workspace.json');
 try{
  const store=createWorkspaceStore(path),projects=[{id:'p',name:'P'},{id:'q',name:'Q'}],chats=Array.from({length:40},(_,i)=>({...chat('c'+i),projectId:i<15?'p':i<30?'q':''}));
  await store.update(0,{projects,chats});
  let result=await store.getSidebar();assert.equal(result.data.chats.length,10);assert(result.data.chats.every(c=>!c.projectId&&c.messages===undefined));
  result=await store.getSidebar({expandedProjects:['p'],limit:15,focus:'p'});assert.equal(result.data.chats.length,15);assert(result.data.chats.every(c=>c.projectId==='p'));assert.equal(result.listing.remaining,10);
  result=await store.getSidebar({expandedProjects:['p','q'],limit:30,focus:'q'});assert.equal(result.data.chats.length,30);assert.equal(result.data.chats.filter(c=>!c.projectId).length,0);assert.equal(result.data.chats[0].projectId,'q');
  await rm(join(dir,conversationPath(chats[39])));
  assert.equal((await store.getSidebar({expandedProjects:['p'],limit:15})).data.chats.length,15,'Unloaded broken chat files are not touched while listing');
  const settings={sidebar:{limit:30,expandedProjects:['p','q'],scrollTop:123},activeProject:'q'};
  assert(!(await store.patch({settings})).conflict);result=await createWorkspaceStore(path).getSidebar();assert.equal(result.listing.limit,30);assert.deepEqual(result.listing.expandedProjects,['p','q']);assert.equal(result.data.sidebar.scrollTop,123);
  const selected=await store.getChat('c0');assert.equal(selected.chat.messages[0].content,'c0');
  const updated={...selected.chat,title:'Edited alone'};await store.patch({chats:[{id:'c0',baseEtag:selected._etag,chat:updated}]});
  const meta=(await store.getSidebar({expandedProjects:['p'],limit:15})).data.chats.find(c=>c.id==='c0');
  await store.patch({chats:[{id:'c0',baseEtag:meta._etag,projectId:'q'}]});assert.equal((await store.getChat('c0')).chat.projectId,'q');
  await assert.rejects(readFile(join(dir,conversationPath(chats[0]))),{code:'ENOENT'});
  const p=(await store.getSidebar()).data.projects.find(p=>p.id==='p');await store.patch({projects:[{id:'p',baseEtag:p._etag,deleted:true}]});
  result=await store.getSidebar();assert.equal(result.listing.counts[''],24,'Deleting a project relocates its unloaded conversations');assert.equal(result.listing.total,40);
 }finally{await removeFixture(dir);}
});
test('partial client sends only edited chats and loading a body does not count as an edit',async t=>{
 const full={...chat('a'),_etag:'a0'},summary={id:'b',title:'b',projectId:'',_etag:'b0'},initial={partial:true,data:{chats:[full,summary],projects:[],active:'a'}};
 let local=structuredClone(initial.data),last;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{assert.equal(options.method,'PATCH');last=JSON.parse(options.body);return Response.json({record:{...initial,listing:{ids:['a','b']}},etags:{a:'a1'}});});
 const client=createWorkspacePersistence({initial,read:()=>structuredClone(local)});
 local.chats[0].messages.push({id:'new',role:'user',content:'only this is edited'});client.save();assert(await client.flush());assert.equal(last.changes.chats.length,1);assert.equal(last.changes.chats[0].id,'a');
 const loaded={...chat('b'),_etag:'b0'};client.hydrate(loaded);local.chats[1]=loaded;local.active='b';client.save();assert(await client.flush());assert.deepEqual(last.changes.chats,[]);
});
test('a coalesced no-op save still publishes the acknowledged sidebar counts',async t=>{
 const initial={partial:true,data:{chats:[{...chat('a'),_etag:'old'}],projects:[]}},local=structuredClone(initial.data),states=[];let release;
 t.mock.method(globalThis,'fetch',()=>new Promise(resolve=>{release=resolve;}));
 const client=createWorkspacePersistence({initial,read:()=>structuredClone(local),onSaved:(record,options)=>states.push([record.listing?.total,options.clean])});
 local.chats[0].title='new title';client.save();const first=client.flush();client.save();
 release(Response.json({record:{...initial,listing:{total:2}},etags:{a:'new'}}));assert(await first);assert.deepEqual(states,[[2,false]]);
 assert(await client.flush());assert.deepEqual(states,[[2,false],[2,true]]);assert.equal(client.dirty,false);
});

test('legacy SQLite migrates a consistent WAL snapshot once and keeps same-URL profile keys separate',async()=>{
 const dir=await mkdtemp(join(fixtureRoot,'sqlite-')),path=join(dir,'workspace.sqlite');
 const db=new DatabaseSync(path);
 try{
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE items(kind TEXT,id TEXT,revision INTEGER,value TEXT,updated INTEGER,PRIMARY KEY(kind,id)); CREATE TABLE meta(key TEXT PRIMARY KEY,value INTEGER); INSERT INTO meta VALUES('revision',42);");
  const insert=db.prepare('INSERT INTO items VALUES(?,?,?,?,?)');
  insert.run('chat','old',2,JSON.stringify(chat('old')),1);
  for(const id of ['one','two'])insert.run('profile',id,3,JSON.stringify({id,name:id,baseUrl:'https://same.test',nativeUrl:'https://manage.test',apiKey:'test-key-'+id}),2);
  const store=createWorkspaceStore(path),record=await store.getSidebar(),response=publicRecord(record);
  assert.equal(record.revision,42);assert.equal((await store.getChat('old')).chat.messages[0].content,'old');
  assert.equal(response.data.profiles.length,2);assert(response.data.profiles.every(p=>p.hasKey&&p._etag));assert(!JSON.stringify(response).includes('test-key-'));assert.equal(response.data.keys,undefined);
  assert.equal(await store.keyFor('https://same.test/v1','one'),'test-key-one');assert.equal(await store.keyFor('https://same.test','two'),'test-key-two');
  assert.equal(await store.keyFor('https://manage.test','one'),'test-key-one');assert.equal(await store.keyFor('https://other.test','one'),'');
  const second=response.data.profiles.find(p=>p.id==='two');
  await store.patch({profiles:[{id:'two',baseEtag:second._etag,profile:{...second,name:'Edited without key'}}]});
  assert.equal(await store.keyFor('https://same.test','two'),'test-key-two');
  db.prepare('UPDATE items SET value=? WHERE id=?').run(JSON.stringify(chat('old','SQLite changed after migration')),'old');
  assert.equal((await createWorkspaceStore(path).getChat('old')).chat.messages[0].content,'old','Migration is not repeated after the JSON index exists');
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n,3,'Original database remains intact');
  const disk=JSON.parse(await readFile(path+'.json','utf8'));assert.equal(disk.migratedFrom,'sqlite');assert.equal(disk.data.keys.two,'test-key-two');
  await store.patch({clearKeys:true});assert.equal(await store.keyFor('https://same.test','one'),'');assert(publicRecord(await store.getSidebar()).data.profiles.every(p=>!p.hasKey));
 }finally{db.close();await removeFixture(dir);}
});

test('concurrent chat edits and edit-after-delete save independent conflict and recovery copies',async()=>{
 const dir=await mkdtemp(join(fixtureRoot,'copies-')),store=createWorkspaceStore(join(dir,'workspace.json'));
 try{
  await store.update(0,{chats:[chat('a')],active:'a'});const original=await store.getChat('a');
  await store.patch({chats:[{id:'a',baseEtag:original._etag,chat:chat('a','remote')}]});
  const retry=await store.patch({chats:[{id:'a',baseEtag:original._etag,chat:chat('a','remote')}]});assert.deepEqual(retry.remaps.chats,{},'Retrying an acknowledged-lost identical write must not create a conflict copy');
  const result=await store.patch({chats:[{id:'a',baseEtag:original._etag,chat:chat('a','local')}]});
  const copy=result.remaps.chats.a;assert(copy);assert.equal((await store.getChat('a')).chat.messages[0].content,'remote');assert.equal((await store.getChat(copy)).chat.messages[0].content,'local');assert.match((await store.getChat(copy)).chat.title,/冲突副本/);assert.equal(result.record.activeId,copy);
  const deletion=await store.getChat('a');await store.patch({chats:[{id:'a',baseEtag:deletion._etag,deleted:true}]});
  const recovered=await store.patch({chats:[{id:'a',baseEtag:deletion._etag,chat:chat('a','offline edit')}]});
  assert.match((await store.getChat(recovered.remaps.chats.a)).chat.title,/恢复副本/);assert.equal((await store.getSidebar()).listing.total,2);
 }finally{await removeFixture(dir);}
});

test('partial client consumes conflict remaps and continues saving an in-flight stream to its copy',async t=>{
 const initial={partial:true,revision:1,data:{chats:[{...chat('a'),_etag:'old'}],projects:[],profiles:[],active:'a'}};
 let local=structuredClone(initial.data),release,calls=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  calls++;const changes=JSON.parse(options.body).changes;
  if(calls===1)return new Promise(resolve=>{release=()=>resolve(Response.json({record:{...initial,revision:2,data:{...initial.data,chats:[{id:'copy',title:'a（冲突副本）',_etag:'new'}]}},remaps:{chats:{a:'copy'}},etags:{copy:'new'}}));});
  assert.equal(changes.chats[0].id,'copy');assert.equal(changes.chats[0].baseEtag,'new');assert.equal(changes.chats[0].chat.messages[0].content,'more stream');
  return Response.json({record:{...initial,revision:3},etags:{copy:'next'}});
 });
 const client=createWorkspacePersistence({initial,read:()=>structuredClone(local),onSaved:(_record,{remaps})=>{if(remaps?.chats.a){local.chats[0].id='copy';local.chats[0].title='a（冲突副本）';local.active='copy';}}});
 local.chats[0].messages[0].content='first frame';client.save();const first=client.flush();local.chats[0].messages[0].content='more stream';client.save();release();assert(await first);assert(client.dirty);assert(await client.flush());assert(!client.dirty);
});

test('profile conflicts preserve both credentials and stale deletion cannot remove a newer connection',async()=>{
 const dir=await mkdtemp(join(fixtureRoot,'profile-copies-')),store=createWorkspaceStore(join(dir,'workspace.json'));
 try{
  const profile={id:'p',name:'Original',baseUrl:'https://same.test',mode:'proxy',remember:true};
  await store.patch({profiles:[{id:'p',profile,apiKey:'test-original'}]});const before=publicRecord(await store.getSidebar()).data.profiles[0];
  await store.patch({profiles:[{id:'p',baseEtag:before._etag,profile:{...profile,name:'Remote'},apiKey:'test-remote'}]});
  const result=await store.patch({profiles:[{id:'p',baseEtag:before._etag,profile:{...profile,name:'Local'},apiKey:'test-local'}]});
  const copy=result.remaps.profiles.p;assert(copy);assert.equal(await store.keyFor(profile.baseUrl,'p'),'test-remote');assert.equal(await store.keyFor(profile.baseUrl,copy),'test-local');
  await store.patch({profiles:[{id:'p',baseEtag:before._etag,deleted:true}]});assert.equal((await store.getSidebar()).data.profiles.length,2);
  assert(!JSON.stringify(publicRecord(result.record)).includes('test-local'));
 }finally{await removeFixture(dir);}
});

test('a pending local save never turns an unseen remote connection addition into a deletion',async t=>{
 const initial={partial:true,revision:1,data:{chats:[{...chat('a'),_etag:'old'}],projects:[],profiles:[]}};
 let local=structuredClone(initial.data),release,calls=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
  calls++;const changes=JSON.parse(options.body).changes;
  if(calls===1)return new Promise(resolve=>{release=()=>resolve(Response.json({record:{...initial,revision:2,data:{...initial.data,profiles:[{id:'remote',name:'Remote',baseUrl:'https://api.test',_etag:'remote'}]}},etags:{a:'new'}}));});
  assert.deepEqual(changes.profiles,[]);
  return Response.json({record:{...initial,revision:3},etags:{a:'next'}});
 });
 const client=createWorkspacePersistence({initial,read:()=>structuredClone(local)});
 local.chats[0].title='first';client.save();const first=client.flush();local.chats[0].title='second';client.save();release();assert(await first);assert(await client.flush());
});

test('an unreadable SQLite database fails without creating an empty JSON replacement',async()=>{
 const dir=await mkdtemp(join(fixtureRoot,'sqlite-damaged-')),path=join(dir,'workspace.sqlite');
 try{await writeFile(path,'damaged database');await assert.rejects(createWorkspaceStore(path).get());assert.equal(await readFile(path,'utf8'),'damaged database');await assert.rejects(readFile(path+'.json'),{code:'ENOENT'});}
 finally{await removeFixture(dir);}
});
