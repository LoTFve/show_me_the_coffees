import { describe, expect, it } from "vitest";
import { payEntryOf, renderHtml, renderMarkdown } from "../src/paysheet.js";

const order = (n: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    code: 0,
    success: true,
    data: {
      orderIdStr: `770199286665687860${n}`,
      needPay: true,
      discountPrice: 9.9,
      payOrderQrCodeUrl: `https://open.lkcoffee.com/transfer/qrcode?token=t${n}`,
      payOrderUrl: `weixin://wxpay/bizpayurl?pr=p${n}`,
      ...extra,
    },
  });

describe("payEntryOf", () => {
  it("takes the order id, price and both pay links", () => {
    expect(payEntryOf(order(1), "全冰黑巧美式", 9.9)).toMatchObject({
      orderId: "7701992866656878601",
      price: 9.9,
      qrUrl: "https://open.lkcoffee.com/transfer/qrcode?token=t1",
      deepLink: "weixin://wxpay/bizpayurl?pr=p1",
    });
  });

  it("skips orders that do not need payment", () => {
    expect(payEntryOf(order(1, { needPay: false }), "x", 0)).toBeNull();
  });

  it("drops links that are not Luckin's QR page or a WeChat pay link", () => {
    const e = payEntryOf(order(1, { payOrderQrCodeUrl: "https://evil.example/qr", payOrderUrl: "javascript:alert(1)" }), "x", 9.9)!;
    expect(e.qrUrl).toBeUndefined();
    expect(e.deepLink).toBeUndefined();
  });

  it("returns null on unparseable responses", () => {
    expect(payEntryOf("not json", "x", 1)).toBeNull();
  });
});

describe("renderHtml", () => {
  const entries = [1, 2, 3].map((n) => payEntryOf(order(n), `第 ${n} 杯`, 9.9)!);

  it("lists every order with its QR code, deep link and total", () => {
    const html = renderHtml(entries);
    expect(html).toContain("3 单，合计 ¥29.70");
    for (const n of [1, 2, 3]) {
      expect(html).toContain(`token=t${n}`);
      expect(html).toContain(`pr=p${n}`);
    }
  });

  it("loads nothing except Luckin's QR images and runs no scripts", () => {
    const html = renderHtml(entries);
    expect(html).toContain("default-src 'none'; img-src https://open.lkcoffee.com");
    expect(html).not.toMatch(/<script/i);
  });

  it("follows the design: split-order header, per-order card, WeChat, no made-up countdown", () => {
    const html = renderHtml(entries);
    expect(html).toContain("分 3 单付款");
    expect(html).toContain("每单一个码，各自扫一次");
    expect(html).toContain("第 3 单");
    expect(html).toContain("付款即确认，未付款会自动取消");
    // 码是微信付款码：只提微信，不提支付宝或瑞幸 App
    expect(html).toContain("用 <b>微信</b> 扫码付款");
    expect(html).not.toMatch(/支付宝|瑞幸 App/);
    // 瑞幸不返回付款截止时间，不显示“剩 mm:ss”这类倒计时
    expect(html).not.toMatch(/剩\s*\d/);
  });

  it("shows the order time in Beijing time", () => {
    const e = { ...entries[0], at: "2026-11-02T09:56:30.000Z" };
    expect(renderHtml([e])).toContain("17:56 下单，请尽快付款");
  });

  it("escapes labels", () => {
    const html = renderHtml([payEntryOf(order(1), "<img src=x onerror=alert(1)>", 9.9)!]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("renderMarkdown", () => {
  it("gives one section per order with clickable links and a sharing warning", () => {
    const md = renderMarkdown([1, 2].map((n) => payEntryOf(order(n), `第 ${n} 杯`, 9.9)!));
    expect(md).toContain("# 付款单：2 单，合计 ¥19.80");
    expect(md).toContain("## 第 2 单：第 2 杯，¥9.90");
    expect(md).toContain("[在手机上直接付](weixin://wxpay/bizpayurl?pr=p1)");
    expect(md).toContain("[打开付款二维码](https://open.lkcoffee.com/transfer/qrcode?token=t2)");
    expect(md).toContain("不要分享这篇文档");
  });
});
