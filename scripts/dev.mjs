import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {relay} from '../src/relay.js';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createModelConfigStore} from '../src/shared-store.mjs';
import {networkInterfaces} from 'node:os';
const port=Number(process.env.PORT||4177),root=new URL('../src/',import.meta.url);
const modelStore=createModelConfigStore(process.env.LUMEN_CONFIG_FILE||fileURLToPath(new URL('../data/model-configs.json',import.meta.url)));
const assets={'/':['index.html','text/html; charset=utf-8'],'/index.html':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/i18n.js':['i18n.js','text/javascript; charset=utf-8'],'/response-utils.js':['response-utils.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
const server=http.createServer(async(req,res)=>{
 const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
 try{const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({app:'lumen-studio',status:'running'}));return;}
 if(path==='/api/model-config'){
  const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const requestOrigin=req.headers.origin;
  if(requestOrigin&&requestOrigin!=='http://'+req.headers.host&&requestOrigin!=='https://'+req.headers.host)return json({error:'不接受其他网站的配置修改'},403);
  if(req.method==='GET'){const url=new URL(req.url,'http://localhost');try{return json({record:await modelStore.get(url.searchParams.get('source')||'',url.searchParams.get('model')||'')});}catch(e){return json({error:e.message},400);}}
  if(req.method!=='PATCH')return json({error:'仅支持 GET 与 PATCH'},405);
  if(!req.headers['content-type']?.includes('application/json'))return json({error:'需要 JSON 请求'},415);
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>512000)return json({error:'配置请求过大'},413);chunks.push(chunk);}
  try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));const result=await modelStore.update(data.source,data.model,data.revision,data.patch);return json(result,result.conflict?409:200);}catch(e){return json({error:e.message},400);}
 }
 if(path==='/api/relay'){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>24*1024**2){res.writeHead(413);res.end('Payload too large');return;}chunks.push(chunk);}const request=new Request('http://'+req.headers.host+req.url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:Buffer.concat(chunks),signal:abort.signal});const response=await relay(request,{allowPrivate:true});res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body){for await(const chunk of response.body){if(res.destroyed)break;if(!res.write(Buffer.from(chunk)))await new Promise(resolve=>res.once('drain',resolve));}}res.end();return;}
 const asset=assets[path];if(!asset){res.writeHead(404);res.end('Not found');return;}res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(await readFile(new URL(asset[0],root)));
 }catch(error){if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});if(!res.destroyed)res.end(JSON.stringify({error:{message:error.message}}));}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Close the previous Lumen Studio CMD window first.`:error.message);process.exitCode=1;});
server.listen(port,process.env.LUMEN_HOST||'0.0.0.0',()=>{
 const url=`http://127.0.0.1:${port}`;
 console.log('\n  LUMEN STUDIO  /  Local model workspace\n');
 console.log(`  Website: ${url}`);
 for(const entries of Object.values(networkInterfaces()))for(const net of entries||[])if(net.family==='IPv4'&&!net.internal)console.log(`  Shared workspace: http://${net.address}:${port}`);
 console.log('  Users of the same workspace share per-model settings.');
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
