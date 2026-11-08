// 断言工具：强制每个 case 只能以 pass / fail 收尾，杜绝静默跳过。
// 任务书规定不得用"条件不满足就跳过"掩盖问题，本文件是脚本自身的守卫。
const RESULT_PASS = "pass";
const RESULT_FAIL = "fail";
// 未验证：前置依赖缺失（如生成不出候选）导致该案例无法执行。
// 与 fail 区分开——既不能算通过，也不该记成"脚本或产品断言失败"。
const RESULT_UNVERIFIED = "unverified";

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
    // 已显式判定为 unverified 的案例，finish 不得把它改写成 pass/fail。
    if (entry.status === RESULT_UNVERIFIED) {
      if (evidence !== null) entry.evidence = evidence;
      return entry;
    }
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
    // 未注册的 case 不得中断整个脚本：记录为 fail 并继续，
    // 保证后续案例仍会执行（否则"未执行"会被误当成环境问题）。
    if (!results.has(caseId)) {
      results.set(caseId, {
        caseId,
        title: caseId,
        rNumbers: [],
        blockedBy: null,
        status: RESULT_FAIL,
        assertions: [
          {
            description: `案例 ${caseId} 未在 CASE_PLAN 注册，无法执行`,
            ok: false,
            evidence: null,
          },
        ],
        detail: `案例 ${caseId} 未在 CASE_PLAN 注册`,
        evidence: null,
      });
      return results.get(caseId);
    }
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
      // 无论成功失败都走一次收尾，保证状态不是 not-run / in-progress。
      // 但 unverified 是显式结论（前置缺失），不能被这里的兜底改写成 fail。
      if (entry.status === RESULT_UNVERIFIED) {
        // 保留原判定与原因。
      } else if (entry.status !== RESULT_PASS) {
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

  // 可控失败注入：直接改内部状态（list() 返回副本，改副本无效）。
  const injectFailure = (caseId, reason) => {
    const entry = results.get(caseId);
    if (!entry) return false;
    entry.status = RESULT_FAIL;
    entry.detail = reason;
    entry.assertions.push({ description: reason, ok: false, evidence: { injected: true } });
    return true;
  };

  // 前置缺失：明确标 unverified，并写明阻塞原因，附带已有证据进报告。
  const unverified = (caseId, reason, evidence = null) => {
    const entry = entryOf(caseId);
    entry.status = RESULT_UNVERIFIED;
    entry.detail = reason;
    entry.evidence = evidence;
    return entry;
  };

  // 自检 A：任何既不是 pass / fail / unverified 的案例都要在此暴露。
  const auditUnresolved = () => {
    const unresolved = list().filter(
      (e) =>
        e.status !== RESULT_PASS &&
        e.status !== RESULT_FAIL &&
        e.status !== RESULT_UNVERIFIED,
    );
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
      unverified: all.filter((e) => e.status === RESULT_UNVERIFIED).length,
      unresolved: all.filter(
        (e) =>
          e.status !== RESULT_PASS &&
          e.status !== RESULT_FAIL &&
          e.status !== RESULT_UNVERIFIED,
      ).length,
    };
  };

  return {
    check,
    fail,
    unverified,
    finish,
    runCase,
    list,
    auditUnresolved,
    summary,
    injectFailure,
  };
}

module.exports = {
  createRunner,
  RESULT_PASS,
  RESULT_FAIL,
  RESULT_UNVERIFIED,
  REQUIRED_FIELDS,
};
