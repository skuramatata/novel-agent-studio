/** 长 UUID 留在检查点；模型只回填本批短编号，程序精确映射，不模糊修正错别 ID。 */
export function authorIdProtocol(messages) {
  const forward = new Map(),
    reverse = new Map();
  const mapped = messages.map((message) => {
    if (message.role !== "user") return message;
    let value;
    try {
      value = JSON.parse(message.content);
    } catch {
      return message;
    }
    if (
      !Array.isArray(value?.authorConstraints) ||
      !value.authorConstraints.length
    )
      return message;
    value.authorConstraints = value.authorConstraints.map((constraint) => {
      let id = forward.get(constraint.id);
      if (!id) {
        id = `author-${forward.size + 1}`;
        forward.set(constraint.id, id);
        reverse.set(id, constraint.id);
      }
      return { ...constraint, id };
    });
    return { ...message, content: JSON.stringify(value) };
  });
  if (!reverse.size)
    return { messages, decode: (v) => v, diagnostic: (s) => s };
  return {
    messages: mapped,
    decode(value) {
      if (!Array.isArray(value?.authorChecks)) return value;
      return {
        ...value,
        authorChecks: value.authorChecks.map((check) => ({
          ...check,
          id: reverse.get(check.id) || check.id,
        })),
      };
    },
    diagnostic(text) {
      for (const [full, short] of forward) text = text.replaceAll(full, short);
      return text;
    },
  };
}
