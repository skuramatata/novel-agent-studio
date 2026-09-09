import { access, readFile, readdir, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
async function bytes(path) {
  const info = await lstat(path).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let sum = 0;
  for (const name of await readdir(path)) sum += await bytes(join(path, name));
  return sum;
}

// 只裁剪 Electron Packager 的暂存副本，开发依赖与已安装模型保持完整。
export async function prunePackage(buildPath, platform, arch) {
  if (resolve(buildPath) === resolve(projectRoot))
    throw Error("禁止裁剪开发工作区。");
  const pkg = JSON.parse(
    await readFile(join(buildPath, "package.json"), "utf8"),
  );
  if (pkg.name !== "novel-agent-studio") throw Error("打包暂存目录不匹配。");
  const modules = join(buildPath, "node_modules");
  const transformer = join(modules, "@huggingface/transformers");
  const meta = JSON.parse(
    await readFile(join(transformer, "package.json"), "utf8"),
  );
  if (meta.version !== "3.8.1")
    throw Error("Transformers 版本变更，需重新验证打包裁剪规则。");
  const binaryRoot = join(modules, "onnxruntime-node/bin/napi-v3");
  await access(join(binaryRoot, platform, arch, "onnxruntime_binding.node"));
  const nodeEntry = await readFile(
    join(transformer, "dist/transformers.node.mjs"),
    "utf8",
  );
  if (!nodeEntry.includes("onnxruntime-web (ignored)"))
    throw Error(
      "当前 Transformers Node 入口未排除浏览器后端，不能移除 Web 依赖。",
    );
  const removed = [];
  const remove = async (relative) => {
    const path = join(modules, relative),
      size = await bytes(path);
    if (!size) return;
    await rm(path, { recursive: true, force: true });
    removed.push({ path: relative, bytes: size });
  };
  for (const os of await readdir(binaryRoot)) {
    if (os !== platform) await remove(`onnxruntime-node/bin/napi-v3/${os}`);
    else
      for (const cpu of await readdir(join(binaryRoot, os)))
        if (cpu !== arch)
          await remove(`onnxruntime-node/bin/napi-v3/${os}/${cpu}`);
  }
  for (const path of [
    "onnxruntime-web",
    ".vite",
    ".cache",
    "@types",
    "@huggingface/transformers/src",
    "@huggingface/transformers/types",
  ])
    await remove(path);
  for (const file of await readdir(join(transformer, "dist")))
    if (!["transformers.node.mjs", "transformers.node.cjs"].includes(file))
      await remove(`@huggingface/transformers/dist/${file}`);
  // Sourcemap 是开发调试产物；保留 JS、原生库、数据和许可证。
  const maps = async (path, relative = "") => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) await maps(join(path, entry.name), child);
      else if (entry.isFile() && entry.name.endsWith(".map"))
        await remove(child);
    }
  };
  await maps(modules);
  return {
    platform,
    arch,
    removedBytes: removed.reduce((n, x) => n + x.bytes, 0),
    removed,
  };
}
