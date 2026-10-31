import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchPlace, type Fetch } from "../src/amap.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { LocalStore } from "../src/store.js";

const KEY = "0123456789abcdef0123456789abcdef";

/** 模拟高德 POI 搜索；记录收到的 URL */
function fakeAmap(pois: unknown[], opts: { status?: string; infocode?: string; info?: string } = {}) {
  const urls: string[] = [];
  const f: Fetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ status: opts.status ?? "1", infocode: opts.infocode ?? "10000", info: opts.info ?? "OK", pois }) };
  };
  return { f, urls };
}

const yintai = { name: "银泰中心(高新店)", address: "望江西路888号", cityname: "合肥市", adname: "蜀山区", location: "117.133550,31.830754" };

describe("searchPlace", () => {
  it("parses longitude,latitude and restricts to the city when given", async () => {
    const { f, urls } = fakeAmap([yintai]);
    const [p] = await searchPlace(KEY, "高新银泰", { city: "合肥", fetch: f });
    expect(p).toMatchObject({ name: "银泰中心(高新店)", city: "合肥市", longitude: 117.13355, latitude: 31.830754 });
    const q = new URL(urls[0]).searchParams;
    expect(q.get("keywords")).toBe("高新银泰");
    expect(q.get("region")).toBe("合肥");
    expect(q.get("city_limit")).toBe("true");
  });

  it("drops results without a valid location", async () => {
    const { f } = fakeAmap([{ ...yintai, location: "" }, { ...yintai, location: "999,999" }, yintai]);
    expect(await searchPlace(KEY, "x", { fetch: f })).toHaveLength(1);
  });

  it("explains a bad key without leaking the key", async () => {
    const { f } = fakeAmap([], { status: "0", infocode: "10001", info: `INVALID_USER_KEY ${KEY}` });
    const err = await searchPlace(KEY, "x", { fetch: f }).catch((e: Error) => e.message);
    expect(err).toContain("Key 无效");
    expect(err).not.toContain(KEY);
  });

  it("scrubs the key from network errors", async () => {
    const f: Fetch = async (url) => {
      throw new Error(`connect failed ${url}`);
    };
    const err = await searchPlace(KEY, "x", { fetch: f }).catch((e: Error) => e.message);
    expect(err).not.toContain(KEY);
    expect(err).toContain("***");
  });

  it("rejects empty or over-long keywords", async () => {
    const { f } = fakeAmap([]);
    await expect(searchPlace(KEY, "  ", { fetch: f })).rejects.toThrow();
    await expect(searchPlace(KEY, "字".repeat(81), { fetch: f })).rejects.toThrow();
  });
});

describe("locate / amap_setup tools", () => {
  let dir: string;
  const text = (r: any) => r.content[0].text as string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "amap-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function client(f: Fetch, env: Record<string, string> = {}) {
    const config = { ...loadConfig(env), dataDir: dir, tokenFile: join(dir, "token"), amapKeyFile: join(dir, "amap-key") };
    const server = createServer({ config, store: new LocalStore(dir), connect: () => ({ listTools: async () => [], callTool: async () => ({ text: "", isError: false }) }), fetch: f });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(b);
    return c;
  }

  it("asks for a key with the console link when none is set", async () => {
    const c = await client(fakeAmap([yintai]).f);
    const r = await c.callTool({ name: "locate", arguments: { place: "高新银泰" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("console.amap.com");
    expect(text(r)).toContain("amap_setup");
  });

  it("validates and saves the key, then locate works", async () => {
    const { f } = fakeAmap([yintai]);
    const c = await client(f);
    expect(text(await c.callTool({ name: "amap_setup", arguments: { key: KEY } }))).toContain("有效");
    expect(await readFile(join(dir, "amap-key"), "utf8")).toBe(KEY);
    const r = JSON.parse(text(await c.callTool({ name: "locate", arguments: { place: "高新银泰", city: "合肥" } })));
    expect(r.places[0]).toMatchObject({ longitude: 117.13355, latitude: 31.830754 });
  });

  it("does not save an invalid key", async () => {
    const c = await client(fakeAmap([], { status: "0", infocode: "10001" }).f);
    const r = await c.callTool({ name: "amap_setup", arguments: { key: KEY } });
    expect(r.isError).toBe(true);
    await expect(readFile(join(dir, "amap-key"), "utf8")).rejects.toThrow();
  });

  it("asks the user to choose when there are several places, and never returns the key", async () => {
    const c = await client(fakeAmap([yintai, { ...yintai, name: "银泰城", location: "117.2,31.8" }]).f, { AMAP_KEY: KEY });
    const out = text(await c.callTool({ name: "locate", arguments: { place: "银泰" } }));
    expect(JSON.parse(out).note).toContain("列给用户选");
    expect(out).not.toContain(KEY);
  });

  it("reports no results instead of guessing", async () => {
    const c = await client(fakeAmap([]).f, { AMAP_KEY: KEY });
    const r = await c.callTool({ name: "locate", arguments: { place: "不存在的地方" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("没找到");
  });
});
