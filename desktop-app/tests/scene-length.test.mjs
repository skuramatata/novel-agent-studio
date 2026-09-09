import test from "node:test";
import assert from "node:assert/strict";
import {
  sceneLengthMessages,
  lengthDistance,
} from "../runtime/scene-length.mjs";

test("压缩提示只携带当前稿及相邻衔接，明确删减量与实测反馈", () => {
  const draft = "稿".repeat(2626);
  const messages = sceneLengthMessages({
    draft,
    targetWords: 1125,
    lower: 788,
    upper: 1800,
    scene: { goal: "登岸并清点人数" },
    author: { name: "作者" },
    previousScenes: [{ content: "更早场景" }, { content: "紧邻前场景" }],
    followingScenes: [{ content: "紧邻后场景" }, { content: "更晚场景" }],
    feedback: [],
    attempts: [{ candidateWords: 2626, improved: false }],
  });
  assert.match(messages[0].content, /至少删去826字/);
  assert.match(messages[0].content, /实质压缩/);
  assert.match(messages[0].content, /不再输出同一版本/);
  const data = JSON.parse(messages[1].content);
  assert.equal(data.draft, draft);
  assert.equal(data.task.actualWords, 2626);
  assert.deepEqual(data.previousScenes, [{ content: "紧邻前场景" }]);
  assert.deepEqual(data.followingScenes, [{ content: "紧邻后场景" }]);
  assert.equal(data.attempts[0].candidateWords, 2626);
  assert.ok(!Object.hasOwn(data, "evidence"));
});
test("是否改善以允许区间为准，超短与超长均不能冒充达标", () => {
  assert.equal(lengthDistance(1125, 788, 1800), 0);
  assert.equal(lengthDistance(2626, 788, 1800), 826);
  assert.equal(lengthDistance(600, 788, 1800), 188);
});
