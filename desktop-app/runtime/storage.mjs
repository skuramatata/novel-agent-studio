import { mkdir, readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { projectSchema } from "./schema.mjs";
import { blankProject } from "./seed.mjs";
export class ProjectStore {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, "project.json");
    this.project = null;
  }
  async load() {
    if (this.project) return structuredClone(this.project);
    await mkdir(this.directory, { recursive: true });
    try {
      this.project = projectSchema.parse(
        JSON.parse(await readFile(this.file, "utf8")),
      );
    } catch (e) {
      if (e.code === "ENOENT") this.project = blankProject();
      else
        throw new Error(
          "作品文件损坏或版本不兼容。原文件已保留，请从备份恢复。",
        );
    }
    return structuredClone(this.project);
  }
  async save(project, expectedRevision) {
    if (!this.project) await this.load();
    if (this.project.revision !== expectedRevision)
      throw new Error("作品版本冲突，请重新载入后操作。");
    const next = projectSchema.parse({
      ...project,
      revision: expectedRevision + 1,
    });
    await mkdir(this.directory, { recursive: true });
    if (
      this.project.chapters.some(
        (old) =>
          old.content &&
          next.chapters.find((c) => c.id === old.id)?.content !== old.content,
      )
    ) {
      const versions = join(this.directory, "versions");
      await mkdir(versions, { recursive: true });
      const version = join(versions, `revision-${this.project.revision}.json`);
      try {
        await writeFile(version, JSON.stringify(this.project, null, 2), {
          mode: 0o600,
          flag: "wx",
        });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
    const temp = this.file + ".tmp";
    await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    try {
      await copyFile(this.file, this.file + ".bak");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    await rename(temp, this.file);
    this.project = next;
    return structuredClone(next);
  }
}
