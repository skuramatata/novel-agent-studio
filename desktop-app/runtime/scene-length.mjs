import { countWords } from "./writing.mjs";

export const lengthDistance = (words, lower, upper) =>
  Math.max(lower - words, 0, words - upper);

// 篇幅编辑只处理已写完的场景；完整事实回查仍由后续审稿执行。
export function sceneLengthMessages({
  draft,
  targetWords,
  lower,
  upper,
  scene,
  author,
  previousScenes,
  followingScenes,
  feedback,
  attempts = [],
}) {
  const actualWords = countWords(draft),
    compress = actualWords > upper;
  const paragraphs = Math.max(3, Math.ceil(targetWords / 150));
  return [
    {
      role: "system",
      content: `你是中文小说篇幅编辑。当前场景已结束但字数不合要求。重写本场景完整正文到${targetWords}字，允许${lower}—${upper}字。字数由程序统计：汉字逐字计，连续英文/数字算一字，标点与空白不计。
本轮唯一任务是${compress ? "实质压缩" : "在原场景范围内扩写"}，不是通篇润色。当前实测${actualWords}字。${compress ? `必须至少删去${actualWords - upper}字，争取删去${actualWords - targetWords}字，只保留约${Math.round((targetWords / actualWords) * 100)}%的文字；小改几个字或原样复制不合格。合并重复感官、动作与解释，同一信息只写一次，次要过程可概述。` : `需要增加约${targetWords - actualWords}字，通过已有行动的过程、阻力与后果补足，不重复结尾，不新增往事、人物或后续事件。`}
保留关键行动及结果、因果转折、有效线索、人物身份和知情边界、时间与物件状态。不能为了篇幅改动事实；不增添故事材料之外的信息，不借扩写兑现后续场景。参考作者声音，但本轮不要额外强化氛围或铺陈。前后场景仅供衔接，不得复制到当前正文中。
${attempts.length ? "此前调整没有达标，请根据attempts中的实测结果改变写法，不再输出同一版本。先在内部提炼必要事件，再重新组织正文；不要把压缩计划写进正文。" : ""}可写约${paragraphs}段，每段平均约${Math.floor(targetWords / paragraphs)}字；这是组织预算，不要求机械分段。
只输出改好的完整场景正文，不输出JSON、标题、说明、字数声明或省略号占位。场景结束后另起一行输出〈场景完成〉。`,
    },
    {
      role: "user",
      content: JSON.stringify({
        task: {
          operation: compress ? "compress" : "expand",
          targetWords,
          lower,
          upper,
          actualWords,
        },
        author,
        scene,
        previousScenes: previousScenes.slice(-1),
        followingScenes: followingScenes.slice(0, 1),
        draft,
        feedback,
        attempts: attempts.slice(-3),
      }),
    },
  ];
}
