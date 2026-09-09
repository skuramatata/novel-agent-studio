import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("连续构建递增版本，同步锁文件并生成独立构建指纹", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-build-version-"));
  try {
    for (const dir of ["scripts", "src", "runtime", "electron", "models"])
      await mkdir(join(root, dir));
    await copyFile(
      new URL("../scripts/stamp-version.mjs", import.meta.url),
      join(root, "scripts/stamp-version.mjs"),
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ version: "0.1.8" }),
    );
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        version: "0.1.8",
        packages: { "": { version: "0.1.8" } },
      }),
    );
    for (const name of ["vite.config.ts", "tsconfig.json", "index.html"])
      await writeFile(join(root, name), "");
    await writeFile(join(root, "models/manifest.json"), "{}");
    const read = async (name) =>
      JSON.parse(await readFile(join(root, name), "utf8"));
    execFileSync(process.execPath, [join(root, "scripts/stamp-version.mjs")]);
    const first = await read("build-info.json");
    assert.equal(first.version, "0.1.9");
    assert.match(
      first.displayVersion,
      /^0\.1\.9\+\d{8}\.\d{6}\.\d{3}\.[a-f0-9]{12}$/,
    );
    assert.match(first.builtAtLabel, /北京时间$/);
    execFileSync(process.execPath, [join(root, "scripts/stamp-version.mjs")]);
    const second = await read("build-info.json");
    assert.equal(second.version, "0.1.10");
    assert.notEqual(first.displayVersion, second.displayVersion);
    assert.notEqual(first.sourceHash, second.sourceHash);
    assert.equal((await read("package.json")).version, second.version);
    const lock = await read("package-lock.json");
    assert.equal(lock.version, second.version);
    assert.equal(lock.packages[""].version, second.version);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
