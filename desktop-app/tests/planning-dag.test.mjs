import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDag } from "../runtime/dag.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { blankProject, demoProposal } from "../runtime/seed.mjs";
import { applyProposal, readyForChapter } from "../runtime/schema.mjs";
import { validatePlanningIntent } from "../runtime/planning-dag.mjs";
const config = {
  provider: "glm",
  model: "glm-5.2",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  apiKey: "test",
};
const response = (v) =>
  new Response(
    JSON.stringify({
      choices: [
        { message: { content: JSON.stringify(v) }, finish_reason: "stop" },
      ],
    }),
  );
function fixtureFetch(seen, { fail = 0 } = {}) {
  let batch = 0;
  return async (url, opts) => {
    const b = JSON.parse(opts.body),
      sys = b.messages[0].content,
      data = JSON.parse(b.messages[1].content);
    seen.push({ sys, data });
    if (sys.includes("识别规划入口"))
      return response({
        mode: "prepare",
        chapterCount: 12,
        chapterWords: 5000,
        countEvidence: "12 个章节",
        wordsEvidence: "每章节 5000 字",
      });
    if (sys.includes("补齐故事基础规划")) {
      const d = demoProposal();
      return response({
        plan: d.plan,
        characters: d.characters,
        relations: d.relations,
      });
    }
    if (sys.includes("生成指定章节")) {
      if (++batch === fail) throw Error("模拟网络中断");
      return response({
        chapters: data.numbers.map((number) => ({
          number,
          title: `第${number}章`,
          summary: "按既有总纲推进，保留人物知情边界。",
        })),
      });
    }
    throw Error("意外请求正文或旧流程：" + sys.slice(0, 30));
  };
}
async function setup(blank = false) {
  const p = blank
    ? blankProject()
    : applyProposal(blankProject(), demoProposal(), 0);
  p.chapters = [];
  const dir = await mkdtemp(join(tmpdir(), "novel-plan-dag-"));
  const checkpoint = new Checkpoint(dir);
  const state = await checkpoint.begin(
    p,
    { instruction: "按 12 个章节，每章节 5000 字来" },
    config,
  );
  return { p, dir, checkpoint, state };
}
async function run(f, fetcher, state = f.state) {
  return runChapterAgent(
    f.p,
    config,
    new AbortController().signal,
    () => {},
    f.checkpoint,
    state,
    fetcher,
  );
}
test("12章5000字缺章纲入口进入DAG，四批规划且所有正文为空", async () => {
  const f = await setup();
  try {
    const seen = [];
    const result = await run(f, fixtureFetch(seen));
    assert.equal(result.legacy, undefined);
    assert.equal(result.proposal.premise.chapterWords, 5000);
    assert.equal(result.proposal.chapters.length, 12);
    assert.ok(result.proposal.chapters.every((c) => c.content === ""));
    assert.deepEqual(result.proposal.plan, f.p.plan);
    assert.equal(seen.filter((s) => s.sys.includes("生成指定章节")).length, 4);
    assert.equal(
      seen.filter((s) => s.sys.includes("补齐故事基础规划")).length,
      0,
    );
    assert.equal(f.p.chapters.length, 0);
    assert.ok(
      readyForChapter(applyProposal(f.p, result.proposal, f.p.revision)),
    );
    assert.equal(
      f.state.graphs["planning-v1"].nodes.candidate.status,
      "completed",
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("规划第三批断网，恢复只生成未完成章纲，保留前两批结果", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      () => run(f, fixtureFetch([], { fail: 3 })),
      /网络中断/,
    );
    const state = await f.checkpoint.begin(f.p, { resume: true }, config),
      seen = [];
    const result = await run(f, fixtureFetch(seen), state);
    assert.equal(result.proposal.chapters.length, 12);
    assert.deepEqual(
      seen
        .filter((s) => s.sys.includes("生成指定章节"))
        .map((s) => s.data.numbers),
      [
        [7, 8, 9],
        [10, 11, 12],
      ],
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("空作品先补基础，再分批章纲，采纳前不生成正文", async () => {
  const f = await setup(true);
  try {
    const seen = [];
    const result = await run(f, fixtureFetch(seen));
    assert.ok(
      readyForChapter(applyProposal(f.p, result.proposal, f.p.revision)),
    );
    assert.equal(
      seen.filter((s) => s.sys.includes("补齐故事基础规划")).length,
      1,
    );
    assert.ok(result.proposal.chapters.every((c) => !c.content));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("DAG执行前拒绝循环和不存在依赖，完成节点恢复不重跑", async () => {
  const opts = {
    state: {},
    save: async () => {},
    signal: new AbortController().signal,
    key: "test",
  };
  let calls = 0;
  const node = (id, deps) => ({
    id,
    deps,
    validate: (v) => v,
    run: async () => ++calls,
  });
  await assert.rejects(
    () => runDag([node("a", ["b"]), node("b", ["a"])], opts),
    /循环/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () => runDag([node("a", ["unknown"])], opts),
    /依赖不存在/,
  );
  await runDag([node("a", []), node("b", ["a"])], opts);
  await runDag([node("a", []), node("b", ["a"])], opts);
  assert.equal(calls, 2);
});
test("规划节点拒绝混入正文，不把截断或违规输出拼成候选", async () => {
  const f = await setup();
  try {
    const normal = fixtureFetch([]);
    await assert.rejects(
      () =>
        run(f, async (u, o) => {
          const b = JSON.parse(o.body),
            data = JSON.parse(b.messages[1].content);
          if (b.messages[0].content.includes("生成指定章节"))
            return response({
              chapters: data.numbers.map((number) => ({
                number,
                title: "错误",
                summary: "章纲",
                content: "不该生成正文",
              })),
            });
          return normal(u, o);
        }),
      /content|Unrecognized/,
    );
    assert.equal(f.state.status, "failed");
    assert.equal(f.p.chapters.length, 0);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("模型每批返回12章时按目标章号隔离，四批正常完成", async () => {
  const f = await setup();
  try {
    const normal = fixtureFetch([]);
    let batches = 0;
    const result = await run(f, async (u, o) => {
      const b = JSON.parse(o.body);
      if (b.messages[0].content.includes("生成指定章节")) {
        batches++;
        return response({
          chapters: Array.from({ length: 12 }, (_, i) => ({
            number: i + 1,
            title: `批${batches}章${i + 1}`,
            summary: "有效章纲",
          })),
        });
      }
      return normal(u, o);
    });
    assert.equal(batches, 4);
    assert.equal(result.proposal.chapters.length, 12);
    assert.equal(result.proposal.chapters[3].title, "批2章4");
    assert.ok(result.proposal.chapters.every((c) => !c.content));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("章纲范围归一化仍拒绝缺章、重复号、超范围和正文", async () => {
  const { selectOutlineBatch } = await import("../runtime/planning-dag.mjs");
  const ch = (n) => ({ number: n, title: "标题", summary: "章纲" });
  assert.throws(
    () => selectOutlineBatch({ chapters: [ch(1), ch(1)] }, [1], 12),
    /重复/,
  );
  assert.throws(
    () => selectOutlineBatch({ chapters: [ch(1)] }, [1, 2, 3], 12),
    /遗漏/,
  );
  assert.throws(
    () => selectOutlineBatch({ chapters: [ch(1), ch(13)] }, [1], 12),
    /全书范围/,
  );
  assert.throws(
    () =>
      selectOutlineBatch(
        { chapters: [{ ...ch(1), content: "正文" }] },
        [1],
        12,
      ),
    /content/,
  );
  assert.deepEqual(
    selectOutlineBatch(
      { chapters: [ch(3), ch(2), ch(1), ch(4)] },
      [1, 2, 3],
      12,
    ).chapters.map((c) => c.number),
    [1, 2, 3],
  );
});

const planningRequest =
  "根据当前作者档案，生成一个恐怖故事的大纲、人物关系和章节计划。";
test("基础规划补充人物与关系时按ID追加，保留已有角色和关系", async () => {
  for (const existingCount of [1, 2]) {
    const f = await setup(true),
      d = demoProposal();
    try {
      f.p.characters = d.characters
        .slice(0, existingCount)
        .map((c) => ({ ...c, name: `用户设定${c.name}` }));
      f.p.relations =
        existingCount === 2 ? [{ ...d.relations[0], label: "用户关系" }] : [];
      f.p.plan.truth = "用户已确定的真相";
      const original = structuredClone(f.p);
      const result = await run(f, fixtureFetch([]));
      assert.deepEqual(
        result.proposal.characters.slice(0, existingCount),
        original.characters,
      );
      assert.equal(result.proposal.characters.length, d.characters.length);
      assert.equal(result.proposal.relations.length, d.relations.length);
      if (original.relations.length)
        assert.deepEqual(result.proposal.relations[0], original.relations[0]);
      assert.equal(result.proposal.plan.truth, original.plan.truth);
      assert.deepEqual(f.p, original);
      assert.ok(
        readyForChapter(applyProposal(f.p, result.proposal, f.p.revision)),
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});
test("基础规划合并仍拒绝重复人物ID与悬空关系", async () => {
  for (const invalid of ["duplicate", "dangling"]) {
    const f = await setup(true),
      d = demoProposal();
    try {
      f.p.characters = d.characters.slice(0, 1);
      const normal = fixtureFetch([]);
      await assert.rejects(
        () =>
          run(f, async (url, opts) => {
            const body = JSON.parse(opts.body);
            if (body.messages[0].content.includes("补齐故事基础规划"))
              return response({
                plan: d.plan,
                characters:
                  invalid === "duplicate"
                    ? [...d.characters, d.characters[0]]
                    : d.characters,
                relations:
                  invalid === "dangling"
                    ? [{ ...d.relations[0], target: "不存在的人物" }]
                    : d.relations,
              });
            return normal(url, opts);
          }),
        invalid === "duplicate" ? /重复/ : /关系必须连接/,
      );
      assert.equal(f.state.status, "failed");
      assert.equal(f.p.characters.length, 1);
      assert.equal(f.p.chapters.length, 0);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});
// 本次 MiniMax-M3 保存的两次失败响应，保留原样用于回归。
const copiedIntents = [
  {
    mode: "prepare",
    chapterCount: 10,
    chapterWords: 4500,
    countEvidence: "生成一个恐怖故事的大纲、人物关系和章节计划",
    wordsEvidence: "",
  },
  {
    mode: "prepare",
    chapterCount: 10,
    chapterWords: 4500,
    countEvidence: "chapterCount:10",
    wordsEvidence: "chapterWords:4500",
  },
];
test("MiniMax复制已有规模时沿用设置，不要求用户重复提供章数字数", () => {
  for (const input of copiedIntents) {
    const before = structuredClone(input);
    assert.deepEqual(
      validatePlanningIntent(input, planningRequest, {
        chapterCount: 10,
        chapterWords: 4500,
      }),
      {
        mode: "prepare",
        chapterCount: null,
        chapterWords: null,
        countEvidence: "",
        wordsEvidence: "",
      },
    );
    assert.deepEqual(input, before);
  }
});
test("新增规模仍要求请求依据，允许只修改章数并沿用每章字数", () => {
  const premise = { chapterCount: 10, chapterWords: 4500 };
  for (const field of ["chapterCount", "chapterWords"]) {
    assert.throws(
      () =>
        validatePlanningIntent(
          {
            ...copiedIntents[1],
            [field]: field === "chapterCount" ? 12 : 5000,
          },
          planningRequest,
          premise,
        ),
      /新规模缺少本次请求原文依据.*null/,
    );
  }
  assert.deepEqual(
    validatePlanningIntent(
      { ...copiedIntents[1], chapterCount: 12, countEvidence: "十二章" },
      "改为十二章，每章字数沿用设置。",
      premise,
    ),
    {
      mode: "prepare",
      chapterCount: 12,
      chapterWords: null,
      countEvidence: "十二章",
      wordsEvidence: "",
    },
  );
});
test("MiniMax失败任务恢复后完成10章规划，已有规模和正式作品均不改变", async () => {
  for (const copied of copiedIntents) {
    const f = await setup(true);
    const minimax = {
      provider: "minimax",
      model: "MiniMax-M3",
      baseUrl: "https://api.minimaxi.com/v1",
      apiKey: "test",
    };
    try {
      f.p.premise.chapterCount = 10;
      f.p.premise.chapterWords = 4500;
      const before = structuredClone(f.p);
      const failed = await f.checkpoint.begin(
        f.p,
        { instruction: planningRequest },
        minimax,
      );
      failed.status = "failed";
      failed.error = "规模设置缺少本次请求原文依据。";
      failed.calls = 2;
      failed.fragments = Object.fromEntries(
        copiedIntents.map((value, i) => [
          `raw:planning-intent-v1:${i}`,
          JSON.stringify(value),
        ]),
      );
      await f.checkpoint.write(failed);
      const state = await f.checkpoint.begin(f.p, { resume: true }, minimax);
      const seen = [],
        normal = fixtureFetch(seen);
      let intentCalls = 0;
      const result = await runChapterAgent(
        f.p,
        minimax,
        new AbortController().signal,
        () => {},
        f.checkpoint,
        state,
        async (url, opts) => {
          const body = JSON.parse(opts.body);
          if (body.messages[0].content.includes("识别规划入口")) {
            intentCalls++;
            const data = JSON.parse(body.messages[1].content);
            assert.equal(data.premise.chapterCount, undefined);
            assert.equal(data.premise.chapterWords, undefined);
            assert.equal(data.existingChapters, undefined);
            return response(copied);
          }
          return normal(url, opts);
        },
      );
      assert.equal(intentCalls, 1);
      assert.equal(state.status, "ready");
      assert.equal(result.proposal.chapters.length, 10);
      assert.equal(result.proposal.premise.chapterWords, 4500);
      assert.ok(result.proposal.chapters.every((c) => !c.content));
      assert.deepEqual(f.p, before);
      assert.equal(
        state.fragments["raw:planning-intent-v1:0"],
        failed.fragments["raw:planning-intent-v1:0"],
      );
      assert.ok(
        readyForChapter(applyProposal(f.p, result.proposal, f.p.revision)),
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});
