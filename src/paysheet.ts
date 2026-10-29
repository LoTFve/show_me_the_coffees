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

/** 本机 HTML 页：只引用瑞幸的二维码图片，不加载其他外部资源 */
export function renderHtml(entries: PayEntry[]): string {
  const cards = entries
    .map(
      (e, i) => `<section class="card" id="o${i + 1}">
  <div class="head"><span class="n">${i + 1}</span><div><b>${esc(e.label)}</b><div class="muted">订单号 <code>${esc(e.orderId)}</code></div></div><span class="price">¥${e.price.toFixed(2)}</span></div>
  ${e.qrUrl ? `<img src="${esc(e.qrUrl)}" width="240" height="240" alt="第 ${i + 1} 单付款二维码" referrerpolicy="no-referrer">` : '<p class="muted">这单没有返回二维码</p>'}
  ${e.deepLink ? `<a class="btn" href="${esc(e.deepLink)}">在手机上直接付</a>` : ""}
  <label class="done"><input type="checkbox"> 已付</label>
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https://open.lkcoffee.com; style-src 'unsafe-inline'">
<title>付款单 · ${entries.length} 单 · ¥${total(entries)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fafafa; --fg:#111827; --muted:#6b7280; --card:#fff; --line:#e5e7eb; --ok:#059669; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e5e7eb; --muted:#9ca3af; --card:#1a1d24; --line:#2a2f3a; --ok:#34d399; } }
  body { margin:0; font:15px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:16px 16px 4px; } h1 { font-size:19px; margin:0; } .muted { color:var(--muted); font-size:13px; }
  * { box-sizing:border-box; }
  main { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(280px, 100%), 1fr)); gap:14px; padding:12px 16px 32px; }
  .card { min-width:0; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; display:flex; flex-direction:column; align-items:center; gap:10px; }
  .card:has(input:checked) { opacity:.45; }
  .head { display:flex; gap:10px; align-items:center; width:100%; min-width:0; }
  .head > div { min-width:0; overflow-wrap:anywhere; }
  .n { flex:none; width:28px; height:28px; border-radius:50%; background:var(--fg); color:var(--bg); display:grid; place-items:center; font-weight:700; }
  .price { margin-left:auto; font-weight:700; font-size:17px; }
  img { max-width:100%; height:auto; background:#fff; border-radius:8px; padding:8px; image-rendering:pixelated; }
  .btn { display:block; width:100%; text-align:center; padding:10px; border-radius:8px; background:var(--ok); color:#fff; text-decoration:none; font-weight:600; }
  .done { color:var(--muted); font-size:13px; } code { font-family:ui-monospace, Consolas, monospace; font-size:12.5px; }
</style>
</head>
<body>
<header>
  <h1>付款单：${entries.length} 单，合计 ¥${total(entries)}</h1>
  <p class="muted">每单要分别付款。电脑上打开就用手机微信逐个扫码；手机上打开就点"在手机上直接付"。付完一单勾上"已付"，方便看还剩哪几单。</p>
</header>
<main>
${cards}
</main>
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
      e.deepLink ? `- [在手机上直接付](${e.deepLink})` : "",
      e.qrUrl ? `- [打开付款二维码](${e.qrUrl})` : "",
    ]
      .filter((l, j, a) => l || a[j - 1])
      .join("\n"),
  );
  return [
    `# 付款单：${entries.length} 单，合计 ¥${total(entries)}`,
    "",
    "每单要分别付款。在手机飞书里打开，逐个点“在手机上直接付”；点不开就点“打开付款二维码”，长按识别。",
    "",
    "付款链接谁拿到都能替你付这单，不要分享这篇文档。",
    "",
    ...rows,
  ].join("\n");
}
