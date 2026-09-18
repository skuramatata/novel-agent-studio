import { useState } from "react";
import "./log-json.css";

export function parseLogJson(value: unknown): unknown {
  if (typeof value !== "string" || !/^[\s]*[\[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    // 普通文本、未完成或非法 JSON 保留原文。
    return value;
  }
}

function JsonEntry({
  value,
  field,
  depth = 0,
}: {
  value: unknown;
  field?: string;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  const decoded = parseLogJson(value);
  const key =
    field === undefined ? null : (
      <span className="log-json-key">{JSON.stringify(field)}: </span>
    );
  if (decoded === null || typeof decoded !== "object") {
    return (
      <div className="log-json-entry" data-json-field={field}>
        {key}
        <span
          className={`log-json-${decoded === null ? "null" : typeof decoded}`}
        >
          {typeof decoded === "string" ? `"${decoded}"` : String(decoded)}
        </span>
      </div>
    );
  }
  const array = Array.isArray(decoded);
  const entries = Object.entries(decoded);
  const start = array ? "[" : "{";
  const end = array ? "]" : "}";
  if (!entries.length)
    return (
      <div className="log-json-entry" data-json-field={field}>
        {key}
        {start}
        {end}
      </div>
    );
  return (
    <details
      className="log-json-branch"
      data-json-field={field}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {key}
        {start}
        <span className="log-json-count">
          {" "}
          {entries.length} {array ? "项" : "个字段"}{" "}
        </span>
        {!open && end}
        {typeof value === "string" && (
          <span className="log-json-count"> · JSON 字符串已解析</span>
        )}
      </summary>
      {open && (
        <>
          <div className="log-json-children">
            {entries.map(([name, item]) => (
              <JsonEntry
                key={name}
                field={name}
                value={item}
                depth={depth + 1}
              />
            ))}
          </div>
          <div>{end}</div>
        </>
      )}
    </details>
  );
}

export function LogJson({ value }: { value: unknown }) {
  return (
    <div className="log-json" role="region" aria-label="JSON 数据" tabIndex={0}>
      <JsonEntry value={value} />
    </div>
  );
}
