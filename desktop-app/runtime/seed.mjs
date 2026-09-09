export const authorPresets = [
  {
    name: "档案观察者",
    personality:
      "审慎、疏离，对记录的完整性抱有怀疑；关心普通人在未知面前如何维持日常。",
    chinese: "地方志、笔记与志怪；关注记录者的立场，不照搬古文。",
    western: "宇宙恐怖与不可靠叙述；重视证据渐变和认知崩塌。",
    habits: "偏好具体名词与克制动词；犹疑时短暂停顿，不强制重复口癖。",
    references: "偶尔借文献意象作比喻；不硬插书名，不引用未经核对的原句。",
    avoid: "避免不可名状等词堆积、章末说教、人物提前知情和全员文人腔。",
  },
  {
    name: "冷静的怀疑者",
    personality: "相信观察和推理，对自己的记忆却不完全信任。",
    chinese: "现代散文与日常口语，关注生活细节。",
    western: "心理悬疑、哥特小说与戏剧对话。",
    habits: "对话短，叙述留白；比喻来自眼前事物。",
    references: "很少引用著作，以具体观察为主。",
    avoid: "避免华丽堆砌、廉价惊吓和解释一切的专家。",
  },
  {
    name: "旧事记录人",
    personality: "温和但固执，熟悉人情，习惯从旁人的沉默里寻找答案。",
    chinese: "笔记、乡土叙事与民间传说；明确虚构与史实边界。",
    western: "偏好有限视角和逐层展开的悬念。",
    habits: "语气平实，偶有含混转述；让人物各有词汇。",
    references: "允许少量化用；不把文学积累强加给角色。",
    avoid: "避免每章重复民俗套路，不把怀疑写成事实。",
  },
];
export function blankProject() {
  return {
    schemaVersion: 1,
    revision: 0,
    author: structuredClone(authorPresets[0]),
    premise: {
      title: "未命名作品",
      genre: "宇宙恐怖 · 悬疑",
      setting: "",
      theme: "",
      narrator: "第三人称限知",
      chapterCount: 12,
      chapterWords: 2500,
    },
    plan: { outline: "", truth: "", timeline: "", reveals: "" },
    characters: [],
    relations: [],
    chapters: [],
    messages: [],
    demo: false,
  };
}
export function demoProposal() {
  return {
    summary:
      "演示规划：以一份多出名字的夜班记录为起点，搭建三个人物和四章故事。这是固定示例，不是模型生成。",
    premise: {
      title: "潮声之外",
      genre: "宇宙恐怖 · 悬疑",
      setting: "一座即将停用的海边档案馆。每到退潮，地下室会出现潮湿的脚印。",
      theme: "当记录比记忆更可靠，我们还剩下什么？",
      narrator: "第三人称限知 · 林遥",
      chapterCount: 4,
      chapterWords: 2500,
    },
    plan: {
      outline:
        "林遥为了找到失踪父亲的最后一份值班记录，回到海边档案馆。\n\n她发现每一年的交接表上都有同一个人的签名。管理员陈伯拒绝打开旧库房，实习生许澄却交给她一张错误日期的借阅单。\n\n林遥最终选择保留父亲留下的空白，封存记录，但走出馆门时发现自己的签名已经出现在明天的值班表上。",
      truth:
        "档案记录逐渐替代真实发生的事件；人物不知道这一机制，结尾只兑现局部证据。",
      timeline:
        "事件顺序：父亲留下空页 → 许澄发现借阅单 → 林遥返馆 → 明日记录出现。\n叙述顺序：返馆 → 借阅单 → 父亲空页 → 明日记录。",
      reveals:
        "第一章：只展示重复的签名。\n第二章：展示日期矛盾。\n第三章：回应父亲留下的空白。\n第四章：出现林遥的签名，不解释全部机制。",
    },
    characters: [
      {
        id: "lin",
        name: "林遥",
        role: "主角 · 档案修复师",
        goal: "找到父亲失踪前的值班记录",
        secret: "不愿承认自己忘记了父亲的声音",
        voice: "谨慎、关注纸张与笔迹",
        position: { x: 60, y: 170 },
      },
      {
        id: "chen",
        name: "陈伯",
        role: "馆内管理员",
        goal: "阻止旧库房被重新打开",
        secret: "知道值班表上的签名会变化",
        voice: "简短，回答具体事务时才说话",
        position: { x: 400, y: 50 },
      },
      {
        id: "xu",
        name: "许澄",
        role: "实习生",
        goal: "弄清自己的借阅记录为何重复",
        secret: "曾进入封存库房",
        voice: "语速快，紧张时反复确认日期",
        position: { x: 400, y: 330 },
      },
    ],
    relations: [
      {
        id: "r1",
        source: "lin",
        target: "chen",
        label: "怀疑 · 寻求协助",
        detail: "林遥认为陈伯知道父亲的去向，却仍需要他打开库房。",
      },
      {
        id: "r2",
        source: "chen",
        target: "xu",
        label: "隐瞒 · 保护",
        detail: "陈伯试图让许澄离开夜班，未向她说明原因。",
      },
      {
        id: "r3",
        source: "xu",
        target: "lin",
        label: "信任 · 交换线索",
        detail: "许澄向林遥提供错误日期的借阅单。",
      },
    ],
    chapters: [
      {
        id: "c1",
        number: 1,
        title: "交接记录",
        summary: "林遥回到档案馆，注意到跨越十年的相同签名。",
        content: "",
      },
      {
        id: "c2",
        number: 2,
        title: "没有发生的借阅",
        summary: "许澄拿出一张明天才会开出的借阅单。",
        content: "",
      },
      {
        id: "c3",
        number: 3,
        title: "父亲留下的空页",
        summary: "库房打开，林遥必须决定是否补完记录。",
        content: "",
      },
      {
        id: "c4",
        number: 4,
        title: "下一班",
        summary: "局部真相得到回应，新的签名留下余波。",
        content: "",
      },
    ],
  };
}
export function demoProject() {
  return {
    ...blankProject(),
    ...Object.fromEntries(
      Object.entries(demoProposal()).filter(([k]) => k !== "summary"),
    ),
    demo: true,
  };
}
export const demoChapter =
  "馆门比林遥记忆中窄。\n\n她把行李留在台阶上，侧着身子走进去。大厅没有开灯，陈伯在前台整理钥匙，每一把都先放到耳边晃两下，再挂回木板。\n\n“找哪一年的？”他没有抬头。\n\n“父亲最后值班的那年。”\n\n陈伯把手里那把钥匙放下了。\n\n交接本已经摊在桌上。纸页的边缘泛黄，中间却很干净。林遥翻到十年前，认出了父亲签名最后那一笔——总会向下拖出一点，像没能及时停住。\n\n她往后翻了一页。同样的一笔。\n\n又一页。\n\n纸张逐渐变白，签名没有变。她拿出手机，准备拍照，陈伯伸手按住了本子。\n\n“先别留底。”他说。";
