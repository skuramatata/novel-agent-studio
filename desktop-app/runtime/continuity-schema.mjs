import { z } from "zod";

// 可选字段兼容旧作品；未知必须保持未知，不能把公文或传闻提升为事实。
export const continuityRecordSchema = z.object({
  assertion: z.enum([
    "narration",
    "testimony",
    "document",
    "inference",
    "unknown",
  ]),
  actor: z.string().max(100),
  action: z.string().max(200),
  object: z.string().max(100),
  before: z.string().max(200),
  after: z.string().max(200),
  evidenceForm: z.enum([
    "original",
    "transcript",
    "facsimile",
    "oral",
    "unknown",
  ]),
  time: z
    .object({
      calendar: z.enum(["gregorian", "lunar", "relative", "unknown"]),
      year: z.number().int().min(1).max(9999).nullable(),
      month: z.number().int().min(1).max(12).nullable(),
      day: z.number().int().min(1).max(31).nullable(),
      anchor: z.string().max(100),
      since: z.string().max(100),
      elapsedDays: z.number().int().min(0).max(1000000).nullable(),
    })
    .nullable(),
});

export const sceneTimeSchema = z.object({
  start: z.string().min(1).max(160),
  gap: z.string().min(1).max(160),
  duration: z.string().min(1).max(160),
  end: z.string().min(1).max(160),
});

export const CONTINUITY_MEMORY_RULES = `每条记录另提供continuity，保留行动主体与状态转移，不能只记最终位置。结构：{"assertion":"narration","actor":"行动者或说话者，不明填空串","action":"实际动作，不明填空串","object":"对象，不明填空串","before":"动作前状态或位置","after":"动作后状态或位置","evidenceForm":"unknown","time":null}。assertion只能是narration（正文直接叙述，不保证叙述者可靠）、testimony（人物证词）、document（文件所载）、inference（推断）、unknown。evidenceForm只能是original（原件）、transcript（誊抄件）、facsimile（保留原样的影像或摹本）、oral（口述）、unknown。文件写着某人到任，不等于此人真实到任。出现明确时间时time填{"calendar":"unknown","year":null,"month":3,"day":12,"anchor":"成诚到岛","since":"","elapsedDays":null}，否则time=null。calendar仅gregorian/lunar/relative/unknown；没有依据不能默认公历。year只填明确的公元年，民国等纪年不直接当公元数值；无法明确换算则year=null。anchor是这条事件的稳定名称；since仅在原文明说距某事件经过多少天时填该事件名称；elapsedDays只记录明确天数，不把月或年换算成固定天数，不从其他片段补年份或日期。不合并证词、档案与亲历的同名事件；涉及物件的搬放、交出、取回、销毁，以及第一次日期、时间间隔、周期，优先保留其完整原文依据。`;
