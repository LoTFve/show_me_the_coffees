import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { comparePlans, isOpen, parseProducts, parseQuote, parseStores } from "../src/luckin.js";

// 真实瑞幸返回的脱敏夹具（2026-11-04 实测）
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");

describe("parseStores (queryShopList)", () => {
  it("maps real fields and keeps every store", () => {
    const stores = parseStores(fixture("queryShopList"));
    expect(stores.length).toBeGreaterThan(0);
    expect(stores[0]).toMatchObject({
      deptId: 606675,
      name: "中国科学技术大学高新校区内部店",
      workStatus: "营业中",
    });
    expect(typeof stores[0].longitude).toBe("number");
    expect(typeof stores[0].latitude).toBe("number");
    expect(stores[0].tags).toContain("常用门店");
  });

  it("isOpen tracks workStatus", () => {
    expect(isOpen({ workStatus: "营业中" } as any)).toBe(true);
    expect(isOpen({ workStatus: "打烊中" } as any)).toBe(false);
  });
});

describe("parseProducts (searchProductForMcp)", () => {
  it("maps productId / name / skuCode from real fields", () => {
    const products = parseProducts(fixture("searchProductForMcp"));
    expect(products[0]).toMatchObject({ productId: 4805, name: "拿铁", skuCode: "SP3225-00147" });
  });
});

describe("comparePlans", () => {
  it("picks split when the per-cup sum is lower and marks it estimated", () => {
    const c = comparePlans(30, [9.9, 9.9], 40); // 合单 30，拆两单 19.8，原价 40
    expect(c.cheaper).toBe("split");
    const split = c.plans.find((p) => p.kind === "split")!;
    expect(split.payYuan).toBeCloseTo(19.8, 5);
    expect(split.orderCount).toBe(2);
    expect(split.estimated).toBe(true);
    expect(c.plans.find((p) => p.kind === "combined")!.estimated).toBe(false);
    expect(c.maxSaveYuan).toBeCloseTo(20.2, 5); // 40 − 19.8
  });

  it("picks combined when splitting is not cheaper", () => {
    const c = comparePlans(18, [9.9, 9.9], 40); // 合单 18 < 拆单 19.8
    expect(c.cheaper).toBe("combined");
    expect(c.maxSaveYuan).toBeCloseTo(22, 5); // 40 − 18
  });

  it("never reports a negative saving", () => {
    const c = comparePlans(50, [25, 25], 40); // 实付都高于原价（异常），省不为负
    expect(c.maxSaveYuan).toBe(0);
  });
});

describe("parseQuote (previewOrder)", () => {
  it("reads payPrice, privilege and coupon list from real fields", () => {
    const q = parseQuote(fixture("previewOrder"));
    expect(q.payPrice).toBe(9.9);
    expect(q.initialPrice).toBe(15);
    expect(q.privilege).toBeCloseTo(5.1, 5);
    expect(q.couponCodeList).toEqual(["COUPON_PLACEHOLDER"]);
    expect(q.deptId).toBe(606675);
  });

  it("throws on a business-failure payload", () => {
    expect(() => parseQuote('{"code":1000,"msg":"非法参数","success":false}')).toThrow(/非法参数/);
  });

  it("throws when price is missing", () => {
    expect(() => parseQuote('{"success":true,"data":{}}')).toThrow(/没有返回价格/);
  });
});
