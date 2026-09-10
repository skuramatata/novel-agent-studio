import { createHash } from "node:crypto";
import { remapReviewChecks } from "./review-result.mjs";
import { coalesceReviewFindings } from "./review-dedup.mjs";

export const CONTINUITY_VERSION = 1;
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const datePattern =
  /(?:[零〇一二三四五六七八九十廿卅两\d]{1,6}年)?[正腊零〇一二三四五六七八九十两\d]{1,3}月(?:初)?[零〇一二三四五六七八九十廿卅两\d]{1,3}(?:日|号)?/;
const intervalPattern =
  /(?:第[一二三四五六七八九十百\d]+[天夜日]|半[年月]|[一二三四五六七八九十百两\d]+个?[年月天日夜]|次日|翌日|当晚|每逢|每隔)/;
const grams = (text) =>
  new Set(
    (String(text).match(/[\p{L}\p{N}]+/gu) || []).flatMap((s) =>
      [...s].slice(1).map((_, i) => s.slice(i, i + 2)),
    ),
  );

// 只计算同一已知公历中的明确日期。不猜农历、跨年、未知年份的闰日。
export function elapsedDays(from, to) {
  if (from?.calendar !== "gregorian" || to?.calendar !== "gregorian")
    return null;
  if (![from.month, from.day, to.month, to.day].every(Number.isInteger))
    return null;
  if ((from.year == null) !== (to.year == null)) return null;
  if (from.year == null) {
    if (to.month < from.month || (to.month === from.month && to.day < from.day))
      return null;
    if (from.month <= 2 && to.month >= 3) return null;
    if (
      (from.month === 2 && from.day === 29) ||
      (to.month === 2 && to.day === 29)
    )
      return null;
  }
  const stamp = (date) => {
    const year = date.year ?? 2001;
    const value = new Date(0);
    value.setUTCFullYear(year, date.month - 1, date.day);
    value.setUTCHours(0, 0, 0, 0);
    return value.getUTCFullYear() === year &&
      value.getUTCMonth() === date.month - 1 &&
      value.getUTCDate() === date.day
      ? value.getTime()
      : null;
  };
  const a = stamp(from),
    b = stamp(to);
  return a === null || b === null ? null : (b - a) / 86400000;
}

export function timelineChecks(records) {
  const checks = [];
  for (const row of records) {
    const info = row.continuity;
    if (
      info?.assertion !== "narration" ||
      !info.time?.since ||
      info.time.elapsedDays == null
    )
      continue;
    const anchors = records.filter(
      (r) =>
        r.continuity?.assertion === "narration" &&
        r.continuity.time?.anchor === info.time.since,
    );
    // 同名锚点已冲突时交给审稿，不能偷偷挑第一条作为真相。
    const dates = new Set(
      anchors.map((a) =>
        JSON.stringify([
          a.continuity.time.calendar,
          a.continuity.time.year,
          a.continuity.time.month,
          a.continuity.time.day,
        ]),
      ),
    );
    if (dates.size !== 1) continue;
    const anchor = anchors[0];
    const actual = elapsedDays(anchor?.continuity.time, info.time);
    if (actual === null) continue;
    checks.push({
      anchor: info.time.since,
      actualDays: actual,
      statedDays: info.time.elapsedDays,
      mismatch: actual !== info.time.elapsedDays,
      evidence: [anchor.quote, row.quote],
      policy:
        "仅是日期算术结果，须回原文核对语境、叙述可靠性与按经过天数或第几天计数，不能直接自动改稿。",
    });
  }
  return checks;
}

