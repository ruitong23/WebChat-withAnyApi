import test from 'node:test';
import assert from 'node:assert/strict';
import {markdown} from '../src/rendering.js';

test('Chinese narrative formulas and escaped numbering render from unchanged source',()=>{
 const raw=String.raw`2\. $\text{施压} \rightarrow \text{男主后退} \rightarrow \text{后背撞击墙壁的物理反馈（震动、冰冷感）}$`;
 const html=markdown(raw);
 assert.match(html,/<p>2\. /);assert.match(html,/class="katex"/);assert.match(html,/施压/);assert.match(html,/→/);assert.match(html,/annotation encoding="application\/x-tex"/);
 assert.equal(markdown(raw),html);assert.match(raw,/2\\\./);
});

test('dollar and bracket inline/display math, multiline environments and Markdown coexist',()=>{
 for(const raw of [String.raw`$\frac{1}{2}$`,String.raw`\(x^2\)`,String.raw`$$\sum_{i=1}^{3}i$$`,String.raw`\[\begin{aligned}a&=b\\c&=d\end{aligned}\]`,String.raw`公式：\[x^2\]。`]){
  const html=markdown(raw);assert.match(html,/class="katex"/);assert.doesNotMatch(html,/katex-error/);
 }
 const html=markdown('# 标题\n\n**粗体** 与 *斜体*\n第二行\n\n1. 第一项\n   - 嵌套项\n\n> 引用\n\n| 人物 | 设定 |\n| --- | --- |\n| 甲 | 勇敢 |\n\n[链接](https://example.com)');
 for(const tag of ['h1','strong','em','br','ol','ul','blockquote','table','th','td'])assert.match(html,new RegExp('<'+tag+'[ >]'));
 assert.match(html,/rel="noopener noreferrer"/);
});

test('code, currency, escaped dollars and incomplete stream fragments remain readable',()=>{
 assert.equal(markdown('`$x$`'),'<p><code>$x$</code></p>\n');
 assert.doesNotMatch(markdown('```tex\n$\\text{原样}$\n```'),/class="katex"/);
 assert.match(markdown(String.raw`价格 $20 和 $30；\$x\$`),/价格 \$20 和 \$30；\$x\$/);
 for(const raw of ['$','$$',String.raw`$\text{尚未`,String.raw`\[\frac{1}`,String.raw`$\notACommand$`])assert.doesNotThrow(()=>markdown(raw));
 const literal=markdown(String.raw`$\text{\$&}$`);assert.match(literal,/\$&amp;/);assert.doesNotMatch(literal,/\$1/);
});

test('untrusted HTML, links, math extensions and equation numbers cannot inject markup',()=>{
 const html=markdown('<img src=x onerror="alert(1)">\n<script>alert(1)</script>\n[x](javascript:alert(1))\n\n'+String.raw`$\href{javascript:alert(1)}{x}$ $\htmlClass{injected}{x}$ $\includegraphics{https://example.com/track}$`+'\n\n'+String.raw`$$x$$ (<img/src=x/onerror=alert(1)>)`);
 assert.doesNotMatch(html,/<(?:script|img)\b/);assert.doesNotMatch(html,/href="javascript:/);assert.doesNotMatch(html,/class="injected"/);
 assert.match(html,/&lt;img/);
});

test('macros cannot leak across formulas or replies and expansion is bounded',()=>{
 markdown(String.raw`$\gdef\novelcharacter{A}\novelcharacter$`);
 assert.match(markdown(String.raw`$\novelcharacter$`),/novelcharacter/);
 assert.match(markdown(String.raw`$\def\loop{\loop}\loop$`),/katex-error/);
 for(let i=0;i<270;i++)assert.match(markdown(`$x_{${i}}$`),/class="katex"/);
 assert.match(markdown('$x_0$'),/class="katex"/);
});
