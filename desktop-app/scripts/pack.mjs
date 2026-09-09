import { packager } from "@electron/packager";
import { readFile, readdir, access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { prunePackage } from "./prune-package.mjs";
const embedding = JSON.parse(await readFile("models/manifest.json", "utf8"));
for (const [file, expected] of Object.entries(embedding.files)) {
  const actual = createHash("sha256")
    .update(await readFile(join("models", file)))
    .digest("hex");
  if (actual !== expected)
    throw Error(
      `本地模型文件不完整：${file}。请执行 npm run prepare:embedding。`,
    );
}
const buildInfo = JSON.parse(await readFile("build-info.json", "utf8"));
const { version } = JSON.parse(
  await readFile("node_modules/electron/package.json", "utf8"),
);
const cache = join(homedir(), "Library/Caches/electron");
let electronZipDir;
try {
  for (const entry of await readdir(cache)) {
    try {
      await access(join(cache, entry, `electron-v${version}-darwin-arm64.zip`));
      electronZipDir = join(cache, entry);
      break;
    } catch {}
  }
} catch {}
const outputs = await packager({
  dir: process.cwd(),
  name: "NovelAgentStudio",
  out: "release",
  platform: "darwin",
  arch: "arm64",
  electronVersion: version,
  ...(electronZipDir ? { electronZipDir } : {}),
  overwrite: true,
  appBundleId: "local.novel-agent.studio",
  appVersion: buildInfo.version,
  buildVersion: buildInfo.version,
  asar: { unpack: "**/*.{node,dylib}" },
  extraResource: ["models"],
  afterPrune: [
    async ({ buildPath, platform, arch }) => {
      const report = await prunePackage(buildPath, platform, arch);
      await mkdir("verification/package-size", { recursive: true });
      await writeFile(
        "verification/package-size/pruning.json",
        JSON.stringify(report, null, 2) + "\n",
      );
      console.log(
        `已从打包副本移除 ${(report.removedBytes / 1e6).toFixed(1)} MB 多余依赖`,
      );
    },
  ],
  ignore: [
    /^\/release($|\/)/,
    /^\/src($|\/)/,
    /^\/tests($|\/)/,
    /^\/scripts($|\/)/,
    /^\/verification($|\/)/,
    /^\/models($|\/)/,
    /^\/\.env/,
    /tsconfig/,
    /vite.config/,
  ],
  quiet: true,
});
console.log(outputs.join("\n"));
