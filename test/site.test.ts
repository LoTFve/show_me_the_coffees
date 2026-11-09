import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 小算盘官网和回调页，用例编号见 docs/pdd-site/test-plan.md
const site = join(__dirname, "..", "site");
const read = (p: string) => readFileSync(join(site, p), "utf8");
const index = read("index.html");
const callback = read("pdd/callback/index.html");
const pages = { index, callback };

describe("site", () => {
  it("S1 官网标题和 h1 含产品名", () => {
    expect(index).toMatch(/<title>[^<]*小算盘[^<]*<\/title>/);
    expect(index).toMatch(/<h1>[^<]*小算盘[^<]*<\/h1>/);
  });

  it("S2 官网写明不代下单、不收集支付信息", () => {
    expect(index).toContain("不代用户下单");
    expect(index).toContain("不收集");
  });

  it.each(Object.entries(pages))("S3 %s 不含官方品牌词", (_, html) => {
    for (const w of ["拼多多", "多多进宝", "多多客", "Pinduoduo"]) {
      expect(html.toLowerCase()).not.toContain(w.toLowerCase());
    }
  });

  it("S4 回调页没有脚本", () => {
    expect(callback).not.toMatch(/<script/i);
  });

  it.each(Object.entries(pages))("S5 %s 不加载外部资源", (_, html) => {
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
  });

  it("S6 关闭 Jekyll", () => {
    expect(existsSync(join(site, ".nojekyll"))).toBe(true);
  });

  it.each(Object.entries(pages))("S7 %s 适配手机", (_, html) => {
    expect(html).toContain('<meta name="viewport"');
  });
});
