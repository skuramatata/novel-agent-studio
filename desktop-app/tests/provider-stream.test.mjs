import test from 'node:test';
import assert from 'node:assert/strict';
import { complete } from '../runtime/providers.mjs';
const config = {provider:'glm', model:'glm-5.3',baseUrl:'https://open.bigmodel.cn/api/coding/paas/v4',apiKey:'test'};
const event = (delta, finish_reason = null) => `data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\r\n\r\n`;
function response(raw, bytewise = false) {
 const bytes = new TextEncoder().encode(raw);
 return new Response(new ReadableStream({start(c) {
  if(bytewise) for(const b of bytes) c.enqueue(new Uint8Array([b])); else c.enqueue(bytes);
  c.close();
 }}), {headers:{'Content-Type':'text/event-stream'}});
}
test('流式接收跨字节中文、思考、usage，完成前反馈进度，正文不含思考', async()=>{
 const progress=[];
 const result=await complete(config,[],undefined,async(_,init)=>{
  assert.equal(JSON.parse(init.body).stream,true);
  return response(': heartbeat\r\n\r\n'+event({reasoning_content:'思考一下'})+event({content:'{"标题":"岛"}'})+event({},'stop')+'data: {"usage":{"total_tokens":42}}\r\n\r\ndata: [DONE]\r\n\r\n',true);
 },8000,{onProgress:s=>progress.push(s)});
 assert.equal(result.text,'{"标题":"岛"}'); assert.equal(result.usage.total_tokens,42);
 assert(progress.some(s=>s.includes('正在思考'))); assert(progress.some(s=>s.includes('正在生成')));
});
test('断流、错误帧、坏JSON均不能作为成功结果',async()=>{
 for(const raw of [event({content:'{"ok":true}'})+'data: [DONE]\n\n', 'data: {bad}\n\n',event({content:'部分'})+'data: {"error":{"message":"secret"}}\n\n'])
  await assert.rejects(complete(config,[],undefined,async()=>response(raw)));
});
test('输出上限保留部分结果与usage供现有扩容恢复使用',async()=>{
 const raw=event({content:'{"半截":'},'length');
 await assert.rejects(complete(config,[],undefined,async()=>response(raw)),{code:'OUTPUT_LIMIT'});
 const result=await complete(config,[],undefined,async()=>response(raw),8000,{allowPartial:true});
 assert.equal(result.finishReason,'length'); assert.equal(result.text,'{"半截":');
});
test('MiniMax reasoning_details只计思考进度，支持无DONE的正常结束帧',async()=>{
 const progress=[];
 const result=await complete({...config,provider:'minimax',model:'MiniMax-M2.7',baseUrl:'https://api.minimaxi.com/v1'},[],undefined,async()=>response(event({reasoning_details:[{text:'思考'}]})+event({content:'结果'},'stop')),8000,{onProgress:s=>progress.push(s)});
 assert.equal(result.text,'结果');assert(progress.some(s=>s.includes('思考已接收 2 字')));
});
test('等待读取期间取消会释放流，不交付已接收片段',async()=>{
 const controller=new AbortController();let cancelled=false;
 const result=complete(config,[],controller.signal,async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(event({content:'半截'})));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}));
 setTimeout(()=>controller.abort(),20);
 await assert.rejects(result,{name:'AbortError'});assert(cancelled);
});
