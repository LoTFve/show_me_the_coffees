#!/usr/bin/env node
// 从 docs/luckin-co.md 的 ke 代码块生成 CO 图 docs/luckin-co.html。
// 节点（Concept）和边（返回概念的 Operator）都取自 op 声明，不手写，所以改了 CO 之后重新运行即可同步。
// 用法：node scripts/co-diagram.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Windows 上 git 可能检出成 CRLF，统一成 LF 再解析
const src = readFileSync(join(root, "docs/luckin-co.md"), "utf8").replace(/\r\n/g, "\n");
const ke = [...src.matchAll(/```ke\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");

// 值类型：画成节点里的属性，不画成独立节点
const VALUE = new Set(["String", "Number", "Bool", "Concept", "Time", "DateTime", "Coordinate", "Price"]);
const concepts = [...new Set([...ke.matchAll(/^concept (\w+)/gm)].map((m) => m[1]))].filter((c) => !VALUE.has(c));

// 各 ke 块要自足（SOP 8.1），同一个 op 会在多个块里重复声明，按签名去重
const ops = [];
const seenSig = new Set();
for (const [, name, args, ret] of ke.matchAll(/^op (\w+)\(([^)]*)\) : (.+?) ,?;?$/gm)) {
  const many = /^set\(/.test(ret);
  const type = ret.replace(/^set\((.*)\)$/, "$1");
  const ins = args.split(",").map((s) => s.trim()).filter(Boolean);
  const sig = `${name}(${ins.join(" , ")}) : ${ret}`;
  if (seenSig.has(sig)) continue;
  seenSig.add(sig);
  ops.push({ name, ins, type, many, sig });
}

// 第一个输入是主语；返回概念 → 边，返回值类型 → 主语节点上的属性
const edges = [];
const attrs = Object.fromEntries(concepts.map((c) => [c, []]));
for (const op of ops) {
  const subj = op.ins[0];
  if (!subj || !concepts.includes(subj)) continue;
  if (concepts.includes(op.type)) edges.push({ from: subj, to: op.type, ...op });
  else attrs[subj].push(op);
}

// 手工排布：按点单流程从左到右，四组与 luckin-co.md 第 3 节一致
const GROUPS = [
  { title: "门店", color: "#2563eb", items: ["Store"] },
  { title: "商品与规格", color: "#059669", items: ["Product", "Attribute", "Option", "Sku"] },
  { title: "报价与券", color: "#d97706", items: ["Quote", "Coupon", "OrderLine"] },
  { title: "订单", color: "#dc2626", items: ["Order", "OrderStatus"] },
];
const POS = {
  Store: [130, 380],
  Product: [470, 110], Attribute: [860, 70], Option: [860, 330], Sku: [470, 560],
  Quote: [1260, 170], Coupon: [1600, 380], OrderLine: [860, 720],
  Order: [1260, 600], OrderStatus: [1600, 760],
};
const placed = concepts.filter((c) => POS[c]);
const unplaced = concepts.filter((c) => !POS[c]);
if (unplaced.length) throw new Error(`新概念没有位置，请在 POS 里补上：${unplaced.join(", ")}`);

const groupOf = (c) => GROUPS.find((g) => g.items.includes(c)) ?? { color: "#6b7280", title: "其他" };
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
const W = 200, H = 46;

// ---- 连线布局 ----
// 每条边是一段二次贝塞尔曲线。弯曲度按顺序尝试，取第一个不穿过其他节点的；
// 同一对节点之间的多条边先按序号错开。标签沿曲线挪动，避开节点和已放的标签。
const PAD = 10;
const boxOf = (c) => { const [x, y] = POS[c]; return { x1: x - W / 2 - PAD, y1: y - H / 2 - PAD, x2: x + W / 2 + PAD, y2: y + H / 2 + PAD }; };
const inBox = (p, b) => p[0] > b.x1 && p[0] < b.x2 && p[1] > b.y1 && p[1] < b.y2;
const quad = (a, c, b, t) => [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]];
// 从节点中心朝 toward 方向，求与圆角矩形边框的交点，箭头才能落在框外
const clip = ([x, y], [tx, ty]) => {
  const dx = tx - x, dy = ty - y;
  const s = Math.min((W / 2 + 3) / Math.abs(dx || 1e-9), (H / 2 + 3) / Math.abs(dy || 1e-9));
  return [x + dx * s, y + dy * s];
};
const pairTotal = {};
for (const e of edges) { const k = [e.from, e.to].sort().join("|"); pairTotal[k] = (pairTotal[k] ?? 0) + 1; }
const pairSeen = {};
const labelBoxes = [];
const LW = (s) => s.length * 7 + 10, LH = 16;
const overlaps = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

const svgEdges = edges.map((e, i) => {
  const a = POS[e.from], b = POS[e.to];
  const key = [e.from, e.to].sort().join("|");
  const n = pairTotal[key], k = (pairSeen[key] = (pairSeen[key] ?? 0) + 1) - 1;
  // 方向统一：按字典序较小的节点为起点计算法线，同一对的边才会分到两侧
  const flip = e.from > e.to ? -1 : 1;
  const base = (k - (n - 1) / 2) * 70 * flip;
  const others = placed.filter((c) => c !== e.from && c !== e.to).map(boxOf);
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  const ctrl = (bend) => [mx - (dy / len) * bend, my + (dx / len) * bend];
  let c = ctrl(base);
  for (const extra of [0, 90, -90, 160, -160, 240, -240, 320, -320]) {
    const cand = ctrl(base + extra);
    const hit = [...Array(41).keys()].some((j) => others.some((bx) => inBox(quad(a, cand, b, j / 40), bx)));
    if (!hit) { c = cand; break; }
  }
  const p0 = clip(a, c), p2 = clip(b, c);
  const label = `${e.many ? "多" : "单"} · ${e.name}`;
  let lp = quad(a, c, b, 0.5);
  for (const t of [0.5, 0.4, 0.6, 0.32, 0.68, 0.25, 0.75]) {
    const p = quad(a, c, b, t), w = LW(label);
    const box = { x1: p[0] - w / 2, y1: p[1] - LH + 4, x2: p[0] + w / 2, y2: p[1] + 4 };
    if (!labelBoxes.some((o) => overlaps(o, box)) && !placed.map(boxOf).some((o) => overlaps(o, box))) { lp = p; labelBoxes.push(box); break; }
    if (t === 0.75) labelBoxes.push(box);
  }
  return `<g class="edge" data-from="${e.from}" data-to="${e.to}" data-i="${i}">
    <path d="M ${p0[0].toFixed(1)} ${p0[1].toFixed(1)} Q ${c[0].toFixed(1)} ${c[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}" class="${e.many ? "many" : "one"}" marker-end="url(#${e.many ? "arrMany" : "arrOne"})"/>
    <text x="${lp[0].toFixed(1)}" y="${lp[1].toFixed(1)}" class="elabel">${esc(label)}</text></g>`;
});

const svgNodes = placed.map((c) => {
  const [x, y] = POS[c], g = groupOf(c);
  return `<g class="node" data-c="${c}" tabindex="0" role="button" aria-label="${c}，${attrs[c].length} 个属性">
    <rect x="${x - W / 2}" y="${y - H / 2}" width="${W}" height="${H}" rx="10" style="--c:${g.color}"/>
    <text x="${x}" y="${y + 5}" class="nlabel">${c}</text></g>`;
});

const detail = Object.fromEntries(placed.map((c) => [c, {
  group: groupOf(c).title,
  out: edges.filter((e) => e.from === c).map((e) => e.sig),
  in: edges.filter((e) => e.to === c && e.from !== c).map((e) => e.sig),
  attrs: attrs[c].map((o) => o.sig),
}]));

const legend = GROUPS.map((g) => `<span class="chip" style="--c:${g.color}">${g.title}</span>`).join("");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>瑞幸点单 CO 图</title>
<style>
  :root { color-scheme: light dark; --bg:#fafafa; --fg:#111827; --muted:#6b7280; --line:#9ca3af; --card:#fff; --hl:#111827; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e5e7eb; --muted:#9ca3af; --line:#6b7280; --card:#1a1d24; --hl:#f9fafb; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:16px 24px 8px; }
  h1 { margin:0 0 4px; font-size:20px; }
  .sub { color:var(--muted); margin:0; }
  .legend { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:8px 24px; }
  .chip { border-left:4px solid var(--c); padding:2px 10px; background:var(--card); border-radius:4px; }
  .key { color:var(--muted); margin-left:8px; }
  .key b { color:var(--fg); font-weight:600; }
  main { display:grid; grid-template-columns: 1fr 340px; gap:16px; padding:8px 24px 24px; }
  @media (max-width: 1000px) { main { grid-template-columns: 1fr; } }
  .canvas { background:var(--card); border-radius:12px; overflow:auto; }
  svg { display:block; width:100%; height:auto; min-width:1000px; }
  .node rect { fill:var(--card); stroke:var(--c); stroke-width:2.5; cursor:pointer; }
  .node:focus { outline:none; }
  .node:focus rect, .node.on rect { stroke-width:4; fill:color-mix(in srgb, var(--c) 14%, var(--card)); }
  .nlabel { text-anchor:middle; font-weight:600; font-size:15px; fill:var(--fg); pointer-events:none; }
  .edge path { fill:none; stroke:var(--line); stroke-width:1.6; }
  .edge path.many { stroke-dasharray:6 4; }
  .elabel { font-size:11.5px; fill:var(--muted); text-anchor:middle; paint-order:stroke; stroke:var(--card); stroke-width:4px; }
  .dim .edge, .dim .node { opacity:.18; }
  .dim .edge.on, .dim .node.on, .dim .node.near { opacity:1; }
  .edge.on path { stroke:var(--hl); stroke-width:2.4; }
  .edge.on .elabel { fill:var(--fg); font-weight:600; }
  aside { background:var(--card); border-radius:12px; padding:16px; align-self:start; position:sticky; top:12px; }
  aside h2 { margin:0 0 2px; font-size:17px; }
  aside h3 { margin:14px 0 4px; font-size:13px; color:var(--muted); font-weight:600; }
  aside ul { margin:0; padding-left:0; list-style:none; }
  aside li { font:12.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; padding:3px 0; border-bottom:1px solid color-mix(in srgb, var(--line) 25%, transparent); word-break:break-all; }
  .empty { color:var(--muted); }
  footer { color:var(--muted); padding:0 24px 24px; font-size:12.5px; }
  code { font-family: ui-monospace, Consolas, monospace; }
</style>
</head>
<body>
<header>
  <h1>瑞幸点单 CO 图</h1>
  <p class="sub">由 <code>docs/luckin-co.md</code> 自动生成：${placed.length} 个 Concept、${ops.length} 个 Operator（其中 ${edges.length} 个返回概念，画成连线；其余是值属性）。状态：候选，见原文第 5 节缺口。</p>
</header>
<div class="legend">${legend}
  <span class="key"><b>框</b> Concept　<b>连线</b> Operator（<b>实线</b> 单值，<b>虚线</b> 多值）　点概念看它的全部 Operator，再点空白处取消</span>
</div>
<main>
  <div class="canvas">
    <svg id="g" viewBox="0 0 1730 820" role="img" aria-label="瑞幸点单 Concept 与 Operator 图">
      <defs>
        <marker id="arrOne" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor" style="color:var(--line)"/></marker>
        <marker id="arrMany" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="none" stroke="currentColor" style="color:var(--line)"/></marker>
      </defs>
      ${svgEdges.join("\n      ")}
      ${svgNodes.join("\n      ")}
    </svg>
  </div>
  <aside id="side" aria-live="polite">
    <h2>点一个概念</h2>
    <p class="empty">右侧会列出它的出边、入边和值属性，每条都是 <code>luckin-co.md</code> 里的原始 Operator 签名。</p>
  </aside>
</main>
<footer>重新生成：<code>node scripts/co-diagram.mjs</code>。改了 CO 的 Operator 声明后运行一次即可同步，不要手工编辑本文件。</footer>
<script>
const D = ${JSON.stringify(detail)};
const svg = document.getElementById("g"), side = document.getElementById("side");
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const list = (t, xs) => "<h3>" + t + "（" + xs.length + "）</h3>" + (xs.length ? "<ul>" + xs.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : '<p class="empty">无</p>');
function pick(c) {
  svg.classList.toggle("dim", !!c);
  svg.querySelectorAll(".on,.near").forEach((n) => n.classList.remove("on", "near"));
  if (!c) { side.innerHTML = '<h2>点一个概念</h2><p class="empty">右侧会列出它的出边、入边和值属性。</p>'; return; }
  svg.querySelector('.node[data-c="' + c + '"]').classList.add("on");
  svg.querySelectorAll(".edge").forEach((e) => {
    if (e.dataset.from === c || e.dataset.to === c) {
      e.classList.add("on");
      svg.querySelector('.node[data-c="' + (e.dataset.from === c ? e.dataset.to : e.dataset.from) + '"]').classList.add("near");
    }
  });
  const d = D[c];
  side.innerHTML = "<h2>" + c + "</h2><p class='empty'>" + d.group + "</p>" + list("指向其他概念", d.out) + list("被其他概念指向", d.in) + list("值属性", d.attrs);
}
svg.addEventListener("click", (ev) => { const n = ev.target.closest(".node"); const c = n ? n.dataset.c : null; history.replaceState(null, "", c ? "#" + c : location.pathname); pick(c); });
// 链接里带 #概念名 时直接选中，方便在文档里链接到某个概念
if (D[location.hash.slice(1)]) pick(location.hash.slice(1));
svg.addEventListener("keydown", (ev) => { const n = ev.target.closest(".node"); if (n && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); pick(n.dataset.c); } if (ev.key === "Escape") pick(null); });
</script>
</body>
</html>
`;

writeFileSync(join(root, "docs/luckin-co.html"), html);
console.log(`docs/luckin-co.html：${placed.length} 个 Concept，${ops.length} 个 Operator（${edges.length} 个返回概念）`);
