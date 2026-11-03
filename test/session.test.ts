import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConfirmGate } from "../src/guard.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/session.js";
import { LocalStore } from "../src/store.js";
import type { Upstream } from "../src/upstream.js";

const stubUpstream: Upstream = {
  async listTools() {
    return [];
  },
  async callTool(name: string) {
    return { text: `ok:${name}`, isError: false };
  },
};

const text = (r: any) => r.content[0].text as string;
const env = (r: any) => JSON.parse(text(r));

const slot = (value: unknown) => ({ value, source: "utterance" as const });

describe("session contract (spec §5)", () => {
  let dir: string;
  let client: Client;
  let ids: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucky-sess-"));
    ids = 0;
    const config = { ...loadConfig({ LUCKIN_MCP_TOKEN: "env-token" }), dataDir: dir, confirmTtlMs: 1000 };
    const server = createServer({
      config,
      store: new LocalStore(dir),
      connect: () => stubUpstream,
      gate: new ConfirmGate(1000, () => 0),
      sessions: new SessionStore(() => `s${++ids}`),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "t", version: "0" });
    await client.connect(b);
  });

  afterEach(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });

  const start = (utterance = "来杯拿铁") => client.callTool({ name: "luckin_start", arguments: { utterance } });
  const resolve = (args: Record<string, unknown>) => client.callTool({ name: "luckin_resolve_order", arguments: args });

  it("start opens a session at revision 1, collecting, listing missing slots", async () => {
    const e = env(await start());
    expect(e).toMatchObject({ session_id: "s1", revision: 1, state: "collecting" });
    expect(e.allowed_actions).toContain("luckin_resolve_order");
    expect(e.missing).toEqual(["fulfillment", "store", "items"]);
  });

  it("resolve_order lands slots, bumps revision, stays collecting while required slots missing", async () => {
    await start();
    const e = env(await resolve({ session_id: "s1", slots: { fulfillment: slot("自取") } }));
    expect(e.revision).toBe(2);
    expect(e.state).toBe("collecting");
    expect(e.missing).toEqual(["store", "items"]);
    expect(e.slots.fulfillment).toMatchObject({ value: "自取", source: "utterance" });
  });

  it("flips to items_ready once all required slots are present", async () => {
    await start();
    const e = env(
      await resolve({
        session_id: "s1",
        slots: { fulfillment: slot("自取"), store: slot(12345), items: slot([{ sku: "LATTE", spec: "大杯冰" }]) },
      }),
    );
    expect(e.state).toBe("items_ready");
    expect(e.missing).toEqual([]);
    expect(e.allowed_actions).toContain("luckin_quote_best");
  });

  it("rejects a stale expected_revision with REVISION_CONFLICT and keeps state unchanged", async () => {
    await start();
    await resolve({ session_id: "s1", slots: { fulfillment: slot("自取") } }); // revision -> 2
    const r = await resolve({ session_id: "s1", expected_revision: 1, slots: { store: slot(1) } });
    expect(r.isError).toBe(true);
    const e = JSON.parse(text(r));
    expect(e).toMatchObject({ error: "REVISION_CONFLICT", current_revision: 2 });
    // the rejected write did not land
    const after = env(await resolve({ session_id: "s1", slots: {} }));
    expect(after.slots.store).toBeUndefined();
  });

  it("returns SESSION_NOT_FOUND for an unknown session", async () => {
    const r = await resolve({ session_id: "nope", slots: {} });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r)).error).toBe("SESSION_NOT_FOUND");
  });

  it("merges authorization fields across calls, defaulting the rest to false", async () => {
    await start();
    await resolve({ session_id: "s1", authorization: { select_items: true, max_total_cents: 15000 } });
    // a later call changes only allow_split; earlier grants persist
    await resolve({ session_id: "s1", authorization: { allow_split: true } });
    // read back via a no-op resolve
    const e = env(await resolve({ session_id: "s1", slots: {} }));
    expect(e.revision).toBe(4);
    expect(e.authorization).toMatchObject({
      select_items: true,
      allow_split: true,
      max_total_cents: 15000,
      auto_substitute: false,
      prepare_unpaid_order: false,
    });
  });
});
