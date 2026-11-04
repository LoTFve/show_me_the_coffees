import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isOpen, parseProducts, parseQuote, parseStores } from "../src/luckin.js";

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
