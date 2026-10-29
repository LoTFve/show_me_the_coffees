import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { operatorKind, optionRef, resolveOption, validateOntology, type Ontology } from "../src/ontology.js";

const data = (): Ontology => JSON.parse(readFileSync(new URL("../ontology/luckin.json", import.meta.url), "utf8"));

describe("ontology/luckin.json", () => {
  it("passes validation", () => {
    expect(validateOntology(data())).toEqual([]);
  });

  it("matches the operator classification table in docs/luckin-co.md", () => {
    const counts: Record<string, number> = {};
    for (const op of data().operators) counts[operatorKind(op)] = (counts[operatorKind(op)] ?? 0) + 1;
    expect(counts).toEqual({ 属性: 17, 带参数的属性: 3, 谓词: 8, 二元关系: 15, "多元关系、变换": 6, 通用算子: 1 });
  });

  it("refers to options by attribute and id, because ids collide across concepts", () => {
    const o = data();
    // 属性“气泡”的 ID 和选项“少甜”的 ID 都是 112
    expect(o.attributes.find((a) => a.id === 112)?.name).toBe("气泡");
    expect(resolveOption(o, "少糖").map(optionRef)).toEqual(["18/112"]);
    expect(resolveOption(o, "少甜", 18).map(optionRef)).toEqual(["18/112"]);
  });

  it("does not guess words that are not aliases", () => {
    const o = data();
    expect(resolveOption(o, "半糖")).toEqual([]);
    expect(resolveOption(o, "中杯")).toEqual([]);
    expect(resolveOption(o, "去冰")).toEqual([]);
  });
});

describe("validateOntology", () => {
  it("rejects an alias that points at two options", () => {
    const o = data();
    o.options.find((x) => optionRef(x) === "18/254")!.aliases.push("少糖");
    expect(validateOntology(o)).toContain("“少糖”同时指向 18/112 和 18/254");
  });

  it("rejects operators that use undeclared types", () => {
    const o = data();
    o.operators.push({ name: "store_owner", inputs: ["Store"], output: "Person", many: false, section: "" });
    expect(validateOntology(o)).toContain("算子 store_owner 用到未声明的类型：Person");
  });

  it("rejects duplicate options and options of missing attributes", () => {
    const o = data();
    o.options.push({ ...o.options[0] });
    o.options.push({ attribute: 999, id: 1, name: "x", aliases: [], extraPrice: 0, seenIn: "" });
    const errs = validateOntology(o);
    expect(errs).toContain(`选项重复：${optionRef(o.options[0])}`);
    expect(errs).toContain("选项 999/1 所属的属性不存在");
  });
});
