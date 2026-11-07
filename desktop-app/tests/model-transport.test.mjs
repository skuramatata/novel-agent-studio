import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  E2E_MODEL_STUB_ENV,
  loadE2eModelStub,
  resolveModelTransport,
} from "../electron/model-transport.mjs";

const withStubFile = async (source) => {
  const dir = await mkdtemp(join(tmpdir(), "model-stub-"));
  const path = join(dir, "stub.mjs");
  await writeFile(path, source, "utf8");
  return { dir, path };
};

const stubSource = `
export const calls = [];
export default async function stubFetch(url) {
  calls.push(String(url));
  return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }),
    { status: 200, headers: { "content-type": "application/json" } });
}
`;

test("设置了替身变量且非打包：用替身，不碰 globalThis.fetch", async () => {
  const { dir, path } = await withStubFile(stubSource);
  const original = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = async () => {
    globalCalls += 1;
    throw new Error("不得走真实 fetch");
  };
  try {
    const resolved = await resolveModelTransport({
      isPackaged: false,
      env: { [E2E_MODEL_STUB_ENV]: path },
    });
    assert.equal(resolved.source, "env-stub");
    assert.equal(typeof resolved.fetch, "function");
    await resolved.fetch("https://example.invalid/x");
    assert.equal(globalCalls, 0, "替身生效时不得调用 globalThis.fetch");
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test("未设置替身变量：走 globalThis.fetch", async () => {
  const original = globalThis.fetch;
  const marker = async () => new Response("{}", { status: 200 });
  globalThis.fetch = marker;
  try {
    const resolved = await resolveModelTransport({
      isPackaged: false,
      env: {},
    });
    assert.equal(resolved.source, "global");
    assert.equal(resolved.fetch, marker, "未设置变量时必须用 globalThis.fetch");
  } finally {
    globalThis.fetch = original;
  }
});

test("替身文件不存在或未导出函数：抛明确错误，不回落真实 fetch", async () => {
  const original = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = async () => {
    globalCalls += 1;
    throw new Error("不得回落");
  };
  try {
    await assert.rejects(
      () =>
        resolveModelTransport({
          isPackaged: false,
          env: { [E2E_MODEL_STUB_ENV]: "/nonexistent/stub.mjs" },
        }),
      /模型替身文件不存在或不可读/,
    );
    const { dir, path } = await withStubFile("export const notAFunction = 1;\n");
    try {
      await assert.rejects(
        () =>
          resolveModelTransport({
            isPackaged: false,
            env: { [E2E_MODEL_STUB_ENV]: path },
          }),
        /必须默认导出函数/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    assert.equal(globalCalls, 0, "加载失败不得回落真实 fetch");
  } finally {
    globalThis.fetch = original;
  }
});

test("打包环境即使设置了变量也完全忽略", async () => {
  const { dir, path } = await withStubFile(stubSource);
  const original = globalThis.fetch;
  const marker = async () => new Response("{}", { status: 200 });
  globalThis.fetch = marker;
  try {
    const stub = await loadE2eModelStub({
      isPackaged: true,
      env: { [E2E_MODEL_STUB_ENV]: path },
    });
    assert.equal(stub, null, "打包环境必须忽略替身变量");
    const resolved = await resolveModelTransport({
      isPackaged: true,
      env: { [E2E_MODEL_STUB_ENV]: path },
    });
    assert.equal(resolved.source, "global");
    assert.equal(resolved.fetch, marker);
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});
