import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOKEN_PAGE, type Config } from "./config.js";
import { ConfirmGate, isWriteTool } from "./guard.js";
import { readToken, saveToken, type LocalStore } from "./store.js";
import { isAuthError, type Upstream } from "./upstream.js";
import { PAY_WINDOW_MIN, earliestDeadline, payEntryOf, renderHtml, renderMarkdown, type PayEntry } from "./paysheet.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { searchPlace, type Fetch } from "./amap.js";
import { SessionStore, type Slot } from "./session.js";
import { envelope } from "./envelope.js";
import { parseStores, parseProducts, parseQuote, isOpen } from "./luckin.js";

const AMAP_KEY_PAGE = "https://console.amap.com/dev/key/app";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const json = (v: unknown) => ok(JSON.stringify(v, null, 2));
const MAX_BATCH = 20;
const RATE_LIMIT_RETRIES = 3;
// 官方接口不能领券，只能提醒用户自己去领
const CLAIM_HINT = "请提醒用户去瑞幸 App 或微信小程序领券（首页活动或“我的 → 优惠券”），领完后重新预览，剩下的几杯接着下。";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAYSHEET_HINT =
  "多单要分别付款。可以调用 luckin_paysheet 把付款入口集中起来：format=html 生成本机网页（手机扫码），format=markdown 生成可以导入飞书文档的内容（手机上点链接）。先问用户要哪种。";
/** 瑞幸限流：{"code":1000,"msg":"您手速太快啦，稍后重试吧~"} */
const isRateLimited = (text: string) => /手速太快|稍后重试|频繁/.test(text);
/** 瑞幸未付款订单上限（实测 3 单，见 AGENTS.md）。超过时 createOrder 被拒 */
const MAX_UNPAID = 3;
/** 命中“您有未支付订单，请先支付后再下新单” */
const isTooManyUnpaid = (text: string) => /未支付订单|先支付后再下/.test(text);
/** queryOrderDetailInfo 里 orderStatus=10 为待付款（实测）；非 10 视为已腾出未付款名额 */
const STATUS_UNPAID = 10;

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

