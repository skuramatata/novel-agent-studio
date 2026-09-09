import { useEffect, useState } from "react";
import { X, ShieldCheck, PlugZap, Check } from "lucide-react";
import { useStudio } from "../state/StudioContext";
import { bridge, isDesktop } from "../lib/bridge";
import type { Provider, ModelLimits } from "../lib/types";
import { ModelBudgetFields } from "./ModelBudgetFields";
import { providerDefaults } from "../../runtime/catalog.mjs";
export function Settings({ onClose }: { onClose: () => void }) {
  const { settings, setSettings, provider, setProvider } = useStudio();
  const [selected, setSelected] = useState<Provider>(provider);
  const [model, setModel] = useState(
    settings?.[provider].model || providerDefaults[provider].model,
  );
  const [baseUrl, setBaseUrl] = useState(
    settings?.[provider].baseUrl || providerDefaults[provider].baseUrl,
  );
  const [apiKey, setKey] = useState("");
  const [limits, setLimits] = useState<Partial<ModelLimits>>(
    settings?.[provider].limits || {},
  );
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    if (!settings) return;
    setModel(settings[selected].model);
    setBaseUrl(settings[selected].baseUrl);
    setLimits(settings[selected].limits || {});
  }, [settings, selected]);
  const choose = (p: Provider) => {
    setSelected(p);
    setModel(settings?.[p].model || "");
    setBaseUrl(settings?.[p].baseUrl || "");
    setKey("");
    setFeedback("");
    setLimits(settings?.[p].limits || {});
  };
  async function save(test = false) {
    setWorking(true);
    setFeedback("");
    try {
      const s = await bridge.saveSettings({
        provider: selected,
        model,
        baseUrl,
        apiKey,
        hasKey: !!settings?.[selected].hasKey,
        limits,
      });
      setSettings(s);
      setProvider(selected);
      setKey("");
      setFeedback(test ? (await bridge.test(selected)).text : "配置已保存");
    } catch (e) {
      setFeedback((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !working) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="模型连接"
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">模型与连接</span>
            <h2>让故事开始生长</h2>
          </div>
          <button
            className="icon-button"
            aria-label="关闭模型设置"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="segmented">
          {(["glm", "minimax"] as Provider[]).map((p) => (
            <button
              key={p}
              className={p === selected ? "active" : ""}
              onClick={() => choose(p)}
            >
              {p === "glm" ? "GLM Coding Plan" : "MiniMax Token Plan"}
            </button>
          ))}
        </div>
        <div className="connection-note">
          <ShieldCheck size={18} />
          {!settings
            ? "正在读取模型配置…"
            : settings[selected].hasKey
              ? "已读取密钥 · 仅桌面主进程使用"
              : "尚未配置密钥"}
          {!isDesktop && " · 浏览器仅为交互预览"}
        </div>
        <label>
          模型名称
          <input
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setLimits({});
            }}
            placeholder={selected === "glm" ? "glm-5.2" : "MiniMax-M3"}
          />
        </label>
        <label>
          接口地址
          <input
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setLimits({});
            }}
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setKey(e.target.value)}
            placeholder="留空保留现有密钥"
          />
        </label>
        <ModelBudgetFields
          config={{ provider: selected, model, baseUrl }}
          value={limits}
          onChange={setLimits}
        />
        <p className="muted small">
          开发版从项目根目录 .env 导入密钥，安装版从应用数据目录 .env
          导入；也可在此手动填写。密钥经系统安全存储加密保存，后续优先读取加密配置。不会自动切换按量计费入口。
        </p>
        {selected === "glm" && (
          <p className="muted small">
            GLM 官方将 Coding Plan
            限于指定工具环境；接口连通不代表独立小说应用的套餐适用性已确认。
          </p>
        )}
        {feedback && (
          <div className="inline-feedback" role="status">
            {feedback}
          </div>
        )}
        <div className="modal-actions">
          <button
            className="secondary"
            disabled={working || !isDesktop || !settings}
            onClick={() => void save(true)}
          >
            <PlugZap size={16} />
            {working ? "连接中…" : "保存并测试连接"}
          </button>
          <button
            className="primary"
            disabled={working || !isDesktop || !settings}
            onClick={() => void save()}
          >
            <Check size={16} />
            保存配置
          </button>
        </div>
      </section>
    </div>
  );
}
