import { useState } from "react";
import { Sun, Moon } from "lucide-react";
import { applyTheme, readTheme, type Theme } from "../lib/theme";

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  return (
    <div className="theme-switch" role="group" aria-label="界面主题">
      {([{ id: "light", label: "白天", Icon: Sun }, { id: "dark", label: "黑夜", Icon: Moon }] as const).map(({ id, label, Icon }) => (
        <button key={id} type="button" aria-pressed={theme === id} onClick={() => {
          applyTheme(id);
          setTheme(id);
        }}>
          <Icon size={14} aria-hidden="true" />{label}
        </button>
      ))}
    </div>
  );
}
