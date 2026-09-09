import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { estimatedTokens } from "./model-budget.mjs";

export const EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_REVISION = "2c4055b12046f11709e9df2c122e59ffbdc2f900";
export const EMBEDDING_ID = `${EMBEDDING_MODEL}@${EMBEDDING_REVISION}:q8:mean:normalized:chunks160-v1`;
const hash = (text) => createHash("sha256").update(text).digest("hex");
export const lexicalTerms = (text) => [
  ...new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).flatMap((t) => [
      t,
      ...[...t].slice(1).map((_, i) => t.slice(i, i + 2)),
    ]),
  ),
];
export function sourceChunks(chapter) {
  const chunks = [];
  const sourceHash = hash(chapter.content);
  // 字符边界切片仅用于索引；原始偏移和完整段落均保留，检索回填不靠模型抄写。
  for (const match of chapter.content.matchAll(
    /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g,
  )) {
    const paragraph = chapter.content
      .slice(0, match.index)
      .split(/\n\s*\n/).length;
    let start = match.index;
    for (const text of match[0].match(/.{1,160}/gsu) || []) {
      if (text.trim())
        chunks.push({
          id: hash(`${chapter.id}:${sourceHash}:${start}`),
          chapterId: chapter.id,
          number: chapter.number,
          sourceHash,
          paragraph,
          start,
          end: start + text.length,
          text,
        });
      start += text.length;
    }
  }
  return chunks;
}
export function localEmbedder(modelRoot) {
  let loading;
  return async (texts, signal) => {
    signal?.throwIfAborted();
    if (!loading)
      loading = (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.localModelPath = modelRoot + "/";
        return pipeline("feature-extraction", EMBEDDING_MODEL, {
          dtype: "q8",
          device: "cpu",
        });
      })().catch((error) => {
        loading = undefined;
        throw error;
      });
    const extractor = await loading;
    const result = [];
    for (let i = 0; i < texts.length; i += 8) {
      signal?.throwIfAborted();
      const batch = texts.slice(i, i + 8);
      for (const text of batch) {
        const encoded = extractor.tokenizer(text, { truncation: false });
        if (encoded.input_ids.dims.at(-1) > 512)
          throw Error("索引片段超过本地Embedding模型输入上限，未截断原文。");
      }
      const out = await extractor(batch, {
        pooling: "mean",
        normalize: true,
        truncation: false,
      });
      result.push(...out.tolist());
    }
    signal?.throwIfAborted();
    return result;
  };
}
export class StoryVectorIndex {
  constructor(directory, embed, embeddingId = EMBEDDING_ID) {
    this.directory = directory;
    this.embed = embed;
    this.embeddingId = embeddingId;
  }
  async open() {
    if (this.db) return;
    await mkdir(this.directory, { recursive: true });
    this.db = new DatabaseSync(join(this.directory, "retrieval.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS chunks (id TEXT NOT NULL, projectId TEXT NOT NULL, chapterId TEXT NOT NULL, number INTEGER NOT NULL, sourceHash TEXT NOT NULL, paragraph INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL, embeddingId TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(projectId,id)); CREATE INDEX IF NOT EXISTS scope ON chunks(projectId,number,sourceHash,embeddingId)",
    );
  }
  close() {
    this.db?.close();
    this.db = null;
  }
  async sync(project, { signal, progress = () => {} } = {}) {
    if (!project.projectId) throw Error("向量索引缺少作品身份。");
    await this.open();
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const chapter of project.chapters.filter((c) => c.content.trim())) {
      signal?.throwIfAborted();
      const chunks = sourceChunks(chapter);
      const stored = this.db
        .prepare(
          "SELECT id FROM chunks WHERE projectId=? AND chapterId=? AND sourceHash=? AND embeddingId=?",
        )
        .all(
          project.projectId,
          chapter.id,
          hash(chapter.content),
          this.embeddingId,
        );
      if (
        stored.length === chunks.length &&
        chunks.every((c) => stored.some((s) => s.id === c.id))
      ) {
        // 章节重排不会改变正文哈希，仍需同步序号，避免沿用旧的前后章范围。
        this.db
          .prepare(
            "UPDATE chunks SET number=? WHERE projectId=? AND chapterId=? AND number<>?",
          )
          .run(chapter.number, project.projectId, chapter.id, chapter.number);
        continue;
      }
      progress(
        `建立第 ${chapter.number} 章本地检索索引（${chunks.length} 个片段）`,
      );
      const vectors = await this.embed(
        chunks.map((c) => c.text),
        signal,
      );
      if (
        vectors.length !== chunks.length ||
        vectors.some((v) => !v.length || v.some((n) => !Number.isFinite(n)))
      )
        throw Error("Embedding结果缺失或无效，旧索引保留。");
      const dimensions = vectors[0]?.length;
      if (vectors.some((v) => v.length !== dimensions))
        throw Error("Embedding维度不一致。");
      signal?.throwIfAborted();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare("DELETE FROM chunks WHERE projectId=? AND chapterId=?")
          .run(project.projectId, chapter.id);
        chunks.forEach((c, i) =>
          insert.run(
            c.id,
            project.projectId,
            c.chapterId,
            c.number,
            c.sourceHash,
            c.paragraph,
            c.start,
            c.end,
            c.text,
            this.embeddingId,
            Buffer.from(new Float32Array(vectors[i]).buffer),
          ),
        );
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    // 未采纳候选不在 project.chapters 中；旧正文立即由哈希过滤，清理仅影响派生索引。
    const live = new Map(
      project.chapters
        .filter((c) => c.content.trim())
        .map((c) => [c.id, hash(c.content)]),
    );
    for (const r of this.db
      .prepare(
        "SELECT id,chapterId,sourceHash,embeddingId FROM chunks WHERE projectId=?",
      )
      .all(project.projectId))
      if (
        live.get(r.chapterId) !== r.sourceHash ||
        r.embeddingId !== this.embeddingId
      )
        this.db
          .prepare("DELETE FROM chunks WHERE projectId=? AND id=?")
          .run(project.projectId, r.id);
    return this.stats(project.projectId);
  }
  stats(projectId) {
    return {
      engine: "SQLite + 本地向量/关键词混合检索",
      embeddingId: this.embeddingId,
      chunks: this.db
        .prepare(
          "SELECT count(*) AS n FROM chunks WHERE projectId=? AND embeddingId=?",
        )
        .get(projectId, this.embeddingId).n,
    };
  }
  async search(
    project,
    targetNumber,
    query,
    { signal, maxTokens = 6000, profile, limit = 24 } = {},
  ) {
    await this.open();
    const current = new Map(
      project.chapters
        .filter((c) => c.number < targetNumber && c.content)
        .map((c) => [c.id, c]),
    );
    const rows = this.db
      .prepare(
        "SELECT * FROM chunks WHERE projectId=? AND number<? AND embeddingId=?",
      )
      .all(project.projectId, targetNumber, this.embeddingId)
      .filter((r) => {
        const c = current.get(r.chapterId);
        return (
          c &&
          r.sourceHash === hash(c.content) &&
          c.content.slice(r.start, r.end) === r.text
        );
      });
    if (!rows.length)
      return {
        sources: [],
        coverage: { candidates: 0, selected: 0, tokens: 0 },
      };
    const queryVectors = await this.embed(
      query.match(/.{1,160}/gsu) || ["故事"],
      signal,
    );
    let vector = queryVectors[0].map(
      (_, i) =>
        queryVectors.reduce((n, v) => n + v[i], 0) / queryVectors.length,
    );
    const norm = Math.hypot(...vector);
    if (norm) vector = vector.map((v) => v / norm);
    const terms = lexicalTerms(query),
      frequencies = new Map(
        terms.map((t) => [t, rows.filter((r) => r.text.includes(t)).length]),
      );
    for (const row of rows) {
      const buf = Buffer.from(row.vector),
        values = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      if (values.length !== vector.length)
        throw Error("检索向量模型或维度变化，需重建派生索引。");
      row.semantic = vector.reduce((n, v, i) => n + v * values[i], 0);
      row.lexical = terms
        .filter((t) => row.text.includes(t))
        .reduce(
          (n, t) => n + Math.log(1 + rows.length / (frequencies.get(t) || 1)),
          0,
        );
      row.score = 0;
    }
    for (const field of ["semantic", "lexical"])
      [...rows]
        .sort((a, b) => b[field] - a[field] || a.id.localeCompare(b.id))
        .forEach((r, i) => {
          if (r[field] > 0) r.score += 1 / (60 + i);
        });
    const sources = [],
      seen = new Set();
    for (const row of rows.sort(
      (a, b) => b.score - a.score || a.number - b.number || a.start - b.start,
    )) {
      if (!row.score || sources.length >= limit) break;
      // 回取命中的完整段落；多个向量片段命中同段只放一次。
      const chapter = current.get(row.chapterId),
        paragraphs = chapter.content.split(/\n\s*\n/),
        text = paragraphs[row.paragraph - 1];
      const key = `${row.chapterId}:${row.paragraph}`;
      if (seen.has(key) || !text) continue;
      seen.add(key);
      const source = {
        sourceId: `retrieved:${key}`,
        chapterId: row.chapterId,
        number: row.number,
        paragraph: row.paragraph,
        sourceHash: row.sourceHash,
        text,
        label: `第${row.number}章原文第${row.paragraph}段（本地混合检索）`,
      };
      if (
        estimatedTokens(
          [{ role: "user", content: JSON.stringify([...sources, source]) }],
          profile,
        ) > maxTokens
      )
        continue;
      sources.push(source);
    }
    return {
      sources,
      coverage: {
        candidates: rows.length,
        selected: sources.length,
        tokens: estimatedTokens(
          [{ role: "user", content: JSON.stringify(sources) }],
          profile,
        ),
        embeddingId: this.embeddingId,
        policy:
          "仅已采纳的此前章节，逐字回取当前版本原文；未命中不代表不存在。",
      },
    };
  }
}
