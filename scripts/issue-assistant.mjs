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
  const ids = [...new Set(result.sources)];
  if (ids.some(id=>!sources.some(s=>s.id===id))) throw Error('模型引用了不存在的来源');
  // 链接由程序生成；模型正文只能输出纯文本，避免伪造链接和批量提及。
  const answer = result.answer.replaceAll('@','＠').replace(/[<>\[\]`]/g,'').replace(/https?:\/\/\S+/g,'（链接省略，请查看下方依据）');
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
  if(!process.env.DEEPSEEK_API_KEY) throw Error('请配置 DEEPSEEK_API_KEY 仓库 Secret');
  const query = `${issue.title}\n${issue.body ?? ''}\n${event.comment?.body ?? ''}`.slice(0,16000);
  const sources = await retrieve(query);
  const rules = await readFile('.github/issue-assistant.md','utf8');
  const res=await fetch('https://api.deepseek.com/chat/completions',{
    method:'POST',headers:{Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(120000),
    body:JSON.stringify({model:process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',thinking:{type:'disabled'},max_tokens:2200,response_format:{type:'json_object'},messages:[
      {role:'system',content:rules},
      {role:'user',content:JSON.stringify({issue:query,history:comments.slice(-12).map(c=>({author:c.user.login,body:c.body.slice(0,2500)})),sources})}
    ]})
  });
  if(!res.ok) throw Error(`DeepSeek 请求失败：${res.status}，检查密钥、额度和模型配置`);
  const response=await res.json();
  const choice=response.choices?.[0];
  if(choice?.finish_reason!=='stop') throw Error('模型未完整生成回复');
  const body=render(JSON.parse(choice.message.content),sources,process.env.GITHUB_REPOSITORY,process.env.GITHUB_SHA);
  await writeFile('reply.json',JSON.stringify({marker:eventKey(event),body:`${eventKey(event)}\n${body}`}));
  await writeFile(process.env.GITHUB_OUTPUT,'ready=true\n',{flag:'a'});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
