import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createI18n,selectLanguage,english} from '../src/i18n.js';

test('uses the first browser language, with Chinese variants and English fallback',()=>{
 for(const languages of [['zh-CN'],['zh-TW','en'],['zh-HK'],['ZH_hans'],['zh']])assert.equal(selectLanguage(languages),'zh');
 for(const languages of [['en-US','zh-CN'],['de-DE','zh-CN'],['ja-JP'],[],undefined])assert.equal(selectLanguage(languages),'en');
 assert.equal(selectLanguage([], 'zh-CN'),'zh');
});

test('localized templates never translate interpolated user content or markup',()=>{
 const {t,ui}=createI18n(['en-US']);
 const message='你连接的模型窗口是中文';
 assert.equal(ui`<p title="模型配置">消息 ${message}</p>`,'<p title="Model settings">Message '+message+'</p>');
 assert.equal(t('<span class="badge">已停止</span>'),'<span class="badge">Stopped</span>');
 assert.equal(ui`已接收 ${12} 字符 · ${3} 个流事件`,'Received 12 characters · 3 stream events');
 assert.equal(ui`请求失败（${500}）${': '+message}`,'Request failed (500): '+message);
});

test('Chinese mode preserves literal UI copy and user data',()=>{
 const {t,ui,locale}=createI18n(['zh-TW']);
 assert.equal(locale,'zh-CN');
 assert.equal(t('API 连接'),'API 连接');
 assert.equal(ui`模型配置 ${'My model'}`,'模型配置 My model');
});

test('local backend errors are translated while unknown upstream messages stay intact',()=>{
 const {localizeError}=createI18n(['en-US']);
 assert.equal(localizeError('参数超出范围：temperature'),'Parameter out of range: temperature');
 assert.equal(localizeError('额外参数不能覆盖 model'),'Extra parameters cannot override model');
 assert.equal(localizeError('上游服务器的中文消息'),'上游服务器的中文消息');
 for(const [key,value]of Object.entries(english)){assert.equal(typeof value,'string',key);assert(!/\p{Script=Han}/u.test(value),key);}
});
