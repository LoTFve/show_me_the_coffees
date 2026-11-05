// 付款单：拆单后每单都要单独付款，把多单的付款入口集中到一处。
// 两种格式：本机 HTML 页（二维码排成一列，用手机扫）和 Markdown（导入飞书文档，在手机上点链接）。

export interface PayEntry {
  orderId: string;
  label: string;
  price: number;
  /** 瑞幸返回的二维码图片地址（https，返回 image/png） */
  qrUrl?: string;
  /** 手机上打开直接跳到微信付款（weixin://） */
  deepLink?: string;
  storeName?: string;
  at: string;
}

/** 从 createOrder 的返回里取付款信息；不需要付款或解析失败时返回 null */
export function payEntryOf(text: string, label: string, price: number, storeName?: string): PayEntry | null {
  try {
    const d = JSON.parse(text).data ?? {};
    const orderId = String(d.orderIdStr ?? d.orderId ?? "");
    if (!orderId || !d.needPay) return null;
    return {
      orderId,
      label,
      price: Number(d.discountPrice ?? price),
      // 只收预期的协议和域名，避免把别的链接写进付款单
      qrUrl: typeof d.payOrderQrCodeUrl === "string" && d.payOrderQrCodeUrl.startsWith("https://open.lkcoffee.com/") ? d.payOrderQrCodeUrl : undefined,
      deepLink: typeof d.payOrderUrl === "string" && d.payOrderUrl.startsWith("weixin://wxpay/") ? d.payOrderUrl : undefined,
      storeName,
      at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const total = (es: PayEntry[]) => es.reduce((s, e) => s + e.price, 0).toFixed(2);

/**
 * 付款时限（分钟）。瑞幸不返回付款截止时间，这是实测估计：2026-11-03 两次拆单，
 * 下单约 5 分钟后未付款的单都被自动取消（App 待付款页显示倒计时）。
 */
export const PAY_WINDOW_MIN = 5;

/** 按北京时间显示 HH:MM；时间无效时返回空串 */
const hhmm = (ms: number) =>
  Number.isNaN(ms)
    ? ""
    : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));

/** 下单时刻和估计的付款截止时刻 */
export const payTimes = (iso: string) => {
  const at = new Date(iso).getTime();
  return { orderedAt: hhmm(at), deadline: hhmm(at + PAY_WINDOW_MIN * 60_000) };
};

/** 一批单里最早的截止时刻（第一单最先过期） */
export function earliestDeadline(entries: PayEntry[]): string {
  const first = entries.map((e) => new Date(e.at).getTime()).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b)[0];
  return first === undefined ? "" : hhmm(first + PAY_WINDOW_MIN * 60_000);
}

