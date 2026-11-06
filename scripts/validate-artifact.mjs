import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../dist/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
assert.equal(manifest.scripts.start,'node server/index.mjs');
for(const path of ['server/index.mjs','server/relay.js','server/shared-store.mjs','server/workspace-store.mjs','server/workspace-public.mjs','public/app.js','public/i18n.js','public/response-utils.js','public/workspace-client.js']){
 const file=fileURLToPath(new URL(path,root));await access(file);execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
}
for(const path of ['public/index.html','public/style.css','deploy/nginx.conf','deploy/lumen.service','README.md'])await access(new URL(path,root));
const server=await readFile(new URL('server/index.mjs',root),'utf8');
assert(server.includes("root=new URL('../public/',import.meta.url)"));
assert(!server.includes("from '../src/"));
console.log('Node deployment paths, JavaScript syntax, frontend, and Nginx files are valid.');