const INSTRUCTIONS = `瑞幸点单助手。流程：
1. 先调用 lucky_profile 读取用户的口味偏好、常用门店和收藏，用它补全用户没说的细节（规格、温度、甜度、门店）。
2. 调用 luckin_tools 查看瑞幸官方提供的工具，再用 luckin_call 调用（查门店、菜单、优惠、算价）。
3. 下单/支付/取消等写操作：luckin_call 第一次只返回预览和确认码。必须把商品、规格、门店、金额完整告诉用户，等用户明确说“确认”后，用完全相同的参数加 confirm_code 再调用一次。禁止自行确认。
4. 瑞幸每单只用一张券（previewOrder 自动选券）。多杯时用 luckin_batch 拆成每单 1 杯，并设好每单实付上限。同样先返回计划，用户确认后再带确认码执行。拆单下完后，用 luckin_paysheet 把多单的付款入口集中起来，先问用户要本机网页还是飞书文档。
   下单后约 5 分钟内不付款，瑞幸会自动取消。报价和确认计划时就告诉用户这个时限；下单成功后回复的第一句写明"请在约 HH:MM 前付完"（工具返回的第一行），再给付款入口。
5. 用户表达新的偏好（如“以后都少冰”）时用 lucky_remember 记下来。
6. 用户问“附近”“离我最近”时，不知道用户在哪就先问；用户说出地标后用 locate 换成经纬度，再查门店。不要把常用门店当成用户的位置。`;

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
  /** 请求高德用的 fetch，测试时替换 */
  fetch?: Fetch;
  /** 会话表，测试时替换（可注入确定性的 id 生成器） */
  sessions?: SessionStore;
}) {
  const { config, store, connect } = deps;
  const gate = deps.gate ?? new ConfirmGate(config.confirmTtlMs);
  const orderGapMs = deps.orderGapMs ?? 3000;
  const rateLimitWaitMs = deps.rateLimitWaitMs ?? 5000;
  const server = new McpServer({ name: "lucky-agent", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const sessions = deps.sessions ?? new SessionStore();

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

  // 契约骨架（spec §5）：luckin_start 起步、luckin_resolve_order 落槽位。
  // 这两个工具只维护本地会话状态，不调用官方接口、不建外部单。
  const slotInput = z.object({
    value: z.unknown(),
    source: z
      .enum(["utterance", "session", "authorized_default", "history", "product_default"])
      .describe("取值来源：用户原话 / 本会话 / 授权默认 / 历史 / 产品默认"),
    evidence_span: z.string().optional().describe("用户原话里支撑这个取值的片段"),
    certainty: z.number().min(0).max(1).optional(),
    needs_confirmation: z.boolean().optional(),
  });

  // 建单前的必填槽位（spec §3）。品牌固定为瑞幸，这一支不问。
  const REQUIRED_SLOTS = ["fulfillment", "store", "items"] as const;

  const envText = (env: ReturnType<typeof envelope>) => json(env);

  server.registerTool(
    "luckin_start",
    {
      description:
        "开始一次点单会话，或在用户改需求时重新起步。传入用户本轮原话，返回 session_id、revision 和当前状态。之后用 luckin_resolve_order 按槽位落地。",
      inputSchema: { utterance: z.string().min(1).describe("用户本轮原话") },
    },
    async ({ utterance }) => {
      const s = sessions.start(utterance);
      return envText(
        envelope(s, {
          missing: [...REQUIRED_SLOTS],
          reply_must_show_user: [],
          fallback_markdown: "开始点单。先告诉我想喝什么、送到哪里还是自取，几杯。",
        }),
      );
    },
  );

  server.registerTool(
    "luckin_resolve_order",
    {
      description:
        "把你对用户的理解按槽位落到会话里。常见槽位：fulfillment（外送/自取）、address、store、time、count、items（饮品和规格）、budget_cents、restriction（忌口/约束）。authorization 传入用户授予的授权范围。会更新 revision；传 expected_revision 做并发校验。返回 resolved/ambiguous/missing 和当前 state。不调用官方接口、不建单。",
      inputSchema: {
        session_id: z.string(),
        expected_revision: z.number().int().optional().describe("并发校验：与当前 revision 不符则拒绝，返回 REVISION_CONFLICT"),
        slots: z.record(z.string(), slotInput).default({}).describe("按槽位名传入的理解"),
        authorization: z
          .object({
            select_items: z.boolean().optional(),
            auto_substitute: z.boolean().optional(),
            allow_split: z.boolean().optional(),
            prepare_unpaid_order: z.boolean().optional(),
            max_total_cents: z.number().int().positive().optional(),
          })
          .optional()
          .describe("用户授予的授权范围；pay 不开放，永远由本人付款"),
      },
    },
    async ({ session_id, expected_revision, slots, authorization }) => {
      const result = sessions.revise(session_id, expected_revision, (s) => {
        for (const [key, raw] of Object.entries(slots)) {
          s.slots[key] = raw as Slot;
        }
        if (authorization) {
          const a = s.authorization;
          for (const [k, v] of Object.entries(authorization)) {
            if (v !== undefined) (a as unknown as Record<string, unknown>)[k] = v;
          }
        }
        const missing = REQUIRED_SLOTS.filter((k) => s.slots[k] === undefined);
        s.state = missing.length ? "collecting" : "items_ready";
      });
      if ("error" in result) {
        return fail(JSON.stringify({ error: result.error, detail: result.detail, current_revision: result.current }));
      }
      const s = result.session;
      const missing = REQUIRED_SLOTS.filter((k) => s.slots[k] === undefined);
      return envText(
        envelope(s, {
          slots: s.slots,
          missing,
          authorization: s.authorization,
          reply_must_show_user: [],
        }),
      );
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
        if (r.isError) return fail(r.text);
        // 单独 createOrder 成功也要把付款时限放在最前面
        const entry = tool === "createOrder" ? payEntryOf(r.text, "", 0) : null;
        const deadline = entry ? earliestDeadline([entry]) : "";
        return ok(
          deadline
            ? `⚠ 请在约 ${deadline} 前付款（下单后约 ${PAY_WINDOW_MIN} 分钟内不付，瑞幸会自动取消；时限是实测估计）。\n\n${r.text}`
            : r.text,
        );
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

  // 契约支线的查询工具（spec §5）：查门店、查菜单、核价。只读，不建单。
  server.registerTool(
    "luckin_find_store",
    {
      description:
        "按经纬度查附近瑞幸门店（官方 queryShopList）。经纬度用 locate 把地标换来，和瑞幸同一坐标系。只返回营业中的门店给用户选；选定后用 luckin_resolve_order 把 store 槽位填成 { deptId, longitude, latitude }。不建单。",
      inputSchema: {
        longitude: z.number(),
        latitude: z.number(),
        include_closed: z.boolean().default(false).describe("是否也返回打烊的门店，默认只返回营业中的"),
      },
    },
    async ({ longitude, latitude, include_closed }) => {
      const missing = await needUpstream();
      if (missing) return missing;
      try {
        const r = await upstream!.callTool("queryShopList", { longitude, latitude });
        if (r.isError) return fail(r.text);
        const stores = parseStores(r.text).filter((s) => include_closed || isOpen(s));
        if (!stores.length) return fail("附近没有营业中的瑞幸门店。可以让用户换个地标，或用 include_closed 看打烊的门店。");
        return json({ stores, note: "把门店名和距离列给用户选；选定后用 luckin_resolve_order 填 store 槽位" });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "luckin_get_menu",
    {
      description:
        "在指定门店按关键词搜商品（官方 searchProductForMcp）。返回商品及默认 sku、原价、券后预估价。fallback=true 表示没精确命中、是兜底推荐。选定后用 luckin_resolve_order 把 items 槽位填成官方 productList（每项 { productId, skuCode, amount }）。不建单。",
      inputSchema: {
        deptId: z.number().int().describe("门店 ID，来自 luckin_find_store"),
        query: z.string().min(1).describe("用户原始查询文本，如“拿铁”“生椰”"),
      },
    },
    async ({ deptId, query }) => {
      const missing = await needUpstream();
      if (missing) return missing;
      try {
        const r = await upstream!.callTool("searchProductForMcp", { deptId, query });
        if (r.isError) return fail(r.text);
        const products = parseProducts(r.text);
        if (!products.length) return fail(`门店 ${deptId} 没搜到“${query}”。可以让用户换个说法。`);
        return json({ products, note: "券后预估价仅供参考，实际以 luckin_quote_best 为准" });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "luckin_quote_best",
    {
      description:
        "核价：对会话里已确定的门店和商品调官方 previewOrder，返回券后实付、原价、优惠和自动选中的券码。只核价、不建单、不占券（券在 createOrder 后才占用）。会话要先到 items_ready（store 和 items 槽位齐全）。返回里带 state、revision。",
      inputSchema: {
        session_id: z.string(),
        expected_revision: z.number().int().optional().describe("并发校验：与当前 revision 不符返回 REVISION_CONFLICT"),
      },
    },
    async ({ session_id, expected_revision }) => {
      const missing = await needUpstream();
      if (missing) return missing;
      const s = sessions.get(session_id);
      if (!s) return fail(JSON.stringify({ error: "SESSION_NOT_FOUND", detail: `找不到会话 ${session_id}` }));
      if (expected_revision !== undefined && expected_revision !== s.revision) {
        return fail(JSON.stringify({ error: "REVISION_CONFLICT", detail: "订单已被改过", current_revision: s.revision }));
      }
      if (s.state !== "items_ready") {
        const miss = ["fulfillment", "store", "items"].filter((k) => s.slots[k] === undefined);
        return fail(JSON.stringify({ error: "CONSTRAINT_UNSAT", detail: `还缺槽位：${miss.join("、")}`, missing: miss }));
      }
      const storeSlot = s.slots.store?.value as { deptId?: number } | undefined;
      const items = s.slots.items?.value;
      const deptId = storeSlot?.deptId;
      if (typeof deptId !== "number") {
        return fail(JSON.stringify({ error: "CONSTRAINT_UNSAT", detail: "store 槽位缺 deptId，请先 luckin_find_store 再 resolve_order" }));
      }
      const parsed = z.array(product).min(1).safeParse(items);
      if (!parsed.success) {
        return fail(JSON.stringify({ error: "CONSTRAINT_UNSAT", detail: "items 槽位不是合法的官方 productList（每项 { productId, skuCode, amount }）" }));
      }
      try {
        const r = await upstream!.callTool("previewOrder", { deptId, productList: parsed.data });
        if (r.isError) return fail(r.text);
        const quote = parseQuote(r.text);
        // 透传核价结果；拆单比价留到后续步骤
        return json({ ...envelope(s, { reply_must_show_user: ["quote"] }), quote });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 最近一批拆单里待付款的单。只存在内存里：付款链接谁拿到都能付，不写进下单记录之外的地方
  let pending: PayEntry[] = [];

  type BatchOrder = { label?: string; productList: z.infer<typeof product>[]; remark?: string };
  type BatchPlan = { deptId: number; longitude: number; latitude: number; orders: BatchOrder[]; max_pay_each: number };

  type ExecResult = {
    /** 已成功下单的数量 */
    placed: number;
    /** 这一批的待付款单 */
    entries: PayEntry[];
    /** 逐单文字说明 */
    report: string[];
    /** 本批已成功单的实付合计 */
    paid: number;
    /** 命中未付款上限而停下（可在腾出名额后续下剩余单） */
    hitUnpaidCap: boolean;
    /** 其他原因停下的说明；正常走完为空 */
    stoppedReason?: string;
  };

  /**
   * 拆单执行：依次 previewOrder → createOrder，每单各用一张券。
   * 已成功下单达到 unpaidBudget（当前未付款名额）时停下，标记 hitUnpaidCap；
   * 命中“您有未支付订单”也同样停下（名额估计偏乐观时的兜底）。
   * 实付超上限或券重复就停。限流自动退避重试，网络异常不盲目重试（可能已下单）。
   * 只执行，不渲染最终文案；调用方据 ExecResult 组织回复。会把本批待付款单写进 pending。
   */
  async function executeBatch(
    deptId: number,
    longitude: number,
    latitude: number,
    orders: BatchOrder[],
    maxPayEach: number,
    unpaidBudget: number,
  ): Promise<ExecResult> {
    const report: string[] = [];
    const usedCoupons = new Set<string>();
    const entries: PayEntry[] = [];
    let paid = 0;
    let placed = 0;
    for (const [i, o] of orders.entries()) {
      if (placed >= unpaidBudget) {
        return { placed, entries, report, paid, hitUnpaidCap: true };
      }
      const name = `第 ${i + 1} 单${o.label ? `（${o.label}）` : ""}`;
      if (i > 0) await sleep(orderGapMs);
      const stop = (msg: string): ExecResult => {
        report.push(`${name}：${msg}`);
        return { placed, entries, report, paid, hitUnpaidCap: false, stoppedReason: msg };
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
      if (price > maxPayEach) {
        const hint = coupons.length ? "可能能用的券已经用完" : `券已用完。${CLAIM_HINT}`;
        return stop(`实付 ¥${price} 超过上限 ¥${maxPayEach}，${hint}，未下单`);
      }
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
      // 名额估计偏乐观时的兜底：瑞幸明确说未付款单已满，没有建单，安全地停下续后
      if (r.isError && isTooManyUnpaid(r.text)) {
        return { placed, entries, report, paid, hitUnpaidCap: true };
      }
      await store.update((d) => {
        d.orders.push({ at: new Date().toISOString(), tool: "createOrder", args, result: r.text.slice(0, 2000) });
      });
      if (r.isError) return stop(`下单失败，${r.text}`);
      coupons.forEach((c) => usedCoupons.add(c));
      paid += price;
      placed++;
      const entry = payEntryOf(r.text, o.label ?? `第 ${i + 1} 单`, price);
      if (entry) entries.push(entry);
      report.push(`${name}：成功，实付 ¥${price}${coupons.length ? `，券 ${coupons.join("、")}` : "，未用券"}\n${payInfo(r.text)}`);
    }
    return { placed, entries, report, paid, hitUnpaidCap: false };
  }

  /**
   * 把一次执行结果渲染成给用户的文字，并把本批待付款单写进 pending（供 luckin_paysheet）。
   * total 是整批计划的单数，remainingAfter 是这次之后还没下的单数。
   */
  function renderExec(res: ExecResult, total: number, remainingAfter: number) {
    pending = res.entries;
    const sum = `合计实付 ¥${res.paid.toFixed(2)}，订单需按官方返回的方式付款。`;
    let head: string;
    if (res.hitUnpaidCap && remainingAfter > 0) {
      head = `已下 ${res.placed} 单（瑞幸未付款单最多 ${MAX_UNPAID} 单）。还剩 ${remainingAfter} 单没下：请先付掉已下的单，再调用 luckin_wait_payment 自动续下剩余的。${sum}`;
    } else if (res.stoppedReason) {
      head = `已停止：成功 ${res.placed} 单，第 ${res.placed + 1} 单未完成，剩余 ${remainingAfter - 1} 单未执行。${sum}`;
    } else {
      head = `全部 ${total} 单已下单，${sum}`;
    }
    // 付款时限放在第一行：用户最容易错过的就是这个
    const deadline = earliestDeadline(res.entries);
    const urgent = deadline
      ? `⚠ 请在约 ${deadline} 前付完（下单后约 ${PAY_WINDOW_MIN} 分钟内不付，瑞幸会自动取消；时限是实测估计）。`
      : "";
    const body = [urgent, head, ...res.report].filter(Boolean).join("\n\n");
    const hint = res.entries.length > (remainingAfter > 0 ? 0 : 1) ? `\n\n${PAYSHEET_HINT}` : "";
    return res.stoppedReason ? fail(body + hint) : ok(body + hint);
  }

  server.registerTool(
    "luckin_prepare_checkout",
    {
      description:
        "契约支线唯一的建单入口（spec §5）：对 items_ready 的会话建待付款单，复用拆单逻辑（每单一张券，限流退避，防重）。授权 prepare_unpaid_order=true 时直接建单（付款本身即确认）；未授权时第一次只返回确认码，用户确认后带 confirm_code 再调。拆单下完用 luckin_paysheet 汇总付款入口。",
      inputSchema: {
        session_id: z.string(),
        expected_revision: z.number().int().optional().describe("并发校验：与当前 revision 不符返回 REVISION_CONFLICT"),
        confirm_code: z.string().optional().describe("未授权 prepare_unpaid_order 时的确认码，用户明确确认后填"),
      },
    },
    async ({ session_id, expected_revision, confirm_code }) => {
      const miss = await needUpstream();
      if (miss) return miss;
      const s = sessions.get(session_id);
      if (!s) return fail(JSON.stringify({ error: "SESSION_NOT_FOUND", detail: `找不到会话 ${session_id}` }));
      if (expected_revision !== undefined && expected_revision !== s.revision) {
        return fail(JSON.stringify({ error: "REVISION_CONFLICT", detail: "订单已被改过", current_revision: s.revision }));
      }
      if (s.state !== "items_ready") {
        const need = ["fulfillment", "store", "items"].filter((k) => s.slots[k] === undefined);
        return fail(JSON.stringify({ error: "CONSTRAINT_UNSAT", detail: `还缺槽位：${need.join("、")}`, missing: need }));
      }
      const storeSlot = s.slots.store?.value as { deptId?: number; longitude?: number; latitude?: number } | undefined;
      const deptId = storeSlot?.deptId;
      const longitude = storeSlot?.longitude;
      const latitude = storeSlot?.latitude;
      if (typeof deptId !== "number" || typeof longitude !== "number" || typeof latitude !== "number") {
        return fail(JSON.stringify({ error: "CONSTRAINT_UNSAT", detail: "store 槽位需含 deptId、longitude、latitude（来自 luckin_find_store）" }));
      }
      const parsed = z.array(product).min(1).safeParse(s.slots.items?.value);
      if (!parsed.success) {
        return fail(JSON.stringify({ error: "CONSTRAINT_UNSAT", detail: "items 槽位不是合法的官方 productList（每项 { productId, skuCode, amount }）" }));
      }
      // 每单 1 杯拆单（spec §5：瑞幸每单只用一张券）。授权上限换算成每单上限。
      const orders: BatchOrder[] = parsed.data
        .flatMap((p) => Array.from({ length: p.amount }, () => ({ productList: [{ ...p, amount: 1 }] })))
        .map((o, i) => ({ ...o, label: `第 ${i + 1} 单` }));
      const auth = s.authorization;
      // 每单上限：有总额授权就平摊，否则用一个宽松上限（防止券用完按原价下单仍挡得住明显异常）
      const maxEach = auth.max_total_cents ? auth.max_total_cents / 100 / orders.length : 9999;
      const plan: BatchPlan = { deptId, longitude, latitude, orders, max_pay_each: maxEach };

      if (!auth.prepare_unpaid_order) {
        if (!confirm_code) {
          const code = gate.issue("prepare_checkout", plan);
          return fail(
            JSON.stringify({
              error: "NEEDS_CONFIRM",
              detail: `将在门店 ${deptId} 建 ${orders.length} 单待付款（每单 1 杯）。请把商品、门店、预估金额告诉用户，用户明确确认后带 confirm_code="${code}" 再调一次。或在 resolve_order 里授权 prepare_unpaid_order=true 直接建单。`,
              confirm_code: code,
              order_count: orders.length,
            }),
          );
        }
        const reason = gate.redeem(confirm_code, "prepare_checkout", plan);
        if (reason) return fail(JSON.stringify({ error: "CONFIRM_INVALID", detail: reason }));
      }
      // 先下满当前未付款名额；剩余的记进 job，等付款腾出名额后由 luckin_wait_payment 续下
      const res = await executeBatch(deptId, longitude, latitude, orders, maxEach, MAX_UNPAID);
      const placedOrders = orders.slice(0, res.placed);
      const remaining = orders.slice(res.placed);
      s.checkout = {
        deptId,
        longitude,
        latitude,
        maxPayEach: maxEach,
        placed: res.entries.map((e) => ({ orderId: e.orderId, label: e.label })),
        remaining: remaining.map((o) => ({ productList: o.productList, label: o.label! })),
      };
      return renderExec(res, orders.length, remaining.length);
    },
  );

  server.registerTool(
    "luckin_wait_payment",
    {
      description:
        "分批拆单时，等用户付掉已下的单、腾出未付款名额后，自动续下剩余的单。有界等待：单次最多轮询约 25 秒，期间每隔几秒查一次已下单的付款状态；一旦腾出名额就续下剩余单。返回已下/剩余单数和付款入口。还有剩余时可重复调用。没有进行中的拆单任务时返回提示。",
      inputSchema: {
        session_id: z.string(),
        max_wait_seconds: z.number().int().min(1).max(60).default(25).describe("本次最多等待的秒数，默认 25"),
      },
    },
    async ({ session_id, max_wait_seconds }) => {
      const miss = await needUpstream();
      if (miss) return miss;
      const s = sessions.get(session_id);
      if (!s) return fail(JSON.stringify({ error: "SESSION_NOT_FOUND", detail: `找不到会话 ${session_id}` }));
      const job = s.checkout;
      if (!job) return fail("没有进行中的拆单任务。先用 luckin_prepare_checkout 建单。");
      if (!job.remaining.length) return ok("所有单都已下完，没有剩余要续下的。请付掉未付款的单。");

      // 查一单付款状态；orderStatus≠10（非待付款）视为已腾出名额
      const settledCount = async (): Promise<number> => {
        let settled = 0;
        for (const p of job.placed) {
          if (p.settled) {
            settled++;
            continue;
          }
          try {
            const r = await upstream!.callTool("queryOrderDetailInfo", { orderId: p.orderId });
            if (!r.isError) {
              const st = Number(JSON.parse(r.text).data?.orderStatus);
              if (Number.isFinite(st) && st !== STATUS_UNPAID) {
                p.settled = true;
                settled++;
              }
            }
          } catch {
            // 查询失败就当这单仍未付款，不冒进续单
          }
        }
        return settled;
      };

      const deadline = Date.now() + max_wait_seconds * 1000;
      const pollGap = Math.max(orderGapMs, 3000);
      // 轮询直到腾出名额或超时
      let budget = 0;
      for (;;) {
        const settled = await settledCount();
        const unpaid = job.placed.length - settled;
        budget = MAX_UNPAID - unpaid;
        if (budget > 0) break;
        if (Date.now() + pollGap >= deadline) {
          return ok(
            `还在等付款：已下 ${job.placed.length} 单都未付款，还剩 ${job.remaining.length} 单没下。付掉已下的单后再调用 luckin_wait_payment 续下。`,
          );
        }
        await sleep(pollGap);
      }

      // 腾出了 budget 个名额，续下剩余单
      const toPlace = job.remaining.slice(0, budget).map((o, i) => ({
        productList: o.productList as z.infer<typeof product>[],
        label: o.label || `续第 ${i + 1} 单`,
      }));
      const res = await executeBatch(job.deptId, job.longitude, job.latitude, toPlace, job.maxPayEach, budget);
      // 更新 job：把这次下成功的移出 remaining，加进 placed
      job.placed.push(...res.entries.map((e) => ({ orderId: e.orderId, label: e.label })));
      job.remaining = job.remaining.slice(res.placed);
      return renderExec(res, res.placed, job.remaining.length);
    },
  );

  server.registerTool(
    "luckin_paysheet",
    {
      description:
        "把最近一次 luckin_batch 拆单的付款入口集中到一处，方便连续付款。format=html：在本机生成网页，二维码排成一列，返回文件路径，手机微信逐个扫。format=markdown：返回 Markdown，可以用飞书的导入文档工具建成文档，在手机上逐个点链接。不会自动发给任何人。",
      inputSchema: { format: z.enum(["html", "markdown"]).describe("html 本机网页；markdown 给飞书文档用") },
    },
    async ({ format }) => {
      if (!pending.length) return fail("没有待付款的拆单。先用 luckin_batch 下单。");
      const sum = pending.reduce((s, e) => s + e.price, 0).toFixed(2);
      if (format === "markdown") return ok(renderMarkdown(pending));
      const dir = join(config.dataDir, "paysheets");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `paysheet-${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
      await writeFile(file, renderHtml(pending), { encoding: "utf8", mode: 0o600 });
      return ok(`已生成付款单：${pending.length} 单，合计 ¥${sum}。\n文件：${file}\n打开：${pathToFileURL(file).href}\n用浏览器打开后，用手机微信逐个扫码付款。`);
    },
  );

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
            `每单下单后约 ${PAY_WINDOW_MIN} 分钟内要付款，超时瑞幸会自动取消（实测估计）。确认前告诉用户这个时限，让用户准备好微信再确认。`,
            `请把计划、每单上限和最多花费 ¥${(max_pay_each * orders.length).toFixed(2)} 告诉用户。用户明确确认后，用相同参数并带 confirm_code="${code}" 再调用。`,
            `确认码 ${Math.round(config.confirmTtlMs / 60000)} 分钟内有效，仅可使用一次。`,
          ].join("\n"),
        );
      }
      const reason = gate.redeem(confirm_code, "batch", plan);
      if (reason) return fail(reason);
      // 旧的拆单工具没有续单路径，按原行为连续下所有单；真实命中未付款上限时
      // executeBatch 仍会安全停下（isTooManyUnpaid 兜底）。名额分批续单走 prepare_checkout。
      const res = await executeBatch(deptId, longitude, latitude, orders, max_pay_each, orders.length);
      return renderExec(res, orders.length, orders.length - res.placed);
    },
  );

  // 高德 Key：环境变量优先，其次是用户在对话里通过 amap_setup 保存的
  const amapKey = async () => config.amapKey ?? (await readToken(config.amapKeyFile));
  const AMAP_SETUP_HINT =
    `还没有高德 Key。请让用户到 ${AMAP_KEY_PAGE} 注册登录，创建应用并添加一个“Web服务”类型的 Key，复制后发过来，再调用 amap_setup 保存。`;

  server.registerTool(
    "amap_setup",
    {
      description: `保存高德 Web 服务 Key（在 ${AMAP_KEY_PAGE} 创建，类型选“Web服务”）。会先用它试搜一次，有效才保存到本机。用户在对话里贴出 Key 时调用。`,
      inputSchema: { key: z.string().regex(/^[0-9a-f]{32}$/i, "高德 Key 是 32 位字母和数字").describe("用户提供的高德 Key") },
    },
    async ({ key }) => {
      try {
        await searchPlace(key, "天安门", { limit: 1, fetch: deps.fetch });
      } catch (e) {
        return fail(`${(e as Error).message}，没有保存。请确认 Key 的类型是“Web服务”。`);
      }
      await saveToken(config.dataDir, config.amapKeyFile, key);
      return ok(`高德 Key 有效，已保存到本机（${config.amapKeyFile}）。以后用户说地标就能查附近门店。`);
    },
  );

  server.registerTool(
    "locate",
    {
      description:
        "把用户说的地标或地址换成经纬度（高德，和瑞幸门店同一坐标系）。用户问“附近”“离我最近”时，先问用户在哪，用户说出地点后再调用；不要拿常用门店当作用户的位置。返回多个候选时，把候选列给用户选，不要自己挑。选定后把经纬度传给 queryShopList。坐标只用来查门店，不保存。",
      inputSchema: {
        place: z.string().min(1).max(80).describe("用户说的地标或地址，如“高新银泰”“科大高新校区”"),
        city: z.string().max(20).optional().describe("城市，如“合肥”。用户说了城市，或从常用门店能确定城市时传，避免搜到外地同名地点"),
      },
    },
    async ({ place, city }) => {
      const key = await amapKey();
      if (!key) return fail(AMAP_SETUP_HINT);
      try {
        const places = await searchPlace(key, place, { city, limit: 5, fetch: deps.fetch });
        if (!places.length) return fail(`高德没找到“${place}”${city ? `（${city}）` : ""}。请让用户换个说法，或者说得更具体些，比如加上城市或路名。`);
        return json({
          note: places.length > 1 ? "有多个候选，请把名称和地址列给用户选" : "只有一个候选，向用户确认一下再查门店",
          places,
        });
      } catch (e) {
        return fail((e as Error).message);
      }
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
