const optionRef = (o) => `${o.attribute}/${o.id}`;
const RETURNS_VALUE = /* @__PURE__ */ new Set(["String", "Number", "Price", "Time", "DateTime", "Coordinate"]);
function operatorKind(op) {
  if (op.inputs.includes("Concept")) return "\u901A\u7528\u7B97\u5B50";
  if (op.output === "Bool") return "\u8C13\u8BCD";
  if (RETURNS_VALUE.has(op.output)) return op.inputs.length > 1 ? "\u5E26\u53C2\u6570\u7684\u5C5E\u6027" : "\u5C5E\u6027";
  return op.inputs.length > 1 ? "\u591A\u5143\u5173\u7CFB\u3001\u53D8\u6362" : "\u4E8C\u5143\u5173\u7CFB";
}
function validateOntology(o) {
  const errs = [];
  const conceptNames = /* @__PURE__ */ new Set();
  for (const c of o.concepts) {
    if (!/^[A-Z]\w*$/.test(c.name)) errs.push(`\u6982\u5FF5\u540D\u5E94\u4E3A PascalCase\uFF1A${c.name}`);
    if (conceptNames.has(c.name)) errs.push(`\u6982\u5FF5\u91CD\u590D\uFF1A${c.name}`);
    conceptNames.add(c.name);
  }
  const types = /* @__PURE__ */ new Set([...conceptNames, ...o.valueTypes]);
  const opNames = /* @__PURE__ */ new Set();
  for (const op of o.operators) {
    if (!/^[a-z][a-z0-9_]*$/.test(op.name)) errs.push(`\u7B97\u5B50\u540D\u5E94\u4E3A\u5C0F\u5199\u4E0B\u5212\u7EBF\uFF1A${op.name}`);
    if (opNames.has(op.name)) errs.push(`\u7B97\u5B50\u91CD\u590D\uFF1A${op.name}`);
    opNames.add(op.name);
    if (!op.inputs.length) errs.push(`\u7B97\u5B50\u6CA1\u6709\u8F93\u5165\uFF1A${op.name}`);
    for (const t of [...op.inputs, op.output]) if (!types.has(t)) errs.push(`\u7B97\u5B50 ${op.name} \u7528\u5230\u672A\u58F0\u660E\u7684\u7C7B\u578B\uFF1A${t}`);
  }
  const attrIds = /* @__PURE__ */ new Set();
  for (const a of o.attributes) {
    if (attrIds.has(a.id)) errs.push(`\u5C5E\u6027 ID \u91CD\u590D\uFF1A${a.id}`);
    attrIds.add(a.id);
  }
  const refs = /* @__PURE__ */ new Set();
  const aliasOwner = /* @__PURE__ */ new Map();
  for (const opt of o.options) {
    const ref = optionRef(opt);
    if (!attrIds.has(opt.attribute)) errs.push(`\u9009\u9879 ${ref} \u6240\u5C5E\u7684\u5C5E\u6027\u4E0D\u5B58\u5728`);
    if (refs.has(ref)) errs.push(`\u9009\u9879\u91CD\u590D\uFF1A${ref}`);
    refs.add(ref);
    if (!opt.name.trim()) errs.push(`\u9009\u9879 ${ref} \u6CA1\u6709\u540D\u79F0`);
    if (!(opt.extraPrice >= 0)) errs.push(`\u9009\u9879 ${ref} \u7684\u52A0\u4EF7\u4E0D\u80FD\u4E3A\u8D1F`);
    for (const word of [opt.name, ...opt.aliases]) {
      const key = word.trim();
      if (!key) {
        errs.push(`\u9009\u9879 ${ref} \u6709\u7A7A\u522B\u540D`);
        continue;
      }
      const owner = aliasOwner.get(key);
      if (owner && owner !== ref) errs.push(`\u201C${key}\u201D\u540C\u65F6\u6307\u5411 ${owner} \u548C ${ref}`);
      aliasOwner.set(key, ref);
    }
  }
  return errs;
}
function resolveOption(o, word, attribute) {
  const w = word.trim();
  return o.options.filter(
    (opt) => (attribute === void 0 || opt.attribute === attribute) && (opt.name === w || opt.aliases.includes(w))
  );
}
const findOption = (o, ref) => o.options.find((opt) => optionRef(opt) === ref);
export {
  findOption,
  operatorKind,
  optionRef,
  resolveOption,
  validateOntology
};
