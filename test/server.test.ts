import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConfirmGate, isWriteTool } from "../src/guard.js";
import { createServer } from "../src/server.js";
import { LocalStore } from "../src/store.js";
import type { Upstream } from "../src/upstream.js";

/** 模拟瑞幸：previewOrder 自动挑一张券（不占用），createOrder 才消耗券 */
class FakeUpstream implements Upstream {
  calls: Array<[string, Record<string, unknown>]> = [];
  coupons: string[] = [];
  /** 第 n 次 createOrder（从 1 起）返回业务错误 / 抛网络异常 */
  errorOn?: number;
  throwOn?: number;
  /** 第 n 次 createOrder 返回限流（只限流一次） */
  rateLimitOn?: number;
  /** 下单后不消耗券（模拟未付款不占券） */
  sticky = false;
  private creates = 0;
  async listTools() {
    return [
      { name: "queryShopList", inputSchema: {} },
      { name: "createOrder", inputSchema: {} },
    ];
  }
  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push([name, args]);
    if (name === "previewOrder") {
      const c = this.coupons[0];
      const data = { discountPrice: c ? 10.9 : 20, couponCodeList: c ? [c] : [] };
      return { text: JSON.stringify({ code: 0, success: true, data }), isError: false };
    }
    if (name === "createOrder") {
      this.creates++;
      if (this.creates === this.rateLimitOn) return { text: '{"code":1000,"msg":"您手速太快啦，稍后重试吧~","success":false}', isError: true };
      if (this.creates === this.throwOn) throw new Error("timeout");
      if (this.creates === this.errorOn) return { text: '{"code":1000,"msg":"券已失效","success":false}', isError: true };
      const used = (args.couponCodeList as string[] | undefined)?.[0];
      if (used && !this.sticky) this.coupons = this.coupons.filter((c) => c !== used);
      const data = { orderIdStr: `7701${this.creates}`, needPay: true, payOrderQrCodeUrl: "https://pay/qr", payOrderUrl: "weixin://pay" };
      return { text: JSON.stringify({ code: 0, success: true, data }), isError: false };
    }
    return { text: `ok:${name}`, isError: false };
  }
  creates_() {
    return this.calls.filter(([n]) => n === "createOrder");
  }
}

const text = (r: any) => r.content[0].text as string;

