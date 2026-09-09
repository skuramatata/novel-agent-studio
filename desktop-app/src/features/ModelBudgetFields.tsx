import type { ModelLimits, ProviderConfig } from "../lib/types";
import {
  modelCapabilities,
  capabilityKey,
} from "../../runtime/model-capabilities.mjs";

export function ModelBudgetFields({
  config,
  value,
  onChange,
}: {
  config: Pick<ProviderConfig, "provider" | "model" | "baseUrl">;
  value: Partial<ModelLimits>;
  onChange: (value: Partial<ModelLimits>) => void;
}) {
  const suggested = modelCapabilities(config);
  let effective = "";
  try {
    const resolved = modelCapabilities({
      ...config,
      limits: value,
      limitKey: capabilityKey(config),
    });
    effective = `有效上下文 ${resolved.contextLimit.toLocaleString()} · 最大输出 ${resolved.maxOutputTokens.toLocaleString()} Token`;
  } catch {
    effective = "请输入有效的整数预算";
  }
  const fields: [keyof ModelLimits, string][] = [
    ["contextWindow", "上下文总量"],
    ["maxOutputTokens", "单次输出上限"],
    ["appContextCap", "应用单次预算"],
    ["maxInputTokens", "接口独立输入上限（可选）"],
    ["endpointContextLimit", "接口上下文限制（可选）"],
  ];
  return (
    <details className="model-budget-fields">
      <summary>Token 预算 · 随模型切换</summary>
      <p className="small">{effective}</p>
      <p className="muted small">
        {suggested.confidence}。留空使用建议值；自定义值仅用于当前模型及接口。
      </p>
      <div className="budget-grid">
        {fields.map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min={key === "maxOutputTokens" ? 256 : 4096}
              max={2000000}
              step={1}
              value={value[key] ?? ""}
              placeholder={
                suggested[key] == null ? "未指定" : String(suggested[key])
              }
              onChange={(e) =>
                onChange({
                  ...value,
                  [key]:
                    e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
            />
          </label>
        ))}
      </div>
      <button className="secondary" type="button" onClick={() => onChange({})}>
        恢复当前模型建议值
      </button>
    </details>
  );
}
