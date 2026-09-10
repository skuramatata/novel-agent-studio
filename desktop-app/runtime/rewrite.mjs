import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { projectSchema } from "./schema.mjs";

const snapshotSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1),
  createdAt: z.string().datetime(),
  reason: z.enum(["rewrite", "restore"]),
  project: projectSchema,
});
export class RewriteBackups {
  constructor(directory, projectId) {
    this.directory = join(directory, "rewrite-backups");
    this.projectId = projectId;
  }
  async create(project, reason) {
    const snapshot = snapshotSchema.parse({
      id: crypto.randomUUID(),
      projectId: this.projectId,
      createdAt: new Date().toISOString(),
      reason,
      project,
    });
    await mkdir(this.directory, { recursive: true });
    const file = join(this.directory, snapshot.id + ".json");
    await writeFile(file + ".tmp", JSON.stringify(snapshot, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(file + ".tmp", file);
    return snapshot;
  }
  async read(id) {
    if (!z.string().uuid().safeParse(id).success)
      throw Error("无效的重写备份。");
    const snapshot = snapshotSchema.parse(
      JSON.parse(await readFile(join(this.directory, id + ".json"), "utf8")),
    );
    if (snapshot.projectId !== this.projectId || snapshot.id !== id)
      throw Error("备份不属于当前作品。");
    return snapshot;
  }
  async list() {
    let files;
    try {
      files = await readdir(this.directory);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const snapshots = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map((f) => this.read(f.slice(0, -5))),
    );
    return snapshots
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ project, ...s }) => ({
        ...s,
        title: project.premise.title,
        revision: project.revision,
        chapters: project.chapters.filter((c) => c.content.trim()).length,
      }));
  }
}