export function continuityLedger(entries, query = "") {
  const records = entries.flatMap((e) =>
    e.records.map((r) => ({
      ...r,
      chapterId: e.chapterId,
      part: e.part,
      sourceHash: e.sourceHash,
    })),
  );
  const timed = records.filter(
    (r) =>
      r.continuity?.time ||
      datePattern.test(r.quote) ||
      intervalPattern.test(r.quote),
  );
  const anchors = new Map();
  for (const r of timed) {
    const key = r.continuity?.time?.anchor;
    if (key && !anchors.has(key)) anchors.set(key, r);
  }
  // 书首、当前时间和具名锚点独立于一般相关性检索，超出时明确报告覆盖范围。
  const selected = [
    ...new Set(
      [timed[0], ...timed.slice(-4), ...anchors.values()].filter(Boolean),
    ),
  ].slice(0, 32);
  const related = records.filter(
    (r) =>
      r.continuity &&
      (r.entities.some((x) => x && query.includes(x)) ||
        (r.continuity.object && query.includes(r.continuity.object))),
  );
  const objects = new Map();
  for (const r of related) {
    const key =
      r.continuity.object || r.continuity.actor || r.entities[0] || "未定对象";
    if (!objects.has(key)) objects.set(key, []);
    objects.get(key).push(r);
  }
  // 同一对象保留最早行动与最近状态，不能只剩“现在在架子上”而丢了搬放者。
  const facts = [
    ...new Set(
      [...objects.values()].flatMap((group) => [
        ...group.slice(0, 2),
        ...group.slice(-2),
      ]),
    ),
  ].slice(0, 24);
  const project = (r) => ({
    chapterId: r.chapterId,
    quote: r.quote,
    text: r.text,
    knownBy: r.knownBy,
    epistemic: r.epistemic,
    continuity: r.continuity ?? null,
  });
  return {
    version: CONTINUITY_VERSION,
    timeAnchors: selected.map(project),
    relatedFacts: facts.map(project),
    calculations: timelineChecks(records),
    coverage: {
      totalTimeRecords: timed.length,
      suppliedTimeRecords: selected.length,
      totalRecords: records.length,
      totalRelatedFacts: related.length,
      suppliedRelatedFacts: facts.length,
    },
    rules:
      "本表源于已采纳正文，条目仍需核对引文，不是真相表。证词、文件所载、推断不能升级为真实行动；未知时间不补造。不把计划当历史。时间锚点不会被普通上下文裁剪删除，未列出的历史仍可回查。",
  };
}

// 独立扫描已采纳正文，不受写作者那批记忆的命中结果限制。
// 每段保留相邻段以还原代词和动作主体；限额只控制传给模型的摘录，完整正文不变。
export function retrieveContinuitySources(
  chapters,
  targetNumber,
  draft,
  { maxChars = 20000, maxParagraphs = 100 } = {},
) {
  const prior = chapters
    .filter((c) => c.number < targetNumber && c.content)
    .sort((a, b) => a.number - b.number);
  const rows = prior.flatMap((c) =>
    c.content.split(/\n\s*\n/).map((text, i) => ({
      chapter: c,
      paragraph: i + 1,
      text,
      grams: grams(text),
    })),
  );
  const query = grams(draft);
  rows.forEach((row, index) => {
    row.index = index;
  });
  const frequency = new Map();
  for (const row of rows)
    for (const term of row.grams)
      frequency.set(term, (frequency.get(term) || 0) + 1);
  const timed = rows.filter(
    (r) => datePattern.test(r.text) || intervalPattern.test(r.text),
  );
  const timedSet = new Set(timed);
  for (const row of rows)
    row.score =
      [...row.grams]
        .filter((g) => query.has(g))
        .reduce((n, g) => n + Math.log(1 + rows.length / frequency.get(g)), 0) /
      Math.sqrt(Math.max(1, row.grams.size));
  const timeFirst = timed.filter((r) => datePattern.test(r.text));
  const ranked = [
    ...new Set(
      [
        timeFirst[0],
        ...timeFirst.slice(-2),
        ...timed
          .filter((r) =>
            /到岛|到岗|到任|接塔|抵达|初次|首次|每隔|每月|一季度/.test(r.text),
          )
          .sort((a, b) => b.score - a.score)
          .slice(0, 8),
        ...rows
          .slice()
          .sort(
            (a, b) =>
              b.score - a.score ||
              a.chapter.number - b.chapter.number ||
              a.paragraph - b.paragraph,
          ),
      ].filter(Boolean),
    ),
  ];
  const chosen = new Set();
  let size = 0;
  for (const row of ranked) {
    if (chosen.has(row) || (!row.score && !timedSet.has(row))) continue;
    const index = row.index;
    const group = rows
      .slice(Math.max(0, index - 1), index + 2)
      .filter((r) => r.chapter.id === row.chapter.id && !chosen.has(r));
    const extra = group.reduce((n, r) => n + r.text.length, 0);
    if (size + extra > maxChars || chosen.size + group.length > maxParagraphs)
      continue;
    for (const r of group) chosen.add(r);
    size += extra;
  }
  const sources = prior.flatMap((c) => {
    const selected = rows.filter((r) => r.chapter.id === c.id && chosen.has(r));
    if (!selected.length) return [];
    return [
      {
        sourceId: `continuity:${c.id}`,
        label: `独立回查第${c.number}章原文摘录（原段号${selected.map((r) => r.paragraph).join("、")}）`,
        text: selected.map((r) => r.text).join("\n\n"),
        sourceHash: hash(c.content),
        originalParagraphs: selected.map((r) => r.paragraph),
      },
    ];
  });
  return {
    sources,
    coverage: {
      scannedChapters: prior.map((c) => c.number),
      totalParagraphs: rows.length,
      suppliedParagraphs: chosen.size,
      suppliedChars: size,
      sourceFingerprint: hash(prior.map((c) => [c.id, c.content])),
      policy:
        "程序扫描全部此前正文，模型只读选中的原文及邻段。没有命中不等于全书不存在；材料不足时报告范围，不编造前情。",
    },
  };
}

