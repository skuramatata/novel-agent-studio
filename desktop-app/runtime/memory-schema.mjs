import { z } from "zod";
import { continuityRecordSchema } from "./continuity-schema.mjs";
export const MEMORY_RECORD_LIMIT = 16;
export const MEMORY_SUMMARY_LIMIT = 800;
export const memoryRecordSchema = z.object({
  kind: z.enum(["event", "state", "knowledge", "thread", "foreshadow"]),
  text: z.string().min(1).max(600),
  entities: z.array(z.string().max(80)).max(12),
  storyTime: z.string().max(160),
  knownBy: z.array(z.string().max(80)).max(12),
  epistemic: z.enum(["observed", "belief", "rumor", "unknown"]),
  quote: z.string().min(1).max(1200),
  continuity: continuityRecordSchema.optional(),
});
export const extractedMemorySchema = z.object({
  summary: z.string().min(1).max(MEMORY_SUMMARY_LIMIT),
  records: z.array(memoryRecordSchema).max(MEMORY_RECORD_LIMIT),
});
export const memoryEntrySchema = extractedMemorySchema.extend({
  dependencyScope: z.literal("chapter").optional(),
  continuityVersion: z.literal(1).optional(),
  chapterId: z.string(),
  sourceHash: z.string(),
  part: z.number().int().nonnegative(),
  sourceStart: z.number().int().nonnegative(),
  sourceEnd: z.number().int().positive(),
  sourceText: z.string().max(5000),
});
export const memorySchema = z.object({
  version: z.literal(1),
  entries: z.array(memoryEntrySchema).max(10000),
});
