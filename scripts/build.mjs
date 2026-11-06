import {readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const frontend=['index.html','style.css','app.js','i18n.js','response-utils.js','workspace-client.js'];
const backend=['relay.js','shared-store.mjs','workspace-store.mjs'];
for(const directory of ['dist/public/','dist/server/','dist/deploy/'])await mkdir(new URL(directory,root),{recursive:true});
for(const name of frontend)await copyFile(new URL('src/'+name,root),new URL('dist/public/'+name,root));
for(const name of backend)await copyFile(new URL('src/'+name,root),new URL('dist/server/'+name,root));
const server=(await readFile(new URL('scripts/dev.mjs',root),'utf8'))
 .replaceAll("from '../src/","from './")
 .replace("root=new URL('../src/',import.meta.url)","root=new URL('../public/',import.meta.url)");
await writeFile(new URL('dist/server/index.mjs',root),server);
await writeFile(new URL('dist/package.json',root),JSON.stringify({name:'lumen-studio-server',private:true,type:'module',scripts:{start:'node server/index.mjs'}},null,2)+'\n');
for(const name of ['nginx.conf','lumen.service'])await copyFile(new URL('deploy/'+name,root),new URL('dist/deploy/'+name,root));
await copyFile(new URL('deploy/README.md',root),new URL('dist/README.md',root));
// Remove obsolete generated Worker files from earlier builds.
for(const path of ['dist/server/index.js','dist/.openai/hosting.json'])await rm(new URL(path,root),{force:true});
console.log('Built Node deployment in dist/: public frontend, server storage, Nginx configuration.');