describe("lucky-agent", () => {
  let dir: string;
  let client: Client;
  let up: FakeUpstream;
  let clock: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucky-"));
    up = new FakeUpstream();
    clock = 0;
    const config = { ...loadConfig({ LUCKIN_MCP_TOKEN: "env-token" }), dataDir: dir, confirmTtlMs: 1000 };
    const server = createServer({
      config,
      store: new LocalStore(dir),
      connect: () => up,
      gate: new ConfirmGate(1000, () => clock),
      orderGapMs: 0,
      rateLimitWaitMs: 0,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "t", version: "0" });
    await client.connect(b);
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("classifies tools", () => {
    expect(isWriteTool("create_order")).toBe(true);
    expect(isWriteTool("pay")).toBe(true);
    expect(isWriteTool("query_order")).toBe(false);
    expect(isWriteTool("createOrder")).toBe(true);
    expect(isWriteTool("cancelOrder")).toBe(true);
    expect(isWriteTool("previewOrder")).toBe(false);
    expect(isWriteTool("queryOrderDetailInfo")).toBe(false);
    expect(isWriteTool("order_list")).toBe(false);
    expect(isWriteTool("menu", ["menu"])).toBe(true);
  });

  it("marks write tools in listing", async () => {
    const r = JSON.parse(text(await client.callTool({ name: "luckin_tools", arguments: {} })));
    expect(r.map((t: any) => t.write)).toEqual([false, true]);
  });

  it("passes read tools straight through", async () => {
    const r = await client.callTool({ name: "luckin_call", arguments: { tool: "queryShopList", args: { longitude: 1, latitude: 2 } } });
    expect(text(r)).toBe("ok:queryShopList");
    expect(up.calls).toHaveLength(1);
  });

  it("requires confirmation with identical args for writes", async () => {
    const args = { tool: "createOrder", args: { storeId: "1", items: [{ id: "a", qty: 1 }] } };
    const preview = text(await client.callTool({ name: "luckin_call", arguments: args }));
    expect(up.calls).toHaveLength(0);
    const code = preview.match(/confirm_code="(\w+)"/)![1];

    const tampered = await client.callTool({
      name: "luckin_call",
      arguments: { ...args, args: { ...args.args, storeId: "2" }, confirm_code: code },
    });
    expect(tampered.isError).toBe(true);
    expect(up.calls).toHaveLength(0);

    const done = await client.callTool({ name: "luckin_call", arguments: { ...args, confirm_code: code } });
    expect(JSON.parse(text(done)).data.orderIdStr).toBe("77011");
    expect(up.calls).toHaveLength(1);

    // 一次性
    const again = await client.callTool({ name: "luckin_call", arguments: { ...args, confirm_code: code } });
    expect(again.isError).toBe(true);

    const profile = JSON.parse(text(await client.callTool({ name: "lucky_profile", arguments: {} })));
    expect(profile.orders).toHaveLength(1);
  });

  it("expires confirm codes", async () => {
    const args = { tool: "createOrder", args: {} };
    const code = text(await client.callTool({ name: "luckin_call", arguments: args })).match(/confirm_code="(\w+)"/)![1];
    clock = 1001;
    const r = await client.callTool({ name: "luckin_call", arguments: { ...args, confirm_code: code } });
    expect(r.isError).toBe(true);
    expect(up.calls).toHaveLength(0);
  });

  const batch = (n: number, max_pay_each = 15) => ({
    deptId: 613648,
    longitude: 116.46,
    latitude: 39.9,
    max_pay_each,
    orders: Array.from({ length: n }, () => ({
      label: "生椰拿铁 大杯 冰",
      productList: [{ productId: 1262, skuCode: "SP2077-01134", amount: 1 }],
    })),
  });
  const codeOf = (r: any) => text(r).match(/confirm_code="(\w+)"/)![1];
  const run = async (b: ReturnType<typeof batch>) => {
    const code = codeOf(await client.callTool({ name: "luckin_batch", arguments: b }));
    return client.callTool({ name: "luckin_batch", arguments: { ...b, confirm_code: code } });
  };

  it("batch: one confirmation, each order uses the coupon preview picked", async () => {
    up.coupons = Array.from({ length: 10 }, (_, i) => `SY${i}`);
    const b = batch(10);
    const preview = await client.callTool({ name: "luckin_batch", arguments: b });
    expect(text(preview)).toContain("依次下 10 单");
    expect(up.calls).toHaveLength(0);

    const r = await client.callTool({ name: "luckin_batch", arguments: { ...b, confirm_code: codeOf(preview) } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("全部 10 单已下单，合计实付 ¥109.00");
    expect(up.creates_().map(([, a]) => (a.couponCodeList as string[])[0])).toEqual(Array.from({ length: 10 }, (_, i) => `SY${i}`));

    const p = JSON.parse(text(await client.callTool({ name: "lucky_profile", arguments: { recent_orders: 50 } })));
    expect(p.orders).toHaveLength(10);
  });

  it("batch: stops before ordering at full price when coupons run out", async () => {
    up.coupons = ["SY0", "SY1", "SY2"];
    const r = await run(batch(5));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("成功 3 单，第 4 单未完成，剩余 1 单未执行");
    expect(text(r)).toContain("超过上限");
    expect(text(r)).toContain("领券");
    expect(up.creates_()).toHaveLength(3);
  });

  it("batch: refuses to reuse a coupon that was not consumed", async () => {
    up.coupons = ["SY0", "SY1"];
    up.sticky = true;
    const r = await run(batch(3));
    expect(text(r)).toContain("已用在前面某单");
    expect(up.creates_()).toHaveLength(1);
  });

  it("batch: changed plan invalidates the code", async () => {
    const code = codeOf(await client.callTool({ name: "luckin_batch", arguments: batch(3) }));
    const r = await client.callTool({ name: "luckin_batch", arguments: { ...batch(3, 25), confirm_code: code } });
    expect(r.isError).toBe(true);
    expect(up.calls).toHaveLength(0);
  });

  it("batch: stops at the first business error", async () => {
    up.coupons = Array.from({ length: 5 }, (_, i) => `SY${i}`);
    up.errorOn = 3;
    const r = await run(batch(5));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("成功 2 单，第 3 单未完成，剩余 2 单未执行");
    expect(up.creates_()).toHaveLength(3);
  });

  it("batch: retries when rate limited and returns pay links", async () => {
    up.coupons = Array.from({ length: 5 }, (_, i) => `SY${i}`);
    up.rateLimitOn = 2;
    const r = await run(batch(5));
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("全部 5 单已下单");
    // 第 2 单限流一次后重试成功：共 6 次 createOrder
    expect(up.creates_()).toHaveLength(6);
    expect(text(r)).toContain("订单号 7701");
    expect(text(r)).toContain("付款二维码 https://pay/qr");
  });

  it("batch: network error is reported as unknown, not retried", async () => {
    up.coupons = ["SY0", "SY1", "SY2"];
    up.throwOn = 2;
    const r = await run(batch(3));
    expect(text(r)).toContain("可能已下单");
    expect(up.creates_()).toHaveLength(2);
  });

  it("batch: rejects oversized batches", async () => {
    const big = await client.callTool({ name: "luckin_batch", arguments: batch(21) });
    expect(big.isError).toBe(true);
    expect(up.calls).toHaveLength(0);
  });

  it("remembers and forgets preferences", async () => {
    await client.callTool({ name: "lucky_remember", arguments: { kind: "preference", key: "甜度", value: "少甜" } });
    await client.callTool({ name: "lucky_remember", arguments: { kind: "store", key: "公司", value: "瑞幸 XX 大厦店", store_id: "123" } });
    await client.callTool({ name: "lucky_remember", arguments: { kind: "favorite", key: "老样子", value: "生椰拿铁 大杯 少冰" } });
    let p = JSON.parse(text(await client.callTool({ name: "lucky_profile", arguments: {} })));
    expect(p.preferences).toEqual({ 甜度: "少甜" });
    expect(p.stores.公司.storeId).toBe("123");
    expect(p.favorites[0].name).toBe("老样子");

    await client.callTool({ name: "lucky_remember", arguments: { kind: "preference", key: "甜度" } });
    p = JSON.parse(text(await client.callTool({ name: "lucky_profile", arguments: {} })));
    expect(p.preferences).toEqual({});
  });

  /** 没有环境变量 token 的服务端；connect 记录收到的 token，"bad" 视为无效 */
  const noEnvClient = async (tokens: string[]) => {
    const config = { ...loadConfig({}), dataDir: dir, tokenFile: join(dir, "token") };
    const server = createServer({
      config,
      store: new LocalStore(dir),
      connect: (t) => {
        tokens.push(t);
        if (!t.startsWith("bad")) return up;
        return { listTools: async () => Promise.reject(new Error("访问令牌无效或已过期")), callTool: async () => ({ text: "", isError: true }) };
      },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(b);
    return c;
  };

  it("asks for a token with the official link when none is set", async () => {
    const c = await noEnvClient([]);
    const r = await c.callTool({ name: "luckin_tools", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("open.lkcoffee.com/mcp");
    expect(text(r)).toContain("luckin_login");
  });

  it("login validates, saves, and is reused after restart", async () => {
    const tokens: string[] = [];
    const c = await noEnvClient(tokens);
    const r = await c.callTool({ name: "luckin_login", arguments: { token: "  good-token-123  " } });
    expect(text(r)).toContain("Token 有效");
    expect((await readFile(join(dir, "token"), "utf8"))).toBe("good-token-123");

    // 新进程：从文件读 token
    const seen: string[] = [];
    const c2 = await noEnvClient(seen);
    const t = await c2.callTool({ name: "luckin_tools", arguments: {} });
    expect(t.isError).toBeFalsy();
    expect(seen).toEqual(["good-token-123"]);
  });

  it("login rejects an invalid token without saving it", async () => {
    const c = await noEnvClient([]);
    const r = await c.callTool({ name: "luckin_login", arguments: { token: "bad-token-123" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("open.lkcoffee.com/mcp");
    await expect(readFile(join(dir, "token"), "utf8")).rejects.toThrow();
  });
});
