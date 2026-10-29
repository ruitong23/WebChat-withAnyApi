import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitThinking,apiDeltaText,receptionStats} from '../src/response-utils.js';
test('thinking tags split across frames do not leak into answers or drop final text',()=>{
 const chunks=['<th','ink>先思考\n','检查完整性','</th','ink>','最终回答完整。'];let raw='';
 for(const chunk of chunks){raw+=chunk;const value=splitThinking(raw);assert(!value.content.includes('<th'));}
 assert.deepEqual(splitThinking(raw,{final:true}),{content:'最终回答完整。',reasoning:'先思考\n检查完整性',thinking:false});
 assert.equal(splitThinking('正常文本 1 <',{final:true}).content,'正常文本 1 <');
 assert.equal(splitThinking('<thinking>完整思考</thinking>完整回答',{final:true}).reasoning,'完整思考');
});
test('provider reasoning text, structured parts, and answer text are separated',()=>{
 assert.deepEqual(apiDeltaText({reasoning_content:'思考',content:'回答'}),{reasoning:'思考',content:'回答'});
 assert.deepEqual(apiDeltaText({content:[{type:'reasoning',text:'思考'},{type:'text',text:'回答'}]}),{reasoning:'思考',content:'回答'});
 assert.equal(apiDeltaText({reasoning_details:[{type:'reasoning.text',text:'完整思考'}]}).reasoning,'完整思考');
});
test('receiving counters distinguish true usage from text estimates and packet count',()=>{
 const estimated=receptionStats({content:'你好abc',reasoning:'分析',receivedEvents:100});assert.equal(estimated.chars,7);assert.equal(estimated.exact,false);assert.notEqual(estimated.tokens,100);assert.equal(estimated.events,100);
 assert.deepEqual(receptionStats({content:'回答',usage:{completion_tokens:0}}),{chars:2,tokens:0,exact:true,events:0});
 assert.equal(receptionStats({content:'回答',reasoning:'分析',usage:{output_tokens:12}}).tokens,12);
 assert.equal(receptionStats({error:true,content:'网络错误',received:{tokens:10,chars:20,exact:false,events:3}}).tokens,10);
 assert.equal(receptionStats({status:'stopped',content:'生成已停止。',received:{tokens:0,chars:0,exact:false,events:0}}).tokens,0);
});
test('answers well beyond the old 2048 limit are preserved byte for byte',()=>{
 const answer='完整答案。'.repeat(2000)+'[最后一个字符]';const value=splitThinking('<think>思考结束</think>'+answer,{final:true});assert.equal(value.content,answer);assert(value.content.endsWith('[最后一个字符]'));
});
