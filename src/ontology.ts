// 瑞幸点单本体库（Concept 与 Operator）的数据结构、分类和校验。
// 插件、个人本地后台、总服务器共用这一份逻辑；数据以 ontology/luckin.json 为准。

export interface Concept {
  name: string;
  /** 分组：store 门店、product 商品与规格、quote 报价与券、order 订单 */
  group: string;
  role: string;
  identity: string;
}

export interface Operator {
  name: string;
  inputs: string[];
  /** 返回的类型；many=true 时实际返回 set(output) */
  output: string;
  many: boolean;
  section: string;
}

export interface Attribute {
  id: number;
  name: string;
}

export interface Option {
  attribute: number;
  id: number;
  name: string;
  aliases: string[];
  extraPrice: number;
  seenIn: string;
}

export interface Ontology {
  version: number;
  updatedAt: string;
  source: string;
  note: string;
  valueTypes: string[];
  concepts: Concept[];
  operators: Operator[];
  attributes: Attribute[];
  options: Option[];
}

/** 引用一个选项要连同属性一起写：属性 112（气泡）和选项 112（少甜）会撞号 */
export const optionRef = (o: { attribute: number; id: number }) => `${o.attribute}/${o.id}`;

export type OperatorKind = "属性" | "带参数的属性" | "谓词" | "二元关系" | "多元关系、变换" | "通用算子";
const RETURNS_VALUE = new Set(["String", "Number", "Price", "Time", "DateTime", "Coordinate"]);

/** 算子分类，和 docs/luckin-co.md 第 3 节的分类表一致 */
export function operatorKind(op: Operator): OperatorKind {
  if (op.inputs.includes("Concept")) return "通用算子";
  if (op.output === "Bool") return "谓词";
  if (RETURNS_VALUE.has(op.output)) return op.inputs.length > 1 ? "带参数的属性" : "属性";
  return op.inputs.length > 1 ? "多元关系、变换" : "二元关系";
}

/** 校验本体库；返回问题列表，空数组表示通过 */
export function validateOntology(o: Ontology): string[] {
  const errs: string[] = [];
  const conceptNames = new Set<string>();
  for (const c of o.concepts) {
    if (!/^[A-Z]\w*$/.test(c.name)) errs.push(`概念名应为 PascalCase：${c.name}`);
    if (conceptNames.has(c.name)) errs.push(`概念重复：${c.name}`);
    conceptNames.add(c.name);
  }
  const types = new Set([...conceptNames, ...o.valueTypes]);
  const opNames = new Set<string>();
  for (const op of o.operators) {
    if (!/^[a-z][a-z0-9_]*$/.test(op.name)) errs.push(`算子名应为小写下划线：${op.name}`);
    if (opNames.has(op.name)) errs.push(`算子重复：${op.name}`);
    opNames.add(op.name);
    if (!op.inputs.length) errs.push(`算子没有输入：${op.name}`);
    for (const t of [...op.inputs, op.output]) if (!types.has(t)) errs.push(`算子 ${op.name} 用到未声明的类型：${t}`);
  }
  const attrIds = new Set<number>();
  for (const a of o.attributes) {
    if (attrIds.has(a.id)) errs.push(`属性 ID 重复：${a.id}`);
    attrIds.add(a.id);
  }
  const refs = new Set<string>();
  const aliasOwner = new Map<string, string>();
  for (const opt of o.options) {
    const ref = optionRef(opt);
    if (!attrIds.has(opt.attribute)) errs.push(`选项 ${ref} 所属的属性不存在`);
    if (refs.has(ref)) errs.push(`选项重复：${ref}`);
    refs.add(ref);
    if (!opt.name.trim()) errs.push(`选项 ${ref} 没有名称`);
    if (!(opt.extraPrice >= 0)) errs.push(`选项 ${ref} 的加价不能为负`);
    // 别名只能指向一个选项，正名也不能被别的选项当别名用
    for (const word of [opt.name, ...opt.aliases]) {
      const key = word.trim();
      if (!key) {
        errs.push(`选项 ${ref} 有空别名`);
        continue;
      }
      const owner = aliasOwner.get(key);
      if (owner && owner !== ref) errs.push(`“${key}”同时指向 ${owner} 和 ${ref}`);
      aliasOwner.set(key, ref);
    }
  }
  return errs;
}

/** 把用户说的词解析成选项；只按正名和别名精确匹配，不猜 */
export function resolveOption(o: Ontology, word: string, attribute?: number): Option[] {
  const w = word.trim();
  return o.options.filter(
    (opt) => (attribute === undefined || opt.attribute === attribute) && (opt.name === w || opt.aliases.includes(w)),
  );
}

export const findOption = (o: Ontology, ref: string) => o.options.find((opt) => optionRef(opt) === ref);
