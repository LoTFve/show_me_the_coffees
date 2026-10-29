import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 起一个真实的本体库总服务器进程，数据放临时目录
const root = fileURLToPath(new URL("..", import.meta.url));
let dir: string;
let proc: ChildProcess;
let base: string;
let token: string;

async function run(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: root, env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "co-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, CO_DATA: join(dir, "luckin.json"), CO_MEMBERS: join(dir, "members.json"), CO_PORT: String(port) };
  token = (await run(["server/members.mjs", "add", "测试员"], env)).match(/\n\s+(\S{30,})\n/)![1];
  proc = spawn(process.execPath, ["server/index.mjs"], { cwd: root, env });
  base = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on("data", (d) => String(d).includes("本体库总服务器") && resolve());
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
});

afterAll(async () => {
  proc?.kill();
  await rm(dir, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit & { key?: string } = {}) =>
  fetch(base + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.key ? { "X-Member-Key": init.key } : {}), ...(init.headers ?? {}) },
  });
const authed = (path: string, init: RequestInit = {}) => call(path, { ...init, key: token });

describe("本体库总服务器", () => {
  it("serves the page without login but rejects the API", async () => {
    expect((await call("/")).status).toBe(200);
    expect((await call("/api/ontology")).status).toBe(401);
    expect((await call("/api/ontology", { key: "wrong-token-wrong-token" })).status).toBe(401);
  });

  it("never accepts the token in the URL", async () => {
    expect((await call(`/api/ontology?key=${token}`)).status).toBe(401);
  });

  it("sets security headers and a CSP that blocks inline scripts", async () => {
    const r = await call("/");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await r.text()).not.toMatch(/<script>(?!<\/script>)/);
  });

  it("stores only a hash of the token, with mode 600", async () => {
    const file = await readFile(join(dir, "members.json"), "utf8");
    expect(file).not.toContain(token);
    if (process.platform !== "win32") expect((await stat(join(dir, "members.json"))).mode & 0o777).toBe(0o600);
  });

  it("logs in with a cookie session", async () => {
    const r = await call("/api/login", { method: "POST", body: JSON.stringify({ token }) });
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const me = await call("/api/me", { headers: { cookie: cookie.split(";")[0] } });
    expect(await me.json()).toEqual({ name: "测试员" });
  });

  it("returns the ontology with operator kinds", async () => {
    const o = await (await authed("/api/ontology")).json();
    expect(o.concepts).toHaveLength(10);
    expect(o.operators).toHaveLength(50);
    expect(o.operatorKinds["二元关系"]).toBe(15);
    expect(o.options.find((x: { ref: string }) => x.ref === "18/112").name).toBe("少甜");
  });

  it("edits aliases, records who changed what, and bumps the version", async () => {
    const before = await (await authed("/api/ontology")).json();
    const r = await authed("/api/options/18/254", { method: "PUT", body: JSON.stringify({ aliases: ["微糖", "一点点糖"], baseVersion: before.version }) });
    expect(r.status).toBe(200);
    const after = await (await authed("/api/ontology")).json();
    expect(after.version).toBe(before.version + 1);
    const [log] = await (await authed("/api/changes")).json();
    expect(log).toMatchObject({ member: "测试员", action: "update_option", ref: "18/254" });
    expect(log.after.aliases).toEqual(["微糖", "一点点糖"]);
  });

  it("rejects an alias that already points at another option", async () => {
    const { version } = await (await authed("/api/ontology")).json();
    const r = await authed("/api/options/18/254", { method: "PUT", body: JSON.stringify({ aliases: ["少糖"], baseVersion: version }) });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain("“少糖”同时指向 18/112 和 18/254");
  });

  it("rejects stale edits so two members do not overwrite each other", async () => {
    const r = await authed("/api/options/18/112", { method: "PUT", body: JSON.stringify({ aliases: ["少糖"], baseVersion: 1 }) });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("stale");
  });

  it("requires explicit confirmation to delete", async () => {
    expect((await authed("/api/options/120/797", { method: "DELETE", body: "{}" })).status).toBe(400);
    expect((await authed("/api/options/120/797", { method: "DELETE", body: JSON.stringify({ confirm: true }) })).status).toBe(200);
    expect((await authed("/api/options/120/797", { method: "DELETE", body: JSON.stringify({ confirm: true }) })).status).toBe(404);
  });

  it("rejects cross-site writes", async () => {
    const r = await authed("/api/options/18/112", { method: "PUT", headers: { origin: "https://evil.example" }, body: JSON.stringify({ aliases: [] }) });
    expect(r.status).toBe(403);
  });

  it("exports JSON in the same shape as ontology/luckin.json", async () => {
    const exp = await (await authed("/api/export")).json();
    const repo = JSON.parse(await readFile(join(root, "ontology", "luckin.json"), "utf8"));
    expect(Object.keys(exp).sort()).toEqual(Object.keys(repo).sort());
    expect(exp.version).toBeGreaterThan(repo.version);
  });
});
