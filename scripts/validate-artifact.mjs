import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../dist/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
assert.equal(manifest.scripts.start,'node server/index.mjs');
for(const path of ['server/generation-runner.mjs','server/generation-output.mjs','server/response-utils.js','server/index.mjs','server/relay.js','server/vertex-express.js','server/vertex-catalog.js','server/shared-store.mjs','server/workspace-store.mjs','server/workspace-public.mjs','public/app.js','public/relay.js','public/vertex-express.js','public/vertex-catalog.js','public/i18n.js','public/response-utils.js','public/workspace-client.js']){
 const file=fileURLToPath(new URL(path,root));await access(file);execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
}
for(const path of ['public/index.html','public/style.css','deploy/nginx.conf','deploy/lumen.service','README.md'])await access(new URL(path,root));
const server=await readFile(new URL('server/index.mjs',root),'utf8');
await access(new URL('public/rendering.js',root));
const vendorAssets=JSON.parse(await readFile(new URL('public/vendor/manifest.json',root),'utf8'));
for(const path of Object.keys(vendorAssets))await access(new URL('public/vendor/'+path,root));
assert(server.includes("root=new URL('../public/',import.meta.url)"));
assert(!server.includes("from '../src/"));
const service=await readFile(new URL('deploy/lumen.service',root),'utf8');
assert(service.includes('/server/index.mjs'));
assert(!service.includes('/scripts/dev.mjs'));
console.log('Node deployment paths, JavaScript syntax, frontend, and Nginx files are valid.');
