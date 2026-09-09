import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = async (name) =>
  JSON.parse(await readFile(join(root, name), "utf8"));
const saveJson = (name, value) =>
  writeFile(join(root, name), JSON.stringify(value, null, 2) + "\n");
const pkg = await readJson("package.json");
const lock = await readJson("package-lock.json");
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!match) throw Error("应用基础版本必须为 major.minor.patch");
pkg.version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
lock.version = pkg.version;
lock.packages[""].version = pkg.version;
await saveJson("package.json", pkg);
await saveJson("package-lock.json", lock);

const files = [
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "tsconfig.json",
  "index.html",
  "models/manifest.json",
];
async function collect(directory) {
  for (const entry of await readdir(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) files.push(path);
  }
}
for (const dir of ["src", "runtime", "electron", "scripts"]) await collect(dir);
const hash = createHash("sha256");
for (const file of files.sort()) {
  hash.update(relative(root, join(root, file)) + "\0");
  hash.update(await readFile(join(root, file)));
  hash.update("\0");
}
const sourceHash = hash.digest("hex").slice(0, 12);
const now = new Date();
const parts = Object.fromEntries(
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .map(({ type, value }) => [type, value]),
);
const stamp = `${parts.year}${parts.month}${parts.day}.${parts.hour}${parts.minute}${parts.second}.${String(now.getMilliseconds()).padStart(3, "0")}`;
const info = {
  version: pkg.version,
  displayVersion: `${pkg.version}+${stamp}.${sourceHash}`,
  builtAt: now.toISOString(),
  builtAtLabel: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} 北京时间`,
  sourceHash,
};
await saveJson("build-info.json", info);
console.log(`构建版本：${info.displayVersion}`);
