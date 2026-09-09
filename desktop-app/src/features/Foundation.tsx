import { useState } from "react";
import { Save, Feather, BookOpen, Sparkles } from "lucide-react";
import { authorPresets } from "../../runtime/seed.mjs";
import { useStudio } from "../state/StudioContext";
import type { Author, Premise, WordTolerance } from "../lib/types";
import {
  chapterWordRange,
  projectWordTolerance,
  validWordTolerance,
} from "../../runtime/word-range.mjs";
export function Foundation() {
  const { project, update, setNotice } = useStudio();
  const [author, setAuthor] = useState<Author>(project!.author);
  const [premise, setPremise] = useState<Premise>(project!.premise);
  const [wordTolerance, setWordTolerance] = useState<WordTolerance>(() =>
    projectWordTolerance(project),
  );
  const validTolerance = validWordTolerance(wordTolerance);
  const range =
    validTolerance &&
    Number.isSafeInteger(premise.chapterWords) &&
    premise.chapterWords >= 100
      ? chapterWordRange(premise.chapterWords, wordTolerance)
      : null;
  const [saving, setSaving] = useState(false);
  const field = (key: keyof Author, label: string, rows = 3) => (
    <label key={key}>
      {label}
      <textarea
        rows={rows}
        value={author[key]}
        onChange={(e) => setAuthor({ ...author, [key]: e.target.value })}
      />
    </label>
  );
  async function save() {
    setSaving(true);
    if (
      await update((p) => ({
        ...p,
        author,
        premise,
        writingSettings: { wordTolerance },
      }))
    )
      setNotice("作者档案与作品前提已保存");
    setSaving(false);
  }
  return (
    <div className="scroll-page foundation">
      <div className="page-intro">
        <div>
          <span className="eyebrow">每一个故事，都有自己的声音</span>
          <h1>作者与作品</h1>
          <p>先决定如何观察世界，再决定讲述什么。</p>
        </div>
        <button
          className="primary"
          disabled={saving || !validTolerance}
          onClick={() => void save()}
        >
          <Save size={16} />
          {saving ? "保存中…" : "保存设定"}
        </button>
      </div>
      <div className="foundation-grid">
        <section className="panel">
          <div className="panel-title">
            <Feather size={19} />
            <h3>作者档案</h3>
            <span className="tag">全书生效</span>
          </div>
          <label>
            从预设开始
            <select
              value=""
              onChange={(e) => {
                const a = authorPresets[Number(e.target.value)];
                if (a) setAuthor({ ...a });
              }}
            >
              <option value="" disabled>
                选择一个声音，再慢慢调整
              </option>
              {authorPresets.map((p, i) => (
                <option key={p.name} value={i}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {field("name", "作者人格名称", 1)}
          {field("personality", "人格与审美")}
          <div className="two-columns">
            {field("chinese", "中国文学积累", 4)}
            {field("western", "西方文学积累", 4)}
          </div>
          {field("habits", "语言习惯与口癖")}
          {field("references", "作品引用与比喻偏好")}
          {field("avoid", "希望避免的表达")}
          <div className="tip">
            <Sparkles size={16} />
            <span>口癖是有条件的习惯，不是每章必须出现的台词。</span>
          </div>
        </section>
        <section className="panel">
          <div className="panel-title">
            <BookOpen size={19} />
            <h3>作品前提</h3>
            <span className="tag">规划依据</span>
          </div>
          {(["title", "genre", "narrator"] as const).map((k, i) => (
            <label key={k}>
              {["暂定书名", "题材与气质", "叙述视角"][i]}
              <input
                value={premise[k]}
                onChange={(e) =>
                  setPremise({ ...premise, [k]: e.target.value })
                }
              />
            </label>
          ))}
          <label>
            故事发生在哪里
            <textarea
              rows={5}
              value={premise.setting}
              onChange={(e) =>
                setPremise({ ...premise, setting: e.target.value })
              }
              placeholder="时代、地点，以及日常中出现的第一个异常…"
            />
          </label>
          <label>
            主题与想留下的感受
            <textarea
              rows={4}
              value={premise.theme}
              onChange={(e) =>
                setPremise({ ...premise, theme: e.target.value })
              }
              placeholder="读者合上故事时，仍会在意什么？"
            />
          </label>
          <div className="two-columns">
            <label>
              预计章节
              <input
                type="number"
                min={1}
                max={200}
                value={premise.chapterCount}
                onChange={(e) =>
                  setPremise({
                    ...premise,
                    chapterCount: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              每章目标字数
              <input
                type="number"
                min={100}
                max={10000}
                step={100}
                value={premise.chapterWords}
                onChange={(e) =>
                  setPremise({
                    ...premise,
                    chapterWords: Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
          <div className="two-columns">
            <label>
              字数容差方式
              <select
                value={wordTolerance.mode}
                onChange={(e) => {
                  const mode = e.target.value as WordTolerance["mode"];
                  const value =
                    mode === "percent"
                      ? Math.round(
                          (wordTolerance.value / premise.chapterWords) * 10000,
                        ) / 100
                      : Math.round(
                          (premise.chapterWords * wordTolerance.value) / 100,
                        );
                  setWordTolerance({
                    mode,
                    value: Number.isFinite(value) ? value : 0,
                  });
                }}
              >
                <option value="absolute">固定字数</option>
                <option value="percent">按目标字数百分比</option>
              </select>
            </label>
            <label>
              允许上下浮动（{wordTolerance.mode === "percent" ? "%" : "字"}）
              <input
                aria-label="字数容差"
                type="number"
                min={0}
                step={wordTolerance.mode === "percent" ? "any" : 1}
                value={wordTolerance.value}
                onChange={(e) =>
                  setWordTolerance({
                    ...wordTolerance,
                    value: Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
          <p className="small muted" aria-live="polite">
            {range
              ? `每章允许 ${range.min}—${range.max} 字（含边界）。`
              : "请输入有效的目标字数和非负容差，固定字数须为整数。"}
            保存后对新任务生效；恢复已有任务时沿用启动时的容差。按比例会随章节目标字数调整，0
            表示严格按目标字数验收。
          </p>
          <div className="estimate">
            <span>预计全书</span>
            <strong>
              {((premise.chapterCount * premise.chapterWords) / 10000).toFixed(
                1,
              )}{" "}
              <small>万字</small>
            </strong>
            <p>这是规划参考，可以随故事发展调整。</p>
          </div>
        </section>
      </div>
    </div>
  );
}
