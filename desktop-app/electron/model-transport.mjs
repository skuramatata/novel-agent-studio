import { access, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// E2E 模型替身的唯一入口。
//
// 红线：只在**非打包**环境生效。生产包完全忽略该环境变量，
// 不因环境变量获得任意网络层注入能力。加载失败必须抛错，
// 绝不静默回落 globalThis.fetch —— 那会真的打到供应商。
export const E2E_MODEL_STUB_ENV = "NOVEL_E2E_MODEL_STUB";

async function assertReadableFile(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`模型替身文件不存在或不可读：${path}`);
  }
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`模型替身路径不是文件：${path}`);
}

// isPackaged 由调用方注入（生产传 app.isPackaged），便于测试两种环境。
export async function loadE2eModelStub({
  isPackaged = true,
  env = process.env,
  importer = (href) => import(href),
} = {}) {
  if (isPackaged) return null;
  const path = env?.[E2E_MODEL_STUB_ENV];
  if (!path) return null;
  await assertReadableFile(path);
  let mod;
  try {
    mod = await importer(pathToFileURL(path).href);
  } catch (error) {
    throw new Error(`模型替身加载失败：${path}（${error?.message ?? error}）`);
  }
  const stub = mod?.default ?? mod?.fetchStub;
  if (typeof stub !== "function")
    throw new Error(`模型替身文件必须默认导出函数：${path}`);
  return stub;
}

// 传输解析：注入优先，其次环境变量替身，最后才用全局 fetch。
// 注入只存在于主进程内部，IPC 参数永不携带函数。
export async function resolveModelTransport({
  injectedFetch,
  isPackaged = true,
  env = process.env,
  importer,
} = {}) {
  if (typeof injectedFetch === "function") return { fetch: injectedFetch, source: "injected" };
  const stub = await loadE2eModelStub({ isPackaged, env, importer });
  if (typeof stub === "function") return { fetch: stub, source: "env-stub" };
  return { fetch: globalThis.fetch, source: "global" };
}
