import {homedir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Prefer a project installation; desktop development can use the bundled runtime.
let playwright;
try{playwright=await import('playwright');}catch(error){
 if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;
 const bundled=join(homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright','index.mjs');
 try{playwright=await import(pathToFileURL(bundled).href);}catch{throw new Error('Browser tests require Playwright: npm install --no-save playwright');}
}
export const {chromium}=playwright;
