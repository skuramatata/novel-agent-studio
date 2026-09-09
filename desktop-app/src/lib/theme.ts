export type Theme = "light" | "dark";
const storageKey = "novel-studio-theme";

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* 存储不可用时仍允许切换。 */ }
  return "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(storageKey, theme); } catch { /* 保留本次会话选择。 */ }
}
