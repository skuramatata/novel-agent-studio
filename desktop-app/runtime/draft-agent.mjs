import { z } from "zod";
import { contextFor, digest } from "./memory.mjs";
import { countWords } from "./writing.mjs";
import {
  reviewDocument,
  evidenceAt,
  reviewAndPatch,
  validateVerification,
} from "./paragraph-review.mjs";
import {
  authorConstraints,
  trackFindings,
  reviewWorkflow,
} from "./review-workflow.mjs";
import { modelDocument, AUTHOR_CONSTRAINT_RULES } from "./review-payload.mjs";
import { localReviewDocument, runLocalTasks } from "./review-context.mjs";
import { workflowContract, workflowMessages } from "./workflow-skill.mjs";
import { scopedRows, replaceDraftScope } from "./draft-actions.mjs";
import {
  draftScenes,
  setDraftScenes,
  recordDraftVersion,
  takeRevisionAttempt,
  currentDraftIssueStatus,
} from "./revision-session.mjs";

const rewriteContract = workflowContract(
  "author_revision",
  z.object({ text: z.string().min(1).max(50000) }),
);
const address = z.object({
  sourceId: z.string(),
  paragraph: z.number().int().positive(),
  sentence: z.number().int().positive().optional(),
});
const verifyContract = workflowContract(
  "author_verification",
  z.object({
    checks: z.array(
      z.object({
        issueId: z.string(),
        resolved: z.boolean(),
        preservedFacts: z.boolean(),
        noUnsupportedAdditions: z.boolean(),
        downstreamConsistent: z.boolean(),
        evidence: z.array(address).min(1),
        explanation: z.string(),
      }),
    ),
    authorChecks: z
      .array(
        z.object({
          id: z.string(),
          respected: z.boolean(),
          evidence: z.array(address).min(1),
        }),
      )
      .default([]),
  }),
);

export function draftProposal(p, state, reviewed = false) {
  const ch = p.chapters.find((c) => c.id === state.chapterId);
  if (!ch) throw Error("草稿对应的章节不存在。");
  const content = draftScenes(state)
    .map((s) => s.content)
    .join("\n\n");
  if (!content.trim()) throw Error("没有可交付的正文。");
  const unresolved = (state.reviewWorkflow?.issues || []).filter(
    (i) =>
      !["closed", "verified", "stale"].includes(
        currentDraftIssueStatus(state, i),
      ),
  ).length;
  return {
    summary: `第${ch.number}章草稿候选，实测${countWords(content)}字。${reviewed ? "本次审稿与修订流程已完成。" : "按作者要求交付当前版本，自动检查尚未全部完成。"}${unresolved ? `审稿记录中还有${unresolved}项待处理问题或建议。` : ""}采纳后更新作品，原稿保留。`,
    chapters: p.chapters.map((c) => (c.id === ch.id ? { ...c, content } : c)),
    // 修订草稿不复用旧章节的记忆；正式采纳后可按新原文重新建立。
    memory: {
      version: 1,
      entries: (p.memory?.entries || []).filter((e) => e.chapterId !== ch.id),
    },
    ...(ch.content ? { revisionScope: [ch.id] } : {}),
  };
}

