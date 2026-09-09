import {
  submitReviewDecision,
  isReviewDecisionReplay,
} from "./review-resolution.mjs";
import {
  reviewTaskState,
  retryReview,
  restoreRepeatedAuthorQuestions,
} from "./review-workflow.mjs";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "./memory.mjs";
import { blockedStructuredRecovery } from "./structured-step.mjs";
import { DEFAULT_WORD_TOLERANCE, projectWordTolerance } from "./word-range.mjs";
import { captureCheckpointLog, appendCreationEvent } from "./creation-log.mjs";
import {
  authorIntervenes,
  revisionBudget,
  draftScenes,
  draftVersion,
} from "./revision-session.mjs";
import { prepareDraftAction } from "./draft-actions.mjs";
export const WORKFLOW_VERSION = "chapter-memory-2";
export function baseFingerprint(p) {
  return digest({
    author: p.author,
    premise: p.premise,
    plan: p.plan,
    characters: p.characters,
    relations: p.relations,
    chapters: p.chapters,
  });
}
export class Checkpoint {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, "chapter-task.json");
  }
  async read() {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async write(value) {
    captureCheckpointLog(value);
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.file + ".tmp", JSON.stringify(value), { mode: 0o600 });
    await rename(this.file + ".tmp", this.file);
  }
  async begin(p, req, config) {
    let old = await this.read();
    const base = baseFingerprint(p);
    if (
      req.authorAction ||
      (req.resume &&
        req.authorInterventionId &&
        !req.decision &&
        old &&
        draftScenes(old).length)
    ) {
      if (!old || old.base !== base)
        throw Error(
          "作品内容已变化，旧草稿不能覆盖当前作品，请基于最新正文创建任务。",
        );
      if (old.version !== WORKFLOW_VERSION)
        throw Error("旧任务流程不兼容，请先恢复旧任务完成迁移。");
      if (
        old.provider !== config.provider ||
        old.model !== config.model ||
        old.baseUrl !== config.baseUrl
      )
        throw Error("继续草稿需要使用原来的供应商、接口与模型。");
      prepareDraftAction(
        old,
        req.authorAction ||
          old.authorActions?.find((a) => a.id === req.authorInterventionId)
            ?.action || {
            id: req.authorInterventionId,
            taskId: old.id,
            draftVersion: draftVersion(old),
            type: "continue",
          },
        req.instruction || "",
      );
      if (!old.authorReplay) await this.write(old);
      return old;
    }
    if (req.resume) {
      if (
        old &&
        old.base === base &&
        old.provider === config.provider &&
        old.model === config.model &&
        old.baseUrl === config.baseUrl &&
        isReviewDecisionReplay(old, req.decision)
      ) {
        // 仅本次返回携带标记，不写入任务文件。
        Object.defineProperty(old, "decisionReplay", { value: true });
        return old;
      }
      if (
        !old ||
        ![
          "failed",
          "retryable",
          "interrupted",
          "running",
          "ready",
          "awaiting_input",
          "awaiting_instruction",
        ].includes(old.status)
      )
        throw Error("没有可恢复的章节任务。");
      if (
        old.base !== base ||
        !["chapter-memory-1", WORKFLOW_VERSION].includes(old.version)
      )
        throw Error("作品或生成流程已经变化，旧任务已过期，请重新生成。");
      if (
        old.provider !== config.provider ||
        old.model !== config.model ||
        old.baseUrl !== config.baseUrl
      )
        throw Error("恢复任务需要使用原来的供应商、接口与模型。");
      if (old.version === "chapter-memory-1") {
        await mkdir(join(this.directory, "task-history"), { recursive: true });
        await writeFile(
          join(
            this.directory,
            "task-history",
            old.id + "-before-evidence-patch.json",
          ),
          JSON.stringify(old),
          { mode: 0o600 },
        );
        // 旧意见只作为逐项重审线索，不继承其阻断判断或执行修订建议。
        const latestReview = Object.entries(old.values)
          .filter(([key]) => key.startsWith("review:"))
          .at(-1)?.[1];
        old.priorReviewHints = (latestReview?.issues || []).flatMap(
          (issue, i) => {
            const text = old.values[`final-scene:${issue.scene - 1}`];
            if (!text || !issue.quote) return [];
            const rows = text.split(/\n\s*\n/);
            const matches = rows.flatMap((row, index) =>
              row === issue.quote ? [index + 1] : [],
            );
            if (matches.length !== 1) return [];
            return [
              {
                id: `legacy-${i + 1}`,
                sourceId: `scene:${issue.scene}`,
                paragraph: matches[0],
                quote: issue.quote,
                claim: issue.fix,
              },
            ];
          },
        );
        // 保留已写场景、原始尝试与记忆；旧审稿结论不适用新证据契约。
        old.values = Object.fromEntries(
          Object.entries(old.values).filter(
            ([key]) => !key.startsWith("review:"),
          ),
        );
        old.previousWorkflowVersion = old.version;
        old.version = WORKFLOW_VERSION;
      }
      const intervention =
        req.authorInterventionId ||
        (req.decision ? `decision:${digest(req.decision)}` : null);
      const author = intervention
        ? authorIntervenes(old, intervention, req.instruction)
        : false;
      const blocked = blockedStructuredRecovery(old);
      if (blocked) throw Error(blocked.detail);
      // 旧版可能在问答存盘后记为 failed；以未回答的问题为准恢复等待状态。
      if (!req.decision) restoreRepeatedAuthorQuestions(old);
      old.status = reviewTaskState(old).status;
      if (req.decision && !submitReviewDecision(old, req.decision)) {
        old.status = "awaiting_input";
        old.error = "";
        await this.write(old);
        return old;
      } else if (
        !req.decision &&
        old.status === "awaiting_input" &&
        reviewTaskState(old).review
      )
        throw Error("请先在创作对话回答当前情节问题，再继续任务。");
      captureCheckpointLog(old);
      if (old.reviewWorkflow) retryReview(old, author);
      if (author && old.paragraphReview)
        old.paragraphReview.reviewLimit = old.paragraphReview.round + 2;
      appendCreationEvent(old, {
        title: req.decision ? "作者回答已收齐，继续任务" : "恢复已有任务",
        details: { 恢复步骤: old.stage },
      });
      old.status = "running";
      old.error = "";
      // 旧任务沿用原默认值；配置调整只影响新任务，不改变已保存的审稿标准。
      old.wordTolerance ??= { ...DEFAULT_WORD_TOLERANCE };
      await this.write(old);
      return old;
    }
    // 历次任务保留，重新生成不删除旧草稿。
    if (old) {
      await mkdir(join(this.directory, "task-history"), { recursive: true });
      await writeFile(
        join(this.directory, "task-history", old.id + ".json"),
        JSON.stringify(old),
        { mode: 0o600 },
      );
    }
    const state = {
      id: crypto.randomUUID(),
      version: WORKFLOW_VERSION,
      continuityVersion: 1,
      retrievalVersion: 1,
      memoryContextVersion: 2,
      base,
      wordTolerance: projectWordTolerance(p),
      request: {
        instruction: req.instruction,
        chapterId: req.chapterId,
        mode: req.mode,
        words: req.words,
      },
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      status: "running",
      stage: "准备",
      values: {},
      fragments: {},
      calls: 0,
      usages: [],
      manifest: [],
      updatedAt: new Date().toISOString(),
    };
    revisionBudget(state);
    await this.write(state);
    return state;
  }
}