export const CONTINUITY_REVIEW_RULES = `本轮只执行时间、事实与证据专项核对，不评价文风。逐项检查：
1. 首次日期、当前日期、经过天数/月数、次日/第几天、往返和补给周期；场景起止与叙事/事件顺序。calculations是程序算术提示，必须核对原文和计数方式。
2. 还原谁搬放、交出、拿走、销毁了物件，之后位置/持有人如何变化。不能把主角自己的布置归给前任；不能把物件已放回写成仍在怀里而没有交代。
3. 分开正文行动、人物证词、文件所载和人物推断；誊抄件不能直接证明原签名的笔势，口述细节丰富不能证明没有说谎。寻找真正的证据缺口，不把描写省略一概当错误。
4. 一份档案的日期与亲历不同，可以是有效悬念；人物拿来核对档案的同一本日志日期无察觉地改变，则需检查是否真有现实改写的铺垫和对照。传闻互相冲突、推测被推翻，不自动判错。
5. continuitySources来自独立回查的历史原文，continuity只作索引，冲突以实际引文为依据。timeAnchors/relatedFacts的references是程序按本批原文逐字定位的地址，可复制后核对；references为空时只能作为待回查线索，不能用索引表名、数组下标替代sourceId/paragraph。目标仅限当前章；历史原有矛盾说明来源不确定，不强行选一方。
6. 修订必须同时检查同章所有受同一日期或物件事实影响的段落，分别报告实际出错段；不补造往事来圆说。允许零问题；不把待解谜团当连续性错误。
7. 没有绝对日期仍须依据正文核对相对时序，不因此把time填为insufficient且不给证据。完全不涉及某维度才用not_applicable；insufficient用于原文中确有待核对断言而必要依据不足，须引用该断言。evidence维度覆盖所有观察、证词和推断，不只检查誊抄件这一例子。
本轮只返回dimensions、authorChecks和priorFindings；dimensions恰好三项，dimension分别time/state/evidence。发现问题时该维度只填{dimension,verdict:"issues",issues:[完整问题]}，依据、说明和修订要求仅在问题项中填写一次，不再另写顶层issues或continuityChecks。没有待处理问题时填{dimension,verdict:"consistent"或"insufficient"或"not_applicable",evidence:[实际原文地址],explanation:"依据"}；只有not_applicable可以没有证据。程序从维度内的问题直接生成问题列表和汇总状态，不需要模型重复维护。三个维度合计最多16个问题。未知日期或有意留白本身不要求修改；若材料不足已影响当前结论且必须裁定，必须在对应维度内列出问题并用needs_confirmation，即使分类为ambiguity也会进入依据裁定。
推理依据专项应明确角色实际持有什么材料，以及该材料能支持哪一步结论。没有原件、照片或明确摹写过程，却据普通誊抄件断言原签名的用笔习惯时，引用材料形态和结论两处，归unsupported_inference；只能明确收回无依据的肯定结论或交由裁定，不能凭空补拍照、摹写等前情。材料形态本身不明才归ambiguity；明确只是人物怀疑时不要当成作者已证实的结论。不能仅因为恐怖题材就默认誊抄保留笔迹。`;

export function mergeContinuityReview(specialist, general) {
  const { issues, owners } = coalesceReviewFindings(
    [...specialist.issues, ...general.issues].sort(
      (a, b) => Number(b.blocking) - Number(a.blocking),
    ),
  );
  const ids = new Map(issues.map((i, n) => [i, `finding-${n + 1}`]));
  return {
    ...general,
    continuityChecks: remapReviewChecks(
      specialist.continuityChecks,
      new Map(specialist.issues.map((i) => [i.id, ids.get(owners.get(i))])),
    ),
    suppliedScopes: [specialist, general].flatMap(
      (r) => r.suppliedScopes || (r.suppliedScope ? [r.suppliedScope] : []),
    ),
    issues: issues.map((i, n) => ({ ...i, id: `finding-${n + 1}` })),
  };
}
