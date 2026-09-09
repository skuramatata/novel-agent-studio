/** @typedef {{mode: "absolute" | "percent", value: number}} WordTolerance */
/** @type {Readonly<WordTolerance>} */
export const DEFAULT_WORD_TOLERANCE = Object.freeze({
  mode: "absolute",
  value: 500,
});

export function projectWordTolerance(project) {
  return {
    ...(project.writingSettings?.wordTolerance ?? DEFAULT_WORD_TOLERANCE),
  };
}

/** @param {WordTolerance} tolerance */
export function validWordTolerance(tolerance) {
  return (
    ["absolute", "percent"].includes(tolerance.mode) &&
    Number.isFinite(tolerance.value) &&
    tolerance.value >= 0 &&
    tolerance.value <= Number.MAX_SAFE_INTEGER &&
    (tolerance.mode === "percent" || Number.isSafeInteger(tolerance.value))
  );
}

/** @param {number} targetWords @param {WordTolerance} tolerance */
export function chapterWordRange(
  targetWords,
  tolerance = DEFAULT_WORD_TOLERANCE,
) {
  if (!validWordTolerance(tolerance))
    throw Error("字数容差必须为非负数，固定字数须为整数。");
  const delta =
    tolerance.mode === "percent"
      ? targetWords * (tolerance.value / 100)
      : tolerance.value;
  return {
    min: Math.max(100, Math.ceil(targetWords - delta)),
    max: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(targetWords + delta)),
  };
}

/** @param {WordTolerance} tolerance */
export function wordToleranceLabel(tolerance = DEFAULT_WORD_TOLERANCE) {
  return `±${tolerance.value}${tolerance.mode === "percent" ? "%" : "字"}`;
}
