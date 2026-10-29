#!/usr/bin/env node
// 本体库总服务器：团队成员浏览和编辑瑞幸点单本体库。不存用户数据，不依赖第三方包。
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findOption, operatorKind, optionRef, validateOntology } from "./lib/ontology.mjs";
import { memberByToken, membersFile, readMembers } from "./members.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.CO_HOST || "127.0.0.1";
const PORT = Number(process.env.CO_PORT) || 8790;
const DATA = process.env.CO_DATA || join(here, "data", "luckin.json");
const LOG = join(dirname(DATA), "changes.jsonl");
const SEED = join(here, "..", "ontology", "luckin.json");
const MAX_BODY = 64 * 1024;
const COOKIE = "co_session";

// ---------- 数据 ----------
mkdirSync(dirname(DATA), { recursive: true });
if (!existsSync(DATA)) copyFileSync(SEED, DATA);
let onto = JSON.parse(readFileSync(DATA, "utf8"));
{
  const errs = validateOntology(onto);
  if (errs.length) throw new Error(`本体数据校验失败，拒绝启动：\n${errs.join("\n")}`);
}

function save(next, member, action, detail) {
  const errs = validateOntology(next);
  if (errs.length) return errs;
  next.version = onto.version + 1;
  next.updatedAt = new Date().toISOString();
  const tmp = `${DATA}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, DATA);
  appendFileSync(LOG, JSON.stringify({ at: next.updatedAt, version: next.version, member: member.name, action, ...detail }) + "\n");
  onto = next;
  return [];
}

const clone = (x) => structuredClone(x);
const changes = (limit) => {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).slice(-limit).reverse().map((l) => JSON.parse(l));
};

// ---------- 会话 ----------
// 会话令牌只放在 HttpOnly cookie 里；内存里只存它的 sha256
const sessions = new Map();
const sha = (s) => createHash("sha256").update(s).digest("hex");
const SESSION_MS = 30 * 24 * 3600 * 1000;

function cookieOf(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function whoami(req) {
  const members = readMembers(membersFile());
  const key = req.headers["x-member-key"];
  if (typeof key === "string") return memberByToken(key, members);
  const sid = cookieOf(req, COOKIE);
  if (!sid) return null;
  const s = sessions.get(sha(sid));
  if (!s || s.expires < Date.now()) return null;
  // 成员被删除后会话立即失效
  return members.find((m) => m.name === s.member) ?? null;
}

// 登录限速：同一 IP 连续失败 10 次锁 10 分钟
const failures = new Map();
const locked = (ip) => (failures.get(ip)?.until ?? 0) > Date.now();
function fail(ip) {
  const f = failures.get(ip) ?? { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 10) Object.assign(f, { n: 0, until: Date.now() + 10 * 60 * 1000 });
  failures.set(ip, f);
}

// ---------- HTTP ----------
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  // 脚本只允许同源文件，不允许内联；样式是页面内的 <style>
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string";
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": isJson ? "application/json; charset=utf-8" : "text/html; charset=utf-8", ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
const err = (res, status, message, code) => send(res, status, { error: message, code });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("请求体太大"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("请求体不是合法 JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const str = (v, name, max = 60) => {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw Object.assign(new Error(`${name} 必须是 1–${max} 个字`), { status: 400 });
  return v.trim();
};
const aliasesOf = (v) => {
  if (!Array.isArray(v) || v.length > 20) throw Object.assign(new Error("aliases 必须是不超过 20 项的数组"), { status: 400 });
  return [...new Set(v.map((a) => str(a, "别名", 20)))];
};
const priceOf = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw Object.assign(new Error("加价必须是 0–100 的数"), { status: 400 });
  return Math.round(n * 100) / 100;
};

function overview() {
  const kinds = {};
  for (const op of onto.operators) kinds[operatorKind(op)] = (kinds[operatorKind(op)] ?? 0) + 1;
  return {
    version: onto.version,
    updatedAt: onto.updatedAt,
    note: onto.note,
    valueTypes: onto.valueTypes,
    concepts: onto.concepts,
    operators: onto.operators.map((op) => ({ ...op, kind: operatorKind(op) })),
    operatorKinds: kinds,
    attributes: onto.attributes,
    options: onto.options.map((o) => ({ ...o, ref: optionRef(o) })),
  };
}

async function api(req, res, url, me) {
  const path = url.pathname;
  const m = req.method;

  if (m === "GET" && path === "/api/me") return send(res, 200, { name: me.name });
  if (m === "GET" && path === "/api/ontology") return send(res, 200, overview());
  // 导出：格式和仓库里的 ontology/luckin.json 一致，可以直接提 PR
  if (m === "GET" && path === "/api/export")
    return send(res, 200, onto, { "Content-Disposition": 'attachment; filename="luckin.json"' });
  if (m === "GET" && path === "/api/changes") return send(res, 200, changes(Math.min(Number(url.searchParams.get("limit")) || 50, 500)));

  if (m === "POST" && path === "/api/options") {
    const b = await readBody(req);
    const attribute = Number(b.attribute);
    const id = Number(b.id);
    if (!onto.attributes.some((a) => a.id === attribute)) return err(res, 400, "属性不存在", "attribute");
    if (!Number.isInteger(id) || id <= 0) return err(res, 400, "选项 ID 必须是正整数", "id");
    const next = clone(onto);
    const opt = { attribute, id, name: str(b.name, "名称"), aliases: aliasesOf(b.aliases ?? []), extraPrice: priceOf(b.extraPrice ?? 0), seenIn: str(b.seenIn, "见于", 100) };
    next.options.push(opt);
    const errs = save(next, me, "add_option", { ref: optionRef(opt), after: opt });
    return errs.length ? err(res, 409, errs.join("；"), "invalid") : send(res, 201, { ...opt, ref: optionRef(opt), version: onto.version });
  }

  const om = path.match(/^\/api\/options\/(\d+)\/(\d+)$/);
  if (om) {
    const ref = `${om[1]}/${om[2]}`;
    if (!findOption(onto, ref)) return err(res, 404, "选项不存在", "not_found");
    const b = await readBody(req);
    // 乐观锁：带上读取时的版本号，期间别人改过就拒绝，避免互相覆盖
    if (b.baseVersion !== undefined && Number(b.baseVersion) !== onto.version)
      return err(res, 409, `本体已被其他人改到第 ${onto.version} 版，请刷新后再改`, "stale");
    const next = clone(onto);
    const i = next.options.findIndex((o) => optionRef(o) === ref);
    const before = next.options[i];
    if (m === "PUT") {
      const after = { ...before };
      if (b.name !== undefined) after.name = str(b.name, "名称");
      if (b.aliases !== undefined) after.aliases = aliasesOf(b.aliases);
      if (b.extraPrice !== undefined) after.extraPrice = priceOf(b.extraPrice);
      if (b.seenIn !== undefined) after.seenIn = str(b.seenIn, "见于", 100);
      next.options[i] = after;
      const errs = save(next, me, "update_option", { ref, before, after });
      return errs.length ? err(res, 409, errs.join("；"), "invalid") : send(res, 200, { ...after, ref, version: onto.version });
    }
    if (m === "DELETE") {
      if (b.confirm !== true) return err(res, 400, "删除要带 {\"confirm\": true}", "confirm");
      next.options.splice(i, 1);
      const errs = save(next, me, "delete_option", { ref, before });
      return errs.length ? err(res, 409, errs.join("；"), "invalid") : send(res, 200, { ok: true, version: onto.version });
    }
  }
  return err(res, 404, "没有这个接口", "not_found");
}

const page = readFileSync(join(here, "public", "index.html"), "utf8");
const appJs = readFileSync(join(here, "public", "app.js"), "utf8");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const ip = req.socket.remoteAddress ?? "";
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, page);
    if (req.method === "GET" && url.pathname === "/app.js") return send(res, 200, appJs, { "Content-Type": "text/javascript; charset=utf-8" });
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, version: onto.version });

    if (!url.pathname.startsWith("/api/")) return err(res, 404, "没有这个页面", "not_found");

    // 写请求带了 Origin 时必须同源，防跨站提交
    if (req.method !== "GET" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
      return err(res, 403, "跨站请求被拒绝", "origin");

    if (req.method === "POST" && url.pathname === "/api/login") {
      if (locked(ip)) return err(res, 429, "失败次数太多，10 分钟后再试", "locked");
      const b = await readBody(req);
      const member = memberByToken(b.token, readMembers(membersFile()));
      if (!member) {
        fail(ip);
        return err(res, 401, "令牌不对", "bad_token");
      }
      failures.delete(ip);
      const sid = randomBytes(32).toString("base64url");
      sessions.set(sha(sid), { member: member.name, expires: Date.now() + SESSION_MS });
      const secure = process.env.CO_COOKIE_SECURE === "1" ? "; Secure" : "";
      return send(res, 200, { name: member.name }, { "Set-Cookie": `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      const sid = cookieOf(req, COOKIE);
      if (sid) sessions.delete(sha(sid));
      return send(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    const me = whoami(req);
    if (!me) return err(res, 401, "请先登录", "unauthorized");
    return await api(req, res, url, me);
  } catch (e) {
    const status = e.status ?? 500;
    if (status === 500) console.error(e);
    return err(res, status, status === 500 ? "服务器出错了" : e.message, status === 500 ? "internal" : "bad_request");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`本体库总服务器：http://${HOST}:${PORT}/  数据 ${DATA}  第 ${onto.version} 版`);
  if (!readMembers(membersFile()).length) console.log("还没有成员，先运行：node server/members.mjs add <名字>");
});

export { server };
