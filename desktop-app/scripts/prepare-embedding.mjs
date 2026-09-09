import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const manifest = JSON.parse(await readFile("models/manifest.json", "utf8"));
const digest = (data) => createHash("sha256").update(data).digest("hex");
for (const [file, expected] of Object.entries(manifest.files)) {
  const path = join("models", file);
  if (
    await readFile(path).then(
      (data) => digest(data) === expected,
      () => false,
    )
  )
    continue;
  await mkdir(dirname(path), { recursive: true });
  const relative = file.slice(manifest.model.length + 1);
  const url = `https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${relative}`;
  await run("curl", [
    "-fL",
    "--retry",
    "2",
    "--max-time",
    "300",
    "-sS",
    url,
    "-o",
    path + ".download",
  ]);
  if (digest(await readFile(path + ".download")) !== expected)
    throw Error(`模型文件校验失败：${file}`);
  await rename(path + ".download", path);
  console.log(`模型文件已校验：${file}`);
}
console.log(`本地模型就绪：${manifest.model}@${manifest.revision}`);