/** 本机 HTML 页：只引用瑞幸的二维码图片，不加载其他外部资源 */
export function renderHtml(entries: PayEntry[]): string {
  const cards = entries
    .map((e, i) => {
      const { orderedAt: at, deadline } = payTimes(e.at);
      return `<section class="card" id="o${i + 1}">
  <div class="head"><span class="nth">第 ${i + 1} 单</span><span class="price">¥${e.price.toFixed(2)}</span></div>
  <div class="label">${esc(e.label)}</div>
  ${e.qrUrl ? `<img src="${esc(e.qrUrl)}" width="240" height="240" alt="第 ${i + 1} 单付款二维码" referrerpolicy="no-referrer">` : '<p class="muted">这单没有返回二维码</p>'}
  ${at ? `<div class="at">${at} 下单，<b>约 ${deadline} 前付款</b>，超时瑞幸会自动取消</div>` : ""}
  ${e.deepLink ? `<a class="btn" href="${esc(e.deepLink)}">在手机上直接付</a>` : ""}
  <div class="foot"><span class="muted">订单号 <code>${esc(e.orderId)}</code></span><label class="done"><input type="checkbox"> 已付</label></div>
</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https://open.lkcoffee.com; style-src 'unsafe-inline'">
<title>分 ${entries.length} 单付款 · ${entries.length} 单，合计 ¥${total(entries)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f3f4f6; --fg:#111827; --muted:#6b7280; --card:#fff; --line:#e5e7eb; --brand:#2563eb; --ok:#07c160; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e5e7eb; --muted:#9ca3af; --card:#1a1d24; --line:#2a2f3a; --brand:#60a5fa; --ok:#07c160; } }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background:var(--bg); color:var(--fg); }
  .sheet { max-width:820px; margin:20px auto; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:20px; }
  .tag { display:inline-block; background:var(--brand); color:#fff; font-weight:700; font-size:14px; padding:3px 14px; border-radius:999px; }
  header { display:flex; align-items:flex-end; gap:12px; margin-top:12px; }
  h1 { font-size:20px; margin:0; }
  .sum { margin-left:auto; font-size:34px; font-weight:800; line-height:1; white-space:nowrap; }
  .sum small { font-size:16px; font-weight:700; margin-right:2px; }
  .sub { color:var(--muted); margin:4px 0 16px; }
  main { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(300px, 100%), 1fr)); gap:16px; }
  .card { min-width:0; border:1px solid var(--line); border-radius:14px; padding:14px 16px; display:flex; flex-direction:column; align-items:center; gap:8px; }
  .card:has(input:checked) { opacity:.45; }
  .head { display:flex; align-items:baseline; width:100%; }
  .nth { color:var(--muted); }
  .price { margin-left:auto; font-weight:800; font-size:22px; }
  .label { width:100%; font-size:13.5px; overflow-wrap:anywhere; }
  img { width:100%; max-width:240px; height:auto; background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px; image-rendering:pixelated; }
  .at { color:var(--brand); font-weight:600; font-size:14px; text-align:center; }
  .warn { color:#dc2626; }
  .btn { display:block; width:100%; text-align:center; padding:10px; border-radius:8px; background:var(--ok); color:#fff; text-decoration:none; font-weight:600; }
  .foot { display:flex; width:100%; align-items:center; gap:8px; }
  .done { margin-left:auto; color:var(--muted); font-size:13px; white-space:nowrap; }
  .muted { color:var(--muted); font-size:12.5px; min-width:0; overflow-wrap:anywhere; }
  code { font-family:ui-monospace, Consolas, monospace; }
  footer { text-align:center; margin-top:16px; }
  footer p { margin:6px 0; } footer .muted { font-size:14px; }
</style>
</head>
<body>
<div class="sheet">
  <span class="tag">瑞幸咖啡</span>
  <header>
    <h1>分 ${entries.length} 单付款</h1>
    <div class="sum"><small>¥</small>${total(entries)}</div>
  </header>
  <p class="sub">每单一个码，各自扫一次${earliestDeadline(entries) ? `。<b class="warn">下单后约 ${PAY_WINDOW_MIN} 分钟内要付完，最早一单约 ${earliestDeadline(entries)} 截止</b>` : ""}</p>
  <main>
${cards}
  </main>
  <footer>
    <p>用 <b>微信</b> 扫码付款；在手机上打开就点"在手机上直接付"</p>
    <p class="muted">付款即确认，下单约 ${PAY_WINDOW_MIN} 分钟内未付款会被瑞幸自动取消（时限是实测估计，瑞幸不返回截止时间）。付完一单勾上"已付"，方便看还剩哪几单。</p>
  </footer>
</div>
</body>
</html>
`;
}

/** Markdown：导入飞书文档后在手机上逐个点开 */
export function renderMarkdown(entries: PayEntry[]): string {
  const rows = entries.map((e, i) =>
    [
      `## 第 ${i + 1} 单：${e.label}，¥${e.price.toFixed(2)}`,
      "",
      `订单号 \`${e.orderId}\``,
      "",
      payTimes(e.at).orderedAt ? `**${payTimes(e.at).orderedAt} 下单，约 ${payTimes(e.at).deadline} 前付款**，超时瑞幸会自动取消` : "",
      "",
      e.deepLink ? `- [在手机上直接付](${e.deepLink})` : "",
      e.qrUrl ? `- [打开付款二维码](${e.qrUrl})` : "",
    ]
      .filter((l, j, a) => l || a[j - 1])
      .join("\n"),
  );
  return [
    `# 付款单：${entries.length} 单，合计 ¥${total(entries)}`,
    "",
    `每单要分别付款，**下单后约 ${PAY_WINDOW_MIN} 分钟内要付完**${earliestDeadline(entries) ? `（最早一单约 ${earliestDeadline(entries)} 截止）` : ""}，超时瑞幸会自动取消。在手机飞书里打开，逐个点“在手机上直接付”；点不开就点“打开付款二维码”，长按识别。`,
    "",
    "付款链接谁拿到都能替你付这单，不要分享这篇文档。",
    "",
    ...rows,
  ].join("\n");
}
