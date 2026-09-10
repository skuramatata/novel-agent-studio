import test from 'node:test';
import assert from 'node:assert/strict';
import {eligible,eventKey,allowed,render,retrieve,terms,conversation,smallTalk,searchQuery} from './issue-assistant.mjs';
const event={issue:{number:1,state:'open'},sender:{login:'author',type:'User'}};
const bot=body=>({user:{login:'github-actions[bot]'},body});
test('事件过滤：机器人、PR、已关闭问题与普通评论不会触发',()=>{
  assert.equal(eligible(event,[]),true);
  assert.equal(eligible({...event,sender:{login:'x[bot]',type:'Bot'}},[]),false);
  assert.equal(eligible({...event,issue:{...event.issue,pull_request:{}}},[]),false);
  assert.equal(eligible({...event,issue:{...event.issue,state:'closed'}},[]),false);
  assert.equal(eligible({...event,comment:{id:2,user:event.sender,body:'谢谢'}},[]),false);
  assert.equal(eligible({...event,comment:{id:2,user:event.sender,body:'/ai 请继续'}},[]),true);
  assert.equal(eligible({...event,comment:{id:2,user:event.sender,body:'/aide'}},[]),false);
});
test('重复事件和五次回复上限；用户伪造标记不影响计数',()=>{
  assert.equal(eligible(event,[bot(eventKey(event)+'\nreply')]),false);
  assert.equal(eligible(event,Array.from({length:5},(_,i)=>bot(`<!-- issue-assistant:v1:1:comment-${i} -->`))),false);
  assert.equal(eligible(event,[{user:event.sender,body:eventKey(event)}]),true);
});
test('检索不读取环境文件、小说正文、工作流或配置',()=>{
  for(const file of ['.env','desktop-app/.env','04-manuscript/story.md','.github/workflows/test.yml','desktop-app/package.json']) assert.equal(allowed(file),false,file);
  assert.equal(allowed('desktop-app/runtime/agent.mjs'),true);
  assert.equal(allowed('desktop-app/docs/review-recovery.md'),true);
  assert.ok(terms('审稿失败').includes('审稿'));
});
test('引用仅允许命中的片段，链接固定到提交，屏蔽批量提及',()=>{
  const sources=[{id:'S1',file:'README.md',start:1,end:20}];
  assert.throws(()=>render({answer:'x',sources:['S2']},sources,'owner/repo','abc'));
  assert.throws(()=>render({answer:'接口 https://evil.example',sources:['S1']},sources,'owner/repo','abc'),/正文含链接/);
  const text=render({answer:'@all 请检查模型连接。 <x>',sources:['S1']},sources,'owner/repo','abc');
  assert.ok(text.includes('/blob/abc/README.md#L1-L20'));
  assert.ok(!text.includes('@all'));
  assert.ok(!text.includes('evil.example'));
});
test('真实仓库检索可返回带行号的相关源码和文档',async()=>{
  const sources=await retrieve('审稿失败 review recovery checkpoint');
  assert.ok(sources.length>0 && sources.length<=8);
  assert.ok(sources.some(s=>/review|checkpoint/.test(s.file)));
  assert.ok(sources.every(s=>s.start>0 && s.end>=s.start && s.text.length<=6000));
});
test('模拟端到端：GitHub 读取 → DeepSeek JSON → 待发布产物；失败不生成产物',async()=>{
  const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {execFileSync}=await import('node:child_process');
  const {main}=await import('./issue-assistant.mjs');
  const originalCwd=process.cwd(), originalFetch=globalThis.fetch;
  const keys=['GITHUB_EVENT_PATH','GITHUB_OUTPUT','GITHUB_REPOSITORY','GITHUB_SHA','GITHUB_TOKEN','DEEPSEEK_API_KEY'];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  const temp=await mkdtemp(join(tmpdir(),'issue-assistant-'));
  try {
    await mkdir(join(temp,'.github'));
    await writeFile(join(temp,'.github/issue-assistant.md'),'输出 JSON');
    await writeFile(join(temp,'README.md'),'审稿失败可以检查版本和日志');
    await writeFile(join(temp,'event.json'),JSON.stringify(event));
    process.chdir(temp);
    execFileSync('git',['init','--quiet']);
    execFileSync('git',['add','README.md']);
    Object.assign(process.env,{GITHUB_EVENT_PATH:join(temp,'event.json'),GITHUB_OUTPUT:join(temp,'output'),GITHUB_REPOSITORY:'owner/repo',GITHUB_SHA:'abc',GITHUB_TOKEN:'test-github',DEEPSEEK_API_KEY:'test-deepseek'});
    let modelCalls=0;
    globalThis.fetch=async(url,options)=>{
      if(url.startsWith('https://api.github.com/')) {
        assert.equal(options.headers.Authorization,'Bearer test-github');
        return Response.json(url.includes('/comments?')?[]:{...event.issue,title:'审稿失败',body:'如何排查？'});
      }
      assert.equal(url,'https://api.deepseek.com/chat/completions');
      assert.equal(options.headers.Authorization,'Bearer test-deepseek');
      const request=JSON.parse(options.body);
      assert.ok(request.messages[1].content.includes('审稿失败可以检查版本和日志'));
      const payload=JSON.parse(request.messages[1].content);
      assert.equal(payload.currentMessage,'审稿失败\n如何排查？');
      assert.equal(payload.originalIssue.title,'审稿失败');
      modelCalls++;
      if(modelCalls===1) return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({answer:'接口 https://example.com',sources:['S1']})}}]});
      assert.ok(request.messages.at(-1).content.includes('重新输出 JSON'));
      return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({answer:'请提供完整版本和日志。',sources:['S1']})}}]});
    };
    await main();
    const reply=JSON.parse(await readFile('reply.json','utf8'));
    assert.equal(reply.marker,eventKey(event));
    assert.ok(reply.body.includes('/blob/abc/README.md'));
    assert.equal(modelCalls,2);
    await rm('reply.json');
    globalThis.fetch=async(url)=> url.startsWith('https://api.github.com/') ? Response.json(url.includes('/comments?')?[]:{...event.issue,title:'问题'}) : new Response('',{status:401});
    await assert.rejects(main(),/DeepSeek 请求失败：401/);
    await assert.rejects(readFile('reply.json'),/ENOENT/);
    await writeFile('event.json',JSON.stringify({...event,comment:{id:22,body:'/ai 你好',user:event.sender}}));
    delete process.env.DEEPSEEK_API_KEY;
    globalThis.fetch=async(url)=>{
      assert.ok(url.startsWith('https://api.github.com/'),'问候不得调用模型');
      return Response.json(url.includes('/comments?')?[]:{...event.issue,title:'问题'});
    };
    await main();
    const greeting=JSON.parse(await readFile('reply.json','utf8'));
    assert.ok(greeting.body.includes('你好！'));
    assert.ok(!greeting.body.includes('参考依据'));
    assert.ok(!greeting.body.includes('未找到足够'));
    assert.ok(greeting.body.length<200);

  } finally {
    globalThis.fetch=originalFetch;
    process.chdir(originalCwd);
    for(const k of keys) if(saved[k]===undefined) delete process.env[k]; else process.env[k]=saved[k];
    await rm(temp,{recursive:true,force:true});
  }
});

test('当前追问独立，历史排除当前消息及未来消息，新话题不混入旧问题',()=>{
  const issue={title:'模型配置',body:'怎么配置 GLM？'};
  const current={...event,comment:{id:20,body:'/ai 审稿失败怎么恢复？',user:event.sender}};
  const comments=[{id:10,user:event.sender,body:'/ai 模型在哪里配置？'},{id:20,user:event.sender,body:current.comment.body},{id:30,user:event.sender,body:'后续消息'}];
  const input=conversation(issue,current,comments);
  assert.equal(input.currentMessage,'审稿失败怎么恢复？');
  assert.equal(input.history.length,1);
  assert.equal(searchQuery(input),'审稿失败怎么恢复？');
  assert.ok(searchQuery({...input,currentMessage:'这个在哪里配置？'}).includes('模型配置'));
});
test('问候和感谢简短处理，带真实问题的问候不能被吞掉',()=>{
  for(const text of ['你好！','谢谢','收到','Hi!']) assert.ok(smallTalk(text));
  assert.equal(smallTalk('你好，审稿失败怎么办？'),null);
  assert.equal(smallTalk('谢谢，请继续排查'),null);
  assert.ok(smallTalk(''));
});
