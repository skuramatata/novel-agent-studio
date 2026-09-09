import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { ProjectStore } from "./storage.mjs";
import { blankProject } from "./seed.mjs";
import { projectSchema } from "./schema.mjs";

// 身份由作品库分配，不接受作品内容或模型输出改变所属作品。
export class ProjectLibrary {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, "library.json");
    this.index = null;
    this.stores = new Map();
  }
  async writeIndex(next) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.file + ".tmp", JSON.stringify(next, null, 2), {
      mode: 0o600,
    });
    await rename(this.file + ".tmp", this.file);
    this.index = next;
  }
  async init() {
    if (this.index) return;
    let raw;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (raw !== undefined) {
      try {
        const index = JSON.parse(raw);
        if (
          index.version !== 1 ||
          !Array.isArray(index.entries) ||
          index.entries.some(
            (e) =>
              !/^[a-zA-Z0-9-]+$/.test(e.id) || typeof e.archived !== "boolean",
          ) ||
          new Set(index.entries.map((e) => e.id)).size !==
            index.entries.length ||
          !index.entries.some((e) => e.id === index.activeId && !e.archived)
        )
          throw Error();
        this.index = index;
      } catch {
        throw Error("作品库索引损坏，原文件已保留。");
      }
      return;
    }
    // 迁移先落作品，再提交索引；旧目录（含历史版本和运行记录）完整保留。
    const old = await new ProjectStore(this.directory).load();
    const id = crypto.randomUUID();
    await this.writeNew(id, old);
    await this.writeIndex({
      version: 1,
      activeId: id,
      entries: [{ id, archived: false }],
    });
  }
  directoryFor(id) {
    if (!this.index?.entries.some((e) => e.id === id))
      throw Error("作品不存在");
    return join(this.directory, "projects", id);
  }
  async storeFor(id) {
    await this.init();
    const directory = this.directoryFor(id);
    if (!this.stores.has(id)) {
      // 已登记作品缺失时不能静默创建空作品。
      await readFile(join(directory, "project.json"), "utf8");
      this.stores.set(id, new ProjectStore(directory));
    }
    return this.stores.get(id);
  }
  async writeNew(id, p) {
    const directory = join(this.directory, "projects", id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "project.json"),
      JSON.stringify(projectSchema.parse(p), null, 2),
      { mode: 0o600, flag: "wx" },
    );
  }
  async load(id) {
    await this.init();
    id ??= this.index.activeId;
    return { ...(await (await this.storeFor(id)).load()), projectId: id };
  }
  async list() {
    await this.init();
    return Promise.all(
      this.index.entries.map(async (e) => {
        const p = await this.load(e.id);
        return {
          ...e,
          title: p.premise.title,
          genre: p.premise.genre,
          chapters: p.chapters.filter((c) => c.content.trim()).length,
          revision: p.revision,
        };
      }),
    );
  }
  async select(id) {
    await this.init();
    if (!this.index.entries.some((e) => e.id === id && !e.archived))
      throw Error("作品不存在或已归档");
    const p = await this.load(id);
    await this.writeIndex({ ...this.index, activeId: id });
    return p;
  }
  async create(title) {
    await this.init();
    title = validTitle(title);
    const p = blankProject();
    p.premise.title = title;
    const id = crypto.randomUUID();
    await this.writeNew(id, p);
    await this.writeIndex({
      ...this.index,
      activeId: id,
      entries: [...this.index.entries, { id, archived: false }],
    });
    return this.load(id);
  }
  async save(p, revision) {
    await this.init();
    if (!this.index.entries.some((e) => e.id === p.projectId && !e.archived))
      throw Error("作品不存在或已归档");
    return {
      ...(await (await this.storeFor(p.projectId)).save(p, revision)),
      projectId: p.projectId,
    };
  }
  async rename(id, title) {
    const p = await this.load(id);
    p.premise.title = validTitle(title);
    return this.save(p, p.revision);
  }
  async archive(id, archived) {
    await this.init();
    if (
      typeof archived !== "boolean" ||
      !this.index.entries.some((e) => e.id === id)
    )
      throw Error("无效作品");
    const entries = this.index.entries.map((e) =>
      e.id === id ? { ...e, archived } : e,
    );
    const available = entries.filter((e) => !e.archived);
    if (!available.length) throw Error("至少保留一部未归档作品");
    const activeId = available.some((e) => e.id === this.index.activeId)
      ? this.index.activeId
      : available[0].id;
    await this.writeIndex({ ...this.index, activeId, entries });
    return this.load();
  }
}
export function validTitle(title) {
  if (typeof title !== "string" || !title.trim() || title.trim().length > 200)
    throw Error("作品名称需为 1–200 个字符");
  return title.trim();
}
