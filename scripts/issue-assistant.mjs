import { readFile, writeFile, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PREFIX = '<!-- issue-assistant:v1:';
export function eventKey(event) {
  return `${PREFIX}${event.issue.number}:${event.comment ? `comment-${event.comment.id}` : 'opened'} -->`;
}
export function eligible(event, comments) {
  if (!event.issue || event.issue.pull_request || event.issue.state !== 'open') return false;
  const actor = event.comment?.user ?? event.sender;
  if (!actor || actor.type === 'Bot' || actor.login.endsWith('[bot]')) return false;
  if (event.comment && !/^\/ai(?:\s|$)/i.test(event.comment.body.trim())) return false;
  const replies = comments.filter(c => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(PREFIX));
  return replies.length < 5 && !replies.some(c => c.body.startsWith(eventKey(event)));
}
export function conversation(issue, event, comments) {
  const currentMessage = (event.comment ? event.comment.body.replace(/^\s*\/ai(?:\s+|$)/i, '') : `${issue.title}\n${issue.body ?? ''}`).trim().slice(0,16000);
  // 重跑旧事件时，不把后续评论倒灌进本次上下文。
  const history = comments.filter(c => !event.comment || Number(c.id) < Number(event.comment.id))
    .slice(-12).map(c => ({author:c.user.login,body:c.body.slice(0,2500)}));
  return {originalIssue:{title:issue.title,body:(issue.body ?? '').slice(0,12000)},history,currentMessage};
}
export function smallTalk(message) {
  const text=message.toLowerCase().replace(/[\s，。！？,.!?～~]/g,'');
  if (!text) return '请在 /ai 后写上想了解的问题。';
  if (/^(你好|您好|嗨|哈喽|hello|hi)$/.test(text)) return '你好！你想了解什么，或需要我继续分析哪个问题？';
  if (/^(谢谢|谢谢你|感谢|多谢|thanks|thankyou|收到|好的|明白了|了解了|ok)$/.test(text)) return '不客气！有其他问题可以继续用 /ai 追问。';
  return null;
}
export function searchQuery(input) {
  // 明确新问题只检索当前消息；短指代问题再补充最近的人类问题和原主题。
  const current=input.currentMessage;
  const contextual=current.length<100 && /这个|那个|它|上述|刚才|继续|具体|哪里|怎么配|如何配|密钥|key/i.test(current);
  if(!contextual) return current;
  const previous=[...input.history].reverse().find(c=>!c.author.endsWith('[bot]') && !smallTalk(c.body.replace(/^\s*\/ai\s*/i,'')));
  return `${current}\n${previous?.body ?? ''}\n${input.originalIssue.title}`.slice(0,18000);
}
export function hasBodyLink(result) {
  return typeof result?.answer==='string' && /https?:\/\/|www\.|\]\(/i.test(result.answer);
}
export function allowed(path) {
  return path === 'README.md' || /^(?:docs|agent-design)\/.*\.md$/.test(path) ||
    /^desktop-app\/(?:README\.md|docs\/.*\.md|(?:src|runtime|electron)\/.*\.(?:ts|tsx|js|mjs|cjs|css))$/.test(path);
}
export function terms(query) {
  const words = query.toLowerCase().match(/[a-z_][a-z0-9_-]{2,}|[\p{Script=Han}]{2,}/gu) ?? [];
  return [...new Set(words.flatMap(w => /\p{Script=Han}/u.test(w) ? Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2)) : [w]))].slice(0,180);
}
export async function retrieve(query) {
  const tokens = terms(query);
  const files = execFileSync('git', ['ls-files', '-z'], {encoding:'utf8'}).split('\0').filter(allowed);
  const chunks = [];
  for (const file of files) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 600000) continue;
    const lines = (await readFile(file,'utf8')).split('\n');
    for (let i=0;i<lines.length;i+=45) {
      const text = lines.slice(i,i+60).join('\n').slice(0,6000);
      const hay = `${file}\n${text}`.toLowerCase();
      const score = tokens.reduce((n,t)=> n+(hay.includes(t)?1:0),0);
      if (score || (file==='README.md' && i===0)) chunks.push({file,start:i+1,end:Math.min(i+60,lines.length),text,score});
    }
  }
  return chunks.sort((a,b)=>b.score-a.score).slice(0,8).map((c,i)=>({...c,id:`S${i+1}`}));
}
export function render(result, sources, repo, sha) {
  if (typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length>9000 || !Array.isArray(result.sources)) throw Error('模型回复格式无效');
  if (hasBodyLink(result)) throw Error('模型正文含链接，需要重新整理');
  const ids = [...new Set(result.sources)];
  if (ids.some(id=>!sources.some(s=>s.id===id))) throw Error('模型引用了不存在的来源');
  // 链接由程序生成；模型正文只能输出纯文本，避免伪造链接和批量提及。
  const answer = result.answer.replaceAll('@','＠').replace(/[<>\[\]`]/g,'');
  const links = ids.map(id=>{
    const s=sources.find(s=>s.id===id);
    return `- [${s.file}:${s.start}](https://github.com/${repo}/blob/${sha}/${s.file.split('/').map(encodeURIComponent).join('/')}#L${s.start}-L${s.end})`;
  });
  return `🤖 AI 自动分析（未经维护者确认）\n\n${answer}\n\n${links.length ? `参考依据：\n${links.join('\n')}` : '未找到足够的仓库依据，需要维护者确认。'}\n\n需要继续分析时，请以 /ai 开头补充信息。每个 Issue 最多自动回复 5 次。`;
}
async function github(path) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`, {headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
  if (!res.ok) throw Error(`GitHub 请求失败：${res.status}`);
  return res.json();
}
export async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
  if (!event.issue || event.issue.pull_request) return;
  const comments=[];
  for(let page=1;page<=10;page++) {
    const batch=await github(`issues/${event.issue.number}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if(batch.length<100) break;
    if(page===10) throw Error('评论过多，交由维护者处理');
  }
  if (!eligible(event,comments)) return;
  const issue = await github(`issues/${event.issue.number}`);
  if(issue.state!=='open') return;
  const input=conversation(issue,event,comments);
  const shortReply=event.comment ? smallTalk(input.currentMessage) : null;
  let body;
  if(shortReply) {
    body=`🤖 Issue 助手\n\n${shortReply}`;
  } else {
    if(!process.env.DEEPSEEK_API_KEY) throw Error('请配置 DEEPSEEK_API_KEY 仓库 Secret');
    const sources = await retrieve(searchQuery(input));
    const rules = await readFile('.github/issue-assistant.md','utf8');
    const messages=[{role:'system',content:rules},{role:'user',content:JSON.stringify({...input,sources})}];
    let result;
    for(let attempt=0;attempt<2;attempt++) {
      const res=await fetch('https://api.deepseek.com/chat/completions',{
        method:'POST',headers:{Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(120000),
        body:JSON.stringify({model:process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',thinking:{type:'disabled'},max_tokens:2200,response_format:{type:'json_object'},messages})
      });
      if(!res.ok) throw Error(`DeepSeek 请求失败：${res.status}，检查密钥、额度和模型配置`);
      const response=await res.json();
      const choice=response.choices?.[0];
      if(choice?.finish_reason!=='stop') throw Error('模型未完整生成回复');
      result=JSON.parse(choice.message.content);
      if(!hasBodyLink(result)) break;
      // 保留原始上下文，仅允许一次格式修正；不发布破碎的替换文案。
      messages.push({role:'assistant',content:choice.message.content},{role:'user',content:'请重新输出 JSON：正文不得包含 URL 或 Markdown 链接。用完整自然的句子说明配置位置或方法，文件引用仅放在 sources 中；不要写“链接省略”。只修正格式，不扩展回答。'});
    }
    body=render(result,sources,process.env.GITHUB_REPOSITORY,process.env.GITHUB_SHA);
  }
  await writeFile('reply.json',JSON.stringify({marker:eventKey(event),body:`${eventKey(event)}\n${body}`}));
  await writeFile(process.env.GITHUB_OUTPUT,'ready=true\n',{flag:'a'});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
