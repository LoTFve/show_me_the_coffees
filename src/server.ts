import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOKEN_PAGE, type Config } from "./config.js";
import { ConfirmGate, isWriteTool } from "./guard.js";
import { readToken, saveToken, type LocalStore } from "./store.js";
import { isAuthError, type Upstream } from "./upstream.js";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const json = (v: unknown) => ok(JSON.stringify(v, null, 2));
const MAX_BATCH = 20;
const RATE_LIMIT_RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 瑞幸限流：{"code":1000,"msg":"您手速太快啦，稍后重试吧~"} */
const isRateLimited = (text: string) => /手速太快|稍后重试|频繁/.test(text);

/** 从 createOrder 返回里取出订单号和付款链接 */
function payInfo(text: string): string {
  try {
    const d = JSON.parse(text).data ?? {};
    const lines = [`订单号 ${d.orderIdStr ?? d.orderId}`];
    if (d.needPay) {
      if (d.payOrderQrCodeUrl) lines.push(`付款二维码 ${d.payOrderQrCodeUrl}`);
      if (d.payOrderUrl) lines.push(`手机微信打开 ${d.payOrderUrl}`);
    }
    return lines.join("\n");
  } catch {
    return text;
  }
}

/** stoppedAt：出问题那一单的下标；全部成功时等于 total */
function summary(report: string[], total: number, stoppedAt: number, paid: number): string {
  const sum = `合计实付 ¥${paid.toFixed(2)}，订单需按官方返回的方式付款。`;
  const head =
    stoppedAt === total
      ? `全部 ${total} 单已下单，${sum}`
      : `已停止：成功 ${stoppedAt} 单，第 ${stoppedAt + 1} 单未完成，剩余 ${total - stoppedAt - 1} 单未执行。${sum}`;
  return [head, ...report].join("\n\n");
}

const INSTRUCTIONS = `瑞幸点单助手。流程：
1. 先调用 lucky_profile 读取用户的口味偏好、常用门店和收藏，用它补全用户没说的细节（规格、温度、甜度、门店）。
2. 调用 luckin_tools 查看瑞幸官方提供的工具，再用 luckin_call 调用（查门店、菜单、优惠、算价）。
3. 下单/支付/取消等写操作：luckin_call 第一次只返回预览和确认码。必须把商品、规格、门店、金额完整告诉用户，等用户明确说“确认”后，用完全相同的参数加 confirm_code 再调用一次。禁止自行确认。
4. 瑞幸每单只用一张券（previewOrder 自动选券）。多杯时用 luckin_batch 拆成每单 1 杯，并设好每单实付上限。同样先返回计划，用户确认后再带确认码执行。
5. 用户表达新的偏好（如“以后都少冰”）时用 lucky_remember 记下来。`;

