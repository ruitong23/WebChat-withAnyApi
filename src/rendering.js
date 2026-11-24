import MarkdownIt from './vendor/markdown-it.mjs';
import katex from './vendor/katex.mjs';
import texmath from './vendor/texmath.mjs';

// Cache individual formulas while the surrounding reply grows. Keep macros local
// to each formula so one conversation cannot redefine commands in another.
const formulas=new Map(),maxCachedFormulas=256,maxCachedCharacters=1000000;
let cachedCharacters=0;
function renderMath(source,displayMode){
 const key=JSON.stringify([displayMode,source]);
 if(formulas.has(key)){const html=formulas.get(key);formulas.delete(key);formulas.set(key,html);return html;}
 const html=katex.renderToString(source,{displayMode,throwOnError:false,strict:'ignore',trust:false,macros:{},maxExpand:1000,maxSize:10,output:'htmlAndMathml'});
 if(key.length+html.length<=maxCachedCharacters){
  formulas.set(key,html);cachedCharacters+=key.length+html.length;
  while(formulas.size>maxCachedFormulas||cachedCharacters>maxCachedCharacters){const oldest=formulas.keys().next().value;cachedCharacters-=oldest.length+formulas.get(oldest).length;formulas.delete(oldest);}
 }
 return html;
}

const md=new MarkdownIt({html:false,breaks:true,linkify:true,typographer:false});
md.use(texmath,{engine:{renderToString:(source,options)=>renderMath(source,options.displayMode)},delimiters:['dollars','brackets']});
md.inline.ruler.before('escape','math_inline_display',texmath.inline({name:'math_inline_display',tag:'\\[',rex:/\\\[([\s\S]+?)\\\]/gy}));
// Generate valid inline/block wrappers directly instead of interpolating KaTeX
// HTML into a replacement string (which would reinterpret literal dollar signs).
const math=(tokens,index,display)=>texmath.render(tokens[index].content,display,{});
md.renderer.rules.math_inline=(tokens,index)=>`<span class="math-inline">${math(tokens,index,false)}</span>`;
md.renderer.rules.math_inline_double=(tokens,index)=>`<span class="math-display">${math(tokens,index,true)}</span>`;
md.renderer.rules.math_inline_display=md.renderer.rules.math_inline_double;
md.renderer.rules.math_block=(tokens,index)=>`<div class="math-display">${math(tokens,index,true)}</div>\n`;
md.renderer.rules.math_block_eqno=(tokens,index)=>`<div class="math-equation"><div class="math-display">${math(tokens,index,true)}</div><span class="math-equation-number">(${md.utils.escapeHtml(tokens[index].info)})</span></div>\n`;
md.renderer.rules.table_open=()=>'<div class="markdown-table"><table>\n';
md.renderer.rules.table_close=()=>'</table></div>\n';
const linkOpen=md.renderer.rules.link_open||((tokens,index,options,env,self)=>self.renderToken(tokens,index,options));
md.renderer.rules.link_open=(tokens,index,options,env,self)=>{
 tokens[index].attrSet('target','_blank');tokens[index].attrSet('rel','noopener noreferrer');
 return linkOpen(tokens,index,options,env,self);
};

// Render a view only; stored messages, clipboard copies and exports stay raw.
export function markdown(source){return md.render(String(source??''));}
