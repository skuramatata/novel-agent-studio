import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chapterWordRange,
  projectWordTolerance,
} from "../runtime/word-range.mjs";
import { lengthIssues } from "../runtime/writing.mjs";
import { ProjectStore } from "../runtime/storage.mjs";
import { applyProposal, projectSchema } from "../runtime/schema.mjs";
import { blankProject, demoProposal } from "../runtime/seed.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";

test("固定容差不再锁死500字，百分比随目标变化并采用整数边界", () => {
  assert.deepEqual(chapterWordRange(4500), { min: 4000, max: 5000 });
  assert.deepEqual(chapterWordRange(10000, { mode: "absolute", value: 3000 }), {
    min: 7000,
    max: 13000,
  });
  const percentage = { mode: "percent", value: 20 };
  assert.deepEqual(chapterWordRange(4500, percentage), {
    min: 3600,
    max: 5400,
  });
  assert.deepEqual(chapterWordRange(10000, percentage), {
    min: 8000,
    max: 12000,
  });
  assert.deepEqual(chapterWordRange(4500, { mode: "percent", value: 12.5 }), {
    min: 3938,
    max: 5062,
  });
  assert.deepEqual(chapterWordRange(4500, { mode: "absolute", value: 0 }), {
    min: 4500,
    max: 4500,
  });
  assert.deepEqual(chapterWordRange(4500, { mode: "absolute", value: 20000 }), {
    min: 100,
    max: 24500,
  });
  for (const words of [7999, 8000, 12000, 12001]) {
    assert.equal(
      lengthIssues(
        [{ id: "a", content: "字".repeat(words) }],
        [{ chapterId: "a", words: 10000 }],
        percentage,
      ).length,
      words < 8000 || words > 12000 ? 1 : 0,
    );
  }
});

test("作品保存和重载保留容差，旧作品兼容，模型候选无权修改容差", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "word-tolerance-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ProjectStore(dir),
    old = await store.load();
  assert.deepEqual(projectWordTolerance(old), { mode: "absolute", value: 500 });
  const writingSettings = { wordTolerance: { mode: "percent", value: 25 } };
  const saved = await store.save({ ...old, writingSettings }, old.revision);
  const loaded = await new ProjectStore(dir).load();
  assert.deepEqual(loaded.writingSettings, writingSettings);
  assert.deepEqual(
    projectSchema.parse(JSON.parse(JSON.stringify(loaded))).writingSettings,
    writingSettings,
  );
  assert.deepEqual(
    applyProposal(saved, demoProposal(), saved.revision).writingSettings,
    writingSettings,
  );
  assert.throws(() =>
    applyProposal(
      saved,
      {
        summary: "修改容差",
        writingSettings: { wordTolerance: { mode: "absolute", value: 500 } },
      },
      saved.revision,
    ),
  );
  for (const wordTolerance of [
    { mode: "absolute", value: -1 },
    { mode: "absolute", value: 1.5 },
    { mode: "percent", value: Infinity },
    { mode: "percent", value: NaN },
    { mode: "auto", value: 500 },
  ]) {
    await assert.rejects(() =>
      store.save(
        { ...saved, writingSettings: { wordTolerance } },
        saved.revision,
      ),
    );
  }
  assert.deepEqual(
    (await new ProjectStore(dir).load()).writingSettings,
    writingSettings,
  );
});

test("容差在任务启动时快照，恢复不改变旧规则，新任务采用新配置", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tolerance-checkpoint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = blankProject(),
    cp = new Checkpoint(dir),
    config = {
      provider: "minimax",
      model: "MiniMax-M3",
      baseUrl: "https://api.minimaxi.com/v1",
    };
  p.writingSettings = { wordTolerance: { mode: "percent", value: 20 } };
  const first = await cp.begin(p, { instruction: "起草第一章" }, config);
  p.writingSettings.wordTolerance.value = 30;
  assert.equal(first.wordTolerance.value, 20);
  assert.equal(
    (await cp.begin(p, { resume: true }, config)).wordTolerance.value,
    20,
  );
  const next = await cp.begin(p, { instruction: "起草第一章" }, config);
  assert.equal(next.wordTolerance.value, 30);
  delete next.wordTolerance;
  await cp.write(next);
  assert.deepEqual(
    (await cp.begin(p, { resume: true }, config)).wordTolerance,
    { mode: "absolute", value: 500 },
  );
});