async function regenerate({ state, context, ask, save, profile }) {
  const work = state.draftWork;
  const base = draftScenes(state);
  const scopes =
    work.scope.kind === "chapter"
      ? base.map((s) => ({ kind: "scene", sourceId: `scene:${s.scene}` }))
      : [work.scope];
  for (let attempt = work.attempt || 0; attempt < 2; attempt++) {
    takeRevisionAttempt(state, `regenerate:${work.id}:${attempt}`);
    await save();
    let proposed = structuredClone(base);
    for (const scope of scopes) {
      const doc = reviewDocument(proposed, context);
      const refs = scopedRows(proposed, scope).map((r) => ({
        sourceId: r.sourceId,
        paragraph: r.paragraph,
      }));
      const constraints = authorConstraints(state, doc);
      const messagesFor = (view) =>
        workflowMessages(
          [
            {
              role: "system",
              content: `按作者要求重新生成指定范围，输出{text:完整新正文}。范围外的事实、人物动机、前后衔接必须兼容；不能补造过去事件来掩盖矛盾。作者指定的关键事件、对白和伏笔须保留。\n${AUTHOR_CONSTRAINT_RULES}`,
            },
            {
              role: "user",
              content: JSON.stringify({
                instruction: context.instruction,
                latestInstruction:
                  work.instruction || "选择更符合文章的写法重新生成。",
                scope,
                originalText: scopedRows(base, scope)
                  .map((r) => r.text)
                  .join("\n\n"),
                chapterPlan: context.chapter,
                wordRange: state.wordTarget || null,
                authorConstraints: constraints,
                document: modelDocument(view),
                previousRejection: work.rejection || null,
              }),
            },
          ],
          rewriteContract,
        );
      const view = localReviewDocument(
        doc,
        [{ id: "rewrite", target: refs[0], evidence: refs }],
        constraints,
        { profile, output: 6500, stage: "patch", messagesFor },
      );
      const result = await ask(
        `author-rewrite:${work.id}:${attempt}:${digest(scope)}`,
        messagesFor(view),
        (v) => rewriteContract.parse(v),
        6500,
        "按作者选择的范围重新生成",
        { contract: rewriteContract },
      );
      proposed = replaceDraftScope(proposed, scope, result.text);
    }
    const nextDoc = reviewDocument(proposed, context);
    recordDraftVersion(
      state,
      "重新生成的候选（尚未通过复核）",
      proposed,
      "pending",
    );
    const words = countWords(proposed.map((s) => s.content).join("\n\n"));
    if (
      words < (state.wordTarget?.min || 0) ||
      words > (state.wordTarget?.max || Infinity)
    ) {
      work.rejection = {
        reason: "重新生成后整章字数超出约定范围，请在所选范围内调整。",
        words,
        wordRange: state.wordTarget,
      };
      work.attempt = attempt + 1;
      recordDraftVersion(
        state,
        "重生成未通过字数检查",
        proposed,
        "rejected",
        work.rejection.reason,
      );
      await save();
      continue;
    }
    await save();
    const constraints = authorConstraints(state, nextDoc);
    const problems = scopes.map((scope, i) => {
      const refs = scopedRows(proposed, scope).map((r) => ({
        sourceId: r.sourceId,
        paragraph: r.paragraph,
      }));
      return {
        id: `rewrite-${i + 1}`,
        target: refs[0],
        evidence: refs,
        allowedTargets: refs,
        preserve: [],
      };
    });
    const checked = await runLocalTasks({
      doc: nextDoc,
      issues: problems,
      constraints,
      profile,
      output: 4500,
      stage: "verify",
      contract: verifyContract,
      ask,
      key: `author-rewrite-check:${work.id}:${attempt}:${nextDoc.version}`,
      messagesFor: (view, group) => [
        {
          role: "system",
          content: `复核作者指定范围的新版本，不修改正文。逐项返回checks:{issueId,resolved,preservedFacts,noUnsupportedAdditions,downstreamConsistent,evidence,explanation}，分别检查作者要求是否落实、既有事实是否保留、是否补造无出处的往事、是否兼容相关前后文。按同一事实和修订要求复核，不另提文风偏好；不确定填false。authorChecks逐项核对作者裁定。所有证据引用本批document的实际地址。\n${AUTHOR_CONSTRAINT_RULES}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            instruction: context.instruction,
            latestInstruction: work.instruction,
            issues: group,
            authorConstraints: constraints,
            document: modelDocument(view),
            before: scopes
              .filter((scope) =>
                group.some((g) => g.target.sourceId === scope.sourceId),
              )
              .map((scope) => ({
                scope,
                text: scopedRows(base, scope)
                  .map((r) => r.text)
                  .join("\n\n"),
              })),
          }),
        },
      ],
      validate: (v, group) =>
        validateVerification(v, group, nextDoc, constraints),
      label: "核对重生成结果与前后文",
      merge: (results) => ({
        checks: results.flatMap((r) => r.checks),
        authorChecks: results.flatMap((r) => r.authorChecks),
      }),
    });
    const failed = checked.checks.filter(
      (c) =>
        !c.resolved ||
        !c.preservedFacts ||
        !c.noUnsupportedAdditions ||
        !c.downstreamConsistent,
    );
    if (failed.length || checked.authorChecks.some((c) => !c.respected)) {
      work.rejection = checked;
      work.attempt = attempt + 1;
      recordDraftVersion(
        state,
        "重生成待审版本",
        proposed,
        "rejected",
        failed.map((c) => c.explanation).join("；") || "未遵守作者裁定",
      );
      await save();
      continue;
    }
    setDraftScenes(state, proposed);
    recordDraftVersion(state, "按作者要求重生成并复核");
    work.status = "reviewing";
    await save();
    return;
  }
  throw Object.assign(
    Error("本回合的重生成结果未通过前后文复核，当前草稿保留，待审版本可查看。"),
    { code: "AUTHOR_REVISION_LIMIT" },
  );
}

/** 继续同一章的草稿，复用审稿/范围核对/补丁/复核链，不重新起草其他章节。 */
export async function runDraftWork({ p, state, ask, save, signal, profile }) {
  const work = state.draftWork;
  if (["keep", "edit", "restore"].includes(work.type)) {
    work.status = "done";
    state.status = "awaiting_instruction";
    state.stage = "作者操作已保存，可继续指导";
    await save();
    return { draftOnly: true };
  }
  if (work.type === "deliver") {
    work.status = "done";
    state.status = "ready";
    await save();
    return { proposal: draftProposal(p, state) };
  }
  if (!work.context) {
    const ch = p.chapters.find((c) => c.id === state.chapterId);
    const original =
      state.reviewContext ||
      contextFor(p, ch, state.request.instruction, p.memory?.entries || [], {
        continuity: false,
        profile,
      }).context;
    work.context = {
      ...original,
      instruction: `${state.request.instruction}\n作者后续指导（后项仅调整同一事项，其他事实保持）：\n${(state.authorDirections || []).map((d) => JSON.stringify(d)).join("\n")}`,
    };
    await save();
  }
  const context = work.context;
  if (work.type === "regenerate" && work.status === "pending")
    await regenerate({ state, context, ask, save, profile });
  const scenes = draftScenes(state),
    doc = reviewDocument(scenes, context);
  if (work.type === "revise" && work.status === "pending") {
    const scope = scopedRows(scenes, work.scope).map((r) =>
      evidenceAt(doc, { sourceId: r.sourceId, paragraph: r.paragraph }),
    );
    const raw = work.selectedIssues.length
      ? work.selectedIssues
      : [...new Set(scope.map((r) => r.sourceId))].map((sourceId) => {
          const rows = scope.filter((r) => r.sourceId === sourceId);
          return {
            kind: "suggestion",
            target: rows[0],
            evidence: rows,
            explanation: work.instruction,
            fix: work.instruction,
          };
        });
    const issues = trackFindings(
      state,
      raw.map((i, index) => ({
        ...i,
        id: `author-${index + 1}`,
        blocking: true,
        resolution: "author_direction",
        preserve: [],
        authorRequested: true,
        authorInstruction:
          work.instruction ||
          "修订所选问题，选择更符合文章的版本并统一关联位置。",
        ...(work.scope.kind !== "chapter" ? { authorScope: scope } : {}),
      })),
      doc.version,
    );
    state.paragraphReview = {
      root: digest(scenes),
      inputScenes: structuredClone(scenes),
      round: 0,
      commits: [],
      cycle: {
        documentVersion: doc.version,
        attempt: 0,
        review: { issues, priorFindings: [], authorChecks: [] },
        problems: issues,
      },
    };
  }
  work.status = "reviewing";
  reviewWorkflow(state).phase = "review";
  await save();
  const result = await reviewAndPatch({
    scenes,
    context,
    ask,
    state,
    save,
    signal,
    profile,
    ...(work.scope.kind !== "chapter"
      ? {
          authorScope: scopedRows(scenes, work.scope).map((r) => ({
            sourceId: r.sourceId,
            paragraph: r.paragraph,
          })),
          reviewOnly: work.type === "regenerate",
        }
      : {}),
    minWords: state.wordTarget?.min || 0,
    maxWords: state.wordTarget?.max || Infinity,
  });
  setDraftScenes(state, result.scenes);
  recordDraftVersion(state, "作者指导后的可采纳草稿");
  work.status = "done";
  state.status = "ready";
  state.stage = "章节候选已完成";
  await save();
  return { proposal: draftProposal(p, state, true) };
}
