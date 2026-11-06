import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {relay} from '../src/relay.js';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createModelConfigStore} from '../src/shared-store.mjs';
import {createWorkspaceStore} from '../src/workspace-store.mjs';
import {publicRecord,publicResult} from '../src/workspace-compat.mjs';
import {networkInterfaces} from 'node:os';
import {join} from 'node:path';
const port=Number(process.env.PORT||4177),root=new URL('../src/',import.meta.url);
const dataDirectory=process.env.LUMEN_DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url));
const modelStore=createModelConfigStore(process.env.LUMEN_CONFIG_FILE||join(dataDirectory,'model-configs.json'));
const workspaceStore=createWorkspaceStore(process.env.LUMEN_WORKSPACE_FILE||join(dataDirectory,'workspace.json'));
// Finish migration/recovery before announcing a healthy service.
await workspaceStore.revision();
const assets={'/':['index.html','text/html; charset=utf-8'],'/index.html':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/i18n.js':['i18n.js','text/javascript; charset=utf-8'],'/response-utils.js':['response-utils.js','text/javascript; charset=utf-8'],'/workspace-client.js':['workspace-client.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
async function readJSON(req,limit){
 if(!req.headers['content-type']?.includes('application/json'))throw Object.assign(new Error('需要 JSON 请求'),{status:415});
 const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('保存数据过大'),{status:413});chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('请求 JSON 格式无效'),{status:400});}
}
const server=http.createServer(async(req,res)=>{
 const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
 try{const path=new URL(req.url,'http://localhost').pathname;
 const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 const publicOrigin=process.env.LUMEN_PUBLIC_ORIGIN||((req.headers['x-forwarded-proto']==='https'?'https://':'http://')+req.headers.host);
 if(path.startsWith('/api/')){const origin=req.headers.origin;if(origin&&origin!==publicOrigin&&!( !process.env.LUMEN_PUBLIC_ORIGIN&&(origin==='http://'+req.headers.host||origin==='https://'+req.headers.host)))return json({error:'不接受其他网站的配置修改'},403);}
 if(path==='/health')return json({app:'lumen-studio',status:'running',storage:'server'});
 if(path==='/api/workspace'){
  if(req.method==='GET'){const url=new URL(req.url,'http://localhost');if(url.searchParams.has('since')&&url.searchParams.get('since')===String(await workspaceStore.revision())){res.writeHead(304,{'Cache-Control':'no-store'});res.end();return;}if(url.searchParams.get('view')==='sidebar'){let expandedProjects;try{if(url.searchParams.has('expanded'))expandedProjects=JSON.parse(url.searchParams.get('expanded'));}catch{return json({error:'目录加载设置无效'},400);}if(expandedProjects!==undefined&&!Array.isArray(expandedProjects))return json({error:'目录加载设置无效'},400);return json(publicRecord(await workspaceStore.getSidebar({expandedProjects,limit:url.searchParams.get('limit')||undefined,focus:url.searchParams.get('focus')??undefined,filter:url.searchParams.has('filter')?url.searchParams.get('filter'):undefined})));}return json(publicRecord(await workspaceStore.get()));}
  if(req.method==='PATCH'){const data=await readJSON(req,128*1024**2);let result;try{result=await workspaceStore.patch(data.changes);}catch(error){if(error.code)throw error;return json({error:error.message},400);}return json(publicResult(result),result.conflict?409:200);}
  if(req.method!=='PUT')return json({error:'仅支持 GET、PUT 与 PATCH'},405);
  const data=await readJSON(req,128*1024**2);
  let result;try{result=await workspaceStore.update(data.revision,data.data);}catch(error){if(error.code)throw error;return json({error:error.message},400);}
  return json(publicResult(result),result.conflict?409:200);
 }
 if(path.startsWith('/api/chats/')){if(req.method!=='GET')return json({error:'仅支持 GET'},405);return json(await workspaceStore.getChat(decodeURIComponent(path.slice('/api/chats/'.length))));}
 if(path==='/api/model-config'){
  const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const requestOrigin=req.headers.origin;
  if(requestOrigin&&requestOrigin!==publicOrigin&&requestOrigin!=='http://'+req.headers.host&&requestOrigin!=='https://'+req.headers.host)return json({error:'不接受其他网站的配置修改'},403);
  if(req.method==='GET'){const url=new URL(req.url,'http://localhost');try{return json({record:await modelStore.get(url.searchParams.get('source')||'',url.searchParams.get('model')||'')});}catch(e){return json({error:e.message},400);}}
  if(req.method!=='PATCH')return json({error:'仅支持 GET 与 PATCH'},405);
  if(!req.headers['content-type']?.includes('application/json'))return json({error:'需要 JSON 请求'},415);
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>512000)return json({error:'配置请求过大'},413);chunks.push(chunk);}
  try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));const result=await modelStore.update(data.source,data.model,data.revision,data.patch);return json(result,result.conflict?409:200);}catch(e){return json({error:e.message},400);}
 }
 if(path==='/api/relay'){if(req.method!=='POST')return json({error:'只接受 POST 请求'},405);const body=await readJSON(req,24*1024**2),headers={...req.headers};delete headers['content-length'];if(!body.apiKey)body.apiKey=await workspaceStore.keyFor(body.baseUrl,body.profileId);const request=new Request((req.headers.origin||publicOrigin)+req.url,{method:req.method,headers,body:JSON.stringify(body),signal:abort.signal});const response=await relay(request,{allowPrivate:process.env.LUMEN_ALLOW_PRIVATE!=='false'});res.writeHead(response.status,{...Object.fromEntries(response.headers),'X-Accel-Buffering':'no'});if(response.body){for await(const chunk of response.body){if(res.destroyed)break;if(!res.write(Buffer.from(chunk)))await new Promise(resolve=>res.once('drain',resolve));}}res.end();return;}
 const asset=assets[path];if(!asset){res.writeHead(404);res.end('Not found');return;}res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(await readFile(new URL(asset[0],root)));
 }catch(error){if(!res.headersSent)res.writeHead(error.status||500,{'Content-Type':'application/json','Cache-Control':'no-store'});if(!res.destroyed)res.end(JSON.stringify({error:error.message}));}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Close the previous Lumen Studio CMD window first.`:error.message);process.exitCode=1;});
server.listen(port,process.env.LUMEN_HOST||'0.0.0.0',()=>{
 const url=`http://127.0.0.1:${port}`;
 console.log('\n  LUMEN STUDIO  /  Local model workspace\n');
 console.log(`  Website: ${url}`);
 for(const entries of Object.values(networkInterfaces()))for(const net of entries||[])if(net.family==='IPv4'&&!net.internal)console.log(`  Shared workspace: http://${net.address}:${port}`);
 console.log('  Conversations and connections are saved on this server.');
 console.log(`  Data directory: ${dataDirectory}`);
 console.log('  Keep this CMD window open to keep the website running.');
 console.log('  Close this window, or press Ctrl+C, to stop the website.\n');
 if(process.argv.includes('--open')&&process.platform==='win32'){const opener=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});opener.on('error',()=>{});opener.unref();}
});
process.on('SIGTERM',()=>{server.close();server.closeAllConnections();});
process.on('SIGINT',()=>{server.close();server.closeAllConnections();});
// The server belongs to its launching console, including when Windows terminates
// cmd.exe without delivering the normal console-close signal to Node.
if(process.platform==='win32'){
 const consoleParent=process.ppid;
 const watcher=setInterval(()=>{try{process.kill(consoleParent,0);}catch{server.close();server.closeAllConnections();clearInterval(watcher);process.exit(0);}},750);
 watcher.unref();
}
