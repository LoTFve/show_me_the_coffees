const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let data = null;

async function call(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `请求失败 ${r.status}`), { status: r.status });
  return j;
}
function say(text, ok = false) { $("#msg").innerHTML = text ? `<div class="msg ${ok ? "ok" : "bad"}">${esc(text)}</div>` : ""; }

async function boot() {
  try {
    const me = await call("GET", "/api/me");
    $("#who").textContent = `成员：${me.name}`;
    $("#logout").hidden = false; $("#login").hidden = true; $("#app").hidden = false;
    await reload();
  } catch (e) {
    if (e.status !== 401) throw e;
    $("#login").hidden = false; $("#app").hidden = true; $("#logout").hidden = true;
  }
}

async function reload() {
  data = await call("GET", "/api/ontology");
  $("#ver").textContent = `第 ${data.version} 版 · ${data.concepts.length} 个概念、${data.operators.length} 个算子、${data.options.length} 个选项`;
  renderOptions(); renderOperators(); renderConcepts(); await renderChanges();
}

function renderOptions() {
  const attrName = Object.fromEntries(data.attributes.map((a) => [a.id, a.name]));
  const rows = data.options.map((o) => `<tr data-ref="${esc(o.ref)}">
    <td class="mono">${esc(o.ref)}</td><td>${esc(attrName[o.attribute])}</td><td><b>${esc(o.name)}</b></td>
    <td><div class="chips">${o.aliases.map((a) => `<span class="chip">${esc(a)}</span>`).join("") || '<span class="muted">—</span>'}</div></td>
    <td>${o.extraPrice ? "+¥" + esc(o.extraPrice) : '<span class="muted">—</span>'}</td><td class="muted">${esc(o.seenIn)}</td>
    <td><button class="act" data-edit>改别名</button> <button class="act danger" data-del>删除</button></td></tr>`).join("");
  $('[data-panel="options"]').innerHTML = `
    <div class="card"><p class="muted" style="margin-top:0">选项用 <code>属性/选项</code> 引用（属性和选项的 ID 会撞号，比如 112）。别名是口语说法，对所有用户都成立；一个别名只能指向一个选项，保存时服务器会检查。</p>
    <table><thead><tr><th>引用</th><th>属性</th><th>正名</th><th>别名</th><th>加价</th><th>见于</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="card"><h3 style="margin-top:0">新增选项</h3>
    <form id="addForm" class="row">
      <select name="attribute" required>${data.attributes.map((a) => `<option value="${a.id}">${a.id} ${esc(a.name)}</option>`).join("")}</select>
      <input name="id" type="number" min="1" placeholder="选项 ID" required style="width:110px">
      <input name="name" placeholder="正名（官方名称）" required>
      <input name="aliases" placeholder="别名，用顿号分隔">
      <input name="extraPrice" type="number" min="0" step="0.5" placeholder="加价" style="width:90px">
      <input name="seenIn" placeholder="在哪款商品上见到" required>
      <button class="act primary" type="submit">新增</button>
    </form></div>`;
}

function renderOperators() {
  const groups = {};
  for (const op of data.operators) (groups[op.kind] ??= []).push(op);
  const order = ["属性", "带参数的属性", "谓词", "二元关系", "多元关系、变换", "通用算子"];
  $('[data-panel="operators"]').innerHTML = order.filter((k) => groups[k]).map((k) => `
    <div class="card"><h3 style="margin-top:0">${esc(k)}（${groups[k].length}）</h3>
    <table><thead><tr><th>算子</th><th>签名</th><th>所在小节</th></tr></thead><tbody>
    ${groups[k].map((op) => `<tr><td class="mono">${esc(op.name)}</td><td class="mono">${esc(op.name)}(${esc(op.inputs.join(" , "))}) : ${op.many ? `set(${esc(op.output)})` : esc(op.output)}</td><td class="muted">${esc(op.section)}</td></tr>`).join("")}
    </tbody></table></div>`).join("") + `<p class="muted">算子目前只读。改算子要改 <code>docs/luckin-co.md</code> 的签名和依据，走 PR。</p>`;
}

function renderConcepts() {
  const ops = data.operators;
  $('[data-panel="concepts"]').innerHTML = `<div class="card"><table><thead><tr><th>概念</th><th>分组</th><th>语义角色</th><th>身份依据</th><th>输入它的算子</th><th>返回它的算子</th></tr></thead><tbody>
    ${data.concepts.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.group)}</td><td>${esc(c.role)}</td><td class="mono">${esc(c.identity)}</td>
    <td>${ops.filter((o) => o.inputs[0] === c.name).length}</td><td>${ops.filter((o) => o.output === c.name).length}</td></tr>`).join("")}
    </tbody></table></div>`;
}

async function renderChanges() {
  const list = await call("GET", "/api/changes?limit=100");
  const fmt = (c) => c.action === "add_option" ? `新增 ${c.ref} ${c.after.name}` : c.action === "delete_option" ? `删除 ${c.ref} ${c.before.name}`
    : `修改 ${c.ref}：别名 ${c.before.aliases.join("、") || "无"} → ${c.after.aliases.join("、") || "无"}`;
  $('[data-panel="changes"]').innerHTML = `<div class="card">${list.length ? `<table><thead><tr><th>时间</th><th>版本</th><th>成员</th><th>改动</th></tr></thead><tbody>
    ${list.map((c) => `<tr><td class="muted">${esc(c.at.replace("T", " ").slice(0, 19))}</td><td>${c.version}</td><td>${esc(c.member)}</td><td>${esc(fmt(c))}</td></tr>`).join("")}</tbody></table>`
    : '<p class="muted">还没有改动。</p>'}
    <p class="muted">改完后点 <a href="/api/export">导出 JSON</a>，替换仓库里的 <code>ontology/luckin.json</code> 提 PR。合并后插件才会用上。</p></div>`;
}

document.addEventListener("click", async (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) {
    document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b === tab));
    document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
    return;
  }
  const row = e.target.closest("tr[data-ref]");
  if (!row) return;
  const ref = row.dataset.ref; const opt = data.options.find((o) => o.ref === ref);
  try {
    if (e.target.matches("[data-edit]")) {
      const v = prompt(`「${opt.name}」的别名，用顿号分隔`, opt.aliases.join("、"));
      if (v === null) return;
      await call("PUT", `/api/options/${ref}`, { aliases: v.split(/[、,，]/).map((s) => s.trim()).filter(Boolean), baseVersion: data.version });
      say(`已更新 ${ref} 的别名`, true);
    } else if (e.target.matches("[data-del]")) {
      if (!confirm(`删除选项 ${ref}「${opt.name}」？偏好里引用它的条目会变成失效。`)) return;
      await call("DELETE", `/api/options/${ref}`, { confirm: true, baseVersion: data.version });
      say(`已删除 ${ref}`, true);
    } else return;
    await reload();
  } catch (err) { say(err.message); }
});

document.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.target.id === "loginForm") {
    try { await call("POST", "/api/login", { token: $("#token").value }); $("#token").value = ""; $("#loginMsg").innerHTML = ""; await boot(); }
    catch (err) { $("#loginMsg").innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; }
  } else if (e.target.id === "addForm") {
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await call("POST", "/api/options", { ...f, aliases: f.aliases ? f.aliases.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : [], extraPrice: f.extraPrice || 0 });
      say(`已新增 ${f.attribute}/${f.id}`, true); await reload();
    } catch (err) { say(err.message); }
  }
});

$("#logout").addEventListener("click", async () => { await call("POST", "/api/logout"); await boot(); });
boot();
