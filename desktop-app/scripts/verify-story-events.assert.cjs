// 断言工具：强制每个 case 只能以 pass / fail 收尾，杜绝静默跳过。
// 任务书规定不得用"条件不满足就跳过"掩盖问题，本文件是脚本自身的守卫。
const RESULT_PASS = "pass";
const RESULT_FAIL = "fail";

const REQUIRED_FIELDS = ["caseId", "title", "rNumbers", "blockedBy"];

function createRunner({ plan = [] } = {}) {
  const results = new Map();

  // 预注册全部计划案例：任何未执行完的 case 都会以 fail 收尾。
  for (const item of plan) {
    for (const field of REQUIRED_FIELDS) {
      // blockedBy 允许显式写 null（表示当前无阻塞方），但字段本身必须声明，
      // 防止漏写导致"不知道为什么红"。
      if (!(field in item)) {
        throw new Error(`案例计划缺少字段 ${field}：${JSON.stringify(item)}`);
      }
      if (field !== "blockedBy" && (item[field] === undefined || item[field] === null)) {
        throw new Error(`案例计划字段 ${field} 不能为空：${JSON.stringify(item)}`);
      }
    }
    results.set(item.caseId, {
      caseId: item.caseId,
      title: item.title,
      rNumbers: item.rNumbers,
      blockedBy: item.blockedBy,
      status: "not-run",
      assertions: [],
      detail: null,
      evidence: null,
    });
  }

  const entryOf = (caseId) => {
    const entry = results.get(caseId);
    if (!entry) throw new Error(`未注册的案例：${caseId}`);
    return entry;
  };

  // 记录一条断言。ok 必须是真正的布尔值，禁止 undefined/真值糊弄。
  const check = (caseId, description, ok, evidence = null) => {
    if (typeof ok !== "boolean") {
      throw new Error(
        `案例 ${caseId} 的断言「${description}」结果不是布尔值（收到 ${typeof ok}），拒绝记录`,
      );
    }
    const entry = entryOf(caseId);
    entry.assertions.push({ description, ok, evidence });
    if (!ok) {
      if (entry.status !== RESULT_FAIL) entry.status = RESULT_FAIL;
      if (entry.detail === null) entry.detail = description;
    } else if (entry.status === "not-run") {
      entry.status = "in-progress";
    }
    return ok;
  };

  const fail = (caseId, reason) => {
    const entry = entryOf(caseId);
    entry.status = RESULT_FAIL;
    entry.detail = entry.detail ?? reason;
    entry.assertions.push({ description: reason, ok: false, evidence: null });
  };

  // 正常收尾：只有全部断言为真才算 pass；没有断言也判 fail（空跑不算通过）。
  const finish = (caseId, evidence = null) => {
    const entry = entryOf(caseId);
    if (entry.assertions.length === 0) {
      entry.status = RESULT_FAIL;
      entry.detail = "该案例未产生任何断言，空跑不算通过";
    } else if (entry.assertions.every((a) => a.ok)) {
      entry.status = RESULT_PASS;
      entry.detail = null;
    } else {
      entry.status = RESULT_FAIL;
    }
    entry.evidence = evidence;
    return entry;
  };

  const runCase = async (caseId, fn) => {
    const entry = entryOf(caseId);
    try {
      await fn();
    } catch (error) {
      entry.status = RESULT_FAIL;
      entry.detail = `案例执行抛错：${error && error.message ? error.message : String(error)}`;
      entry.assertions.push({
        description: `执行异常：${error && error.message ? error.message : String(error)}`,
        ok: false,
        evidence: null,
      });
    } finally {
      // 无论成功失败都走一次 finish，保证状态不是 not-run / in-progress。
      if (entry.status !== RESULT_PASS) {
        if (entry.assertions.length === 0 && entry.status !== RESULT_FAIL) {
          entry.status = RESULT_FAIL;
          entry.detail = "案例未产生断言即结束";
        }
        if (entry.status !== RESULT_FAIL) entry.status = RESULT_FAIL;
      }
    }
    return entry;
  };

  const list = () => [...results.values()].map((e) => ({ ...e, assertions: [...e.assertions] }));

  // 自检 A：任何既不是 pass 也不是 fail 的案例都要在此暴露。
  const auditUnresolved = () => {
    const unresolved = list().filter((e) => e.status !== RESULT_PASS && e.status !== RESULT_FAIL);
    return {
      ok: unresolved.length === 0,
      unresolved: unresolved.map((e) => ({ caseId: e.caseId, status: e.status, title: e.title })),
    };
  };

  const summary = () => {
    const all = list();
    return {
      total: all.length,
      pass: all.filter((e) => e.status === RESULT_PASS).length,
      fail: all.filter((e) => e.status === RESULT_FAIL).length,
      unresolved: all.filter((e) => e.status !== RESULT_PASS && e.status !== RESULT_FAIL).length,
    };
  };

  return { check, fail, finish, runCase, list, auditUnresolved, summary };
}

module.exports = { createRunner, RESULT_PASS, RESULT_FAIL, REQUIRED_FIELDS };