export function createServer(deps: {
  config: Config;
  store: LocalStore;
  /** 用 token 建立上游连接 */
  connect: (token: string) => Upstream;
  gate?: ConfirmGate;
  /** 拆单时相邻两单的间隔，避免瑞幸“手速太快”限流 */
  orderGapMs?: number;
  /** 被限流后第 n 次重试前等待 n × rateLimitWaitMs */
  rateLimitWaitMs?: number;
}) {
  const { config, store, connect } = deps;
  const gate = deps.gate ?? new ConfirmGate(config.confirmTtlMs);
  const orderGapMs = deps.orderGapMs ?? 3000;
  const rateLimitWaitMs = deps.rateLimitWaitMs ?? 5000;
  const server = new McpServer({ name: "lucky-agent", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  // token 来源：环境变量优先，其次是用户在对话里通过 luckin_login 保存的
  let upstream: Upstream | undefined;
  const resolve = async () => {
    if (upstream) return;
    const token = config.upstreamToken ?? (await readToken(config.tokenFile));
    if (token) upstream = connect(token);
  };
  const needUpstream = async () => {
    await resolve();
    return upstream
      ? null
      : fail(`还没有瑞幸 Token。请让用户打开 ${TOKEN_PAGE}，手机号登录后复制页面上的 Token 发过来，然后调用 luckin_login 保存。`);
  };

  server.registerTool(
    "luckin_login",
    {
      description: `保存用户的瑞幸 Token（从 ${TOKEN_PAGE} 获取，约一个月过期）。会先连接官方验证，有效才保存到本机。用户在对话里贴出 Token 时调用。`,
      inputSchema: { token: z.string().min(8).describe("用户提供的瑞幸 Token") },
    },
    async ({ token }) => {
      const candidate = connect(token.trim());
      try {
        const tools = await candidate.listTools();
        await saveToken(config.dataDir, config.tokenFile, token.trim());
        upstream = candidate;
        return ok(`Token 有效，已保存到本机（${config.tokenFile}）。官方提供 ${tools.length} 个工具，可以开始点单了。`);
      } catch (e) {
        const msg = (e as Error).message;
        return fail(isAuthError(msg) ? `Token 无效或已过期，没有保存。请让用户到 ${TOKEN_PAGE} 重新登录复制 Token。` : msg);
      }
    },
  );

  server.registerTool(
    "luckin_tools",
    {
      description: "列出瑞幸官方 MCP 提供的工具及参数说明。write=true 的工具会产生真实订单或扣款，调用时需要用户确认。",
      inputSchema: {},
    },
    async () => {
      const missing = await needUpstream();
      if (missing) return missing;
      try {
        const tools = await upstream!.listTools();
        return json(tools.map((t) => ({ ...t, write: isWriteTool(t.name, config.extraWriteTools) })));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "luckin_call",
    {
      description:
        "调用瑞幸官方 MCP 的某个工具。只读工具直接返回结果；写工具（下单、支付、取消）第一次只返回确认码，须用户明确确认后带 confirm_code、用相同参数再调用。",
      inputSchema: {
        tool: z.string().describe("官方工具名，来自 luckin_tools"),
        args: z.record(z.string(), z.unknown()).default({}).describe("官方工具参数"),
        confirm_code: z.string().optional().describe("写操作的确认码，仅在用户明确确认后填写"),
      },
    },
    async ({ tool, args, confirm_code }) => {
      const missing = await needUpstream();
      if (missing) return missing;
      const write = isWriteTool(tool, config.extraWriteTools);

      if (write) {
        if (!confirm_code) {
          const code = gate.issue(tool, args);
          return ok(
            [
              `【待确认】${tool} 是写操作，尚未执行。`,
              `参数：${JSON.stringify(args)}`,
              `请把商品、规格、门店和金额完整告诉用户，等用户明确确认后，用相同参数并带 confirm_code="${code}" 再调用。`,
              `确认码 ${Math.round(config.confirmTtlMs / 60000)} 分钟内有效，仅可使用一次。`,
            ].join("\n"),
          );
        }
        const reason = gate.redeem(confirm_code, tool, args);
        if (reason) return fail(reason);
      }

      try {
        const r = await upstream!.callTool(tool, args);
        if (write) {
          await store.update((d) => {
            d.orders.push({ at: new Date().toISOString(), tool, args, result: r.text.slice(0, 2000) });
          });
        }
        return r.isError ? fail(r.text) : ok(r.text);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  const product = z.object({
    productId: z.number().int(),
    skuCode: z.string(),
    amount: z.number().int().min(1),
  });

  server.registerTool(
    "luckin_batch",
    {
      description:
        "拆单下单：瑞幸每单只用一张券，多杯时拆成多单，每单各用一张。每单执行前先 previewOrder，用它自动选出的 couponCodeList 去 createOrder；实付超过 max_pay_each 或券和前面某单重复就停下。第一次调用只返回计划和确认码，用户确认后用相同参数带 confirm_code 再调用。遇错即停，不自动重试。",
      inputSchema: {
        deptId: z.number().int().describe("门店 ID，来自 queryShopList"),
        longitude: z.number(),
        latitude: z.number(),
        orders: z
          .array(
            z.object({
              label: z.string().optional().describe("给用户看的说明，如“生椰拿铁 大杯 冰”"),
              productList: z.array(product).min(1).describe("这一单的商品，一般每单 1 杯"),
              remark: z.string().optional(),
            }),
          )
          .min(1)
          .max(MAX_BATCH),
        max_pay_each: z.number().positive().describe("每单实付上限（元），超过即停，用来防止券用完后按原价下单"),
        confirm_code: z.string().optional().describe("整批的确认码，仅在用户明确确认后填写"),
      },
    },
    async ({ confirm_code, ...plan }) => {
      const missing = await needUpstream();
      if (missing) return missing;
      const { deptId, longitude, latitude, orders, max_pay_each } = plan;
      const lines = orders.map(
        (o, i) => `  ${i + 1}. ${o.label ?? o.productList.map((p) => `${p.productId}/${p.skuCode}×${p.amount}`).join("，")}`,
      );

      if (!confirm_code) {
        const code = gate.issue("batch", plan);
        return ok(
          [
            `【待确认】将在门店 ${deptId} 依次下 ${orders.length} 单，每单实付不超过 ¥${max_pay_each}，尚未执行：`,
            ...lines,
            "预览时券不会被占用，所以事先算出的价格只是估计：后面几单能不能用上券，要等前面几单下完才知道。",
            `请把计划、每单上限和最多花费 ¥${(max_pay_each * orders.length).toFixed(2)} 告诉用户。用户明确确认后，用相同参数并带 confirm_code="${code}" 再调用。`,
            `确认码 ${Math.round(config.confirmTtlMs / 60000)} 分钟内有效，仅可使用一次。`,
          ].join("\n"),
        );
      }
      const reason = gate.redeem(confirm_code, "batch", plan);
      if (reason) return fail(reason);

      const report: string[] = [];
      const usedCoupons = new Set<string>();
      let paid = 0;
      for (const [i, o] of orders.entries()) {
        const name = `第 ${i + 1} 单${o.label ? `（${o.label}）` : ""}`;
        if (i > 0) await sleep(orderGapMs);
        const stop = (msg: string) => {
          report.push(`${name}：${msg}`);
          return fail(summary(report, orders.length, i, paid));
        };

        let preview: { discountPrice?: number; couponCodeList?: string[] };
        try {
          const r = await upstream!.callTool("previewOrder", { deptId, productList: o.productList });
          if (r.isError) return stop(`预览失败，${r.text}`);
          preview = JSON.parse(r.text).data ?? {};
        } catch (e) {
          return stop(`预览失败，${(e as Error).message}`);
        }
        const price = Number(preview.discountPrice);
        const coupons = preview.couponCodeList ?? [];
        if (!Number.isFinite(price)) return stop("预览没有返回价格，未下单");
        if (price > max_pay_each) return stop(`实付 ¥${price} 超过上限 ¥${max_pay_each}，可能券已用完，未下单`);
        const dup = coupons.find((c) => usedCoupons.has(c));
        if (dup) return stop(`券 ${dup} 已用在前面某单（可能要先付款才会占用），未下单`);

        const args: Record<string, unknown> = { deptId, longitude, latitude, productList: o.productList, couponCodeList: coupons };
        if (o.remark) args.remark = o.remark;
        let r: { text: string; isError: boolean };
        try {
          r = await upstream!.callTool("createOrder", args);
          // 限流时瑞幸明确没有建单，等一会儿重试是安全的
          for (let retry = 0; r.isError && isRateLimited(r.text) && retry < RATE_LIMIT_RETRIES; retry++) {
            await sleep(rateLimitWaitMs * (retry + 1));
            r = await upstream!.callTool("createOrder", args);
          }
        } catch (e) {
          // 网络异常时上游可能已经下单成功，不能盲目重试
          return stop(`结果未知，${(e as Error).message}。可能已下单，请先核实再决定是否补下`);
        }
        await store.update((d) => {
          d.orders.push({ at: new Date().toISOString(), tool: "createOrder", args, result: r.text.slice(0, 2000) });
        });
        if (r.isError) return stop(`下单失败，${r.text}`);
        coupons.forEach((c) => usedCoupons.add(c));
        paid += price;
        report.push(`${name}：成功，实付 ¥${price}${coupons.length ? `，券 ${coupons.join("、")}` : "，未用券"}\n${payInfo(r.text)}`);
      }
      return ok(summary(report, orders.length, orders.length, paid));
    },
  );

  server.registerTool(
    "lucky_profile",
    {
      description: "读取本地保存的口味偏好、常用门店、收藏的饮品，以及最近的下单记录。点单前先调用。",
      inputSchema: { recent_orders: z.number().int().min(0).max(50).default(5) },
    },
    async ({ recent_orders }) => {
      const d = await store.read();
      return json({ ...d, orders: recent_orders ? d.orders.slice(-recent_orders) : [] });
    },
  );

  server.registerTool(
    "lucky_remember",
    {
      description: "保存或删除本地偏好。kind=preference 存口味（如 甜度=少甜）；store 存常用门店别名；favorite 存收藏的一份饮品组合。value 留空表示删除。",
      inputSchema: {
        kind: z.enum(["preference", "store", "favorite"]),
        key: z.string().min(1).describe("偏好名 / 门店别名 / 收藏名"),
        value: z.string().optional().describe("偏好值 / 门店名称 / 饮品描述；留空则删除"),
        store_id: z.string().optional().describe("门店 ID（kind=store 时可填）"),
        items: z.unknown().optional().describe("收藏对应的官方商品参数（kind=favorite 时可填）"),
      },
    },
    async ({ kind, key, value, store_id, items }) => {
      await store.update((d) => {
        if (kind === "preference") {
          if (value) d.preferences[key] = value;
          else delete d.preferences[key];
        } else if (kind === "store") {
          if (value) d.stores[key] = { name: value, ...(store_id ? { storeId: store_id } : {}) };
          else delete d.stores[key];
        } else {
          d.favorites = d.favorites.filter((f) => f.name !== key);
          if (value) d.favorites.push({ name: key, description: value, ...(items !== undefined ? { items } : {}) });
        }
      });
      return ok(value ? `已记住 ${kind}「${key}」` : `已删除 ${kind}「${key}」`);
    },
  );

  return server;
}
