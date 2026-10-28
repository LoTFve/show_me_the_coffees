import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface Upstream {
  listTools(): Promise<UpstreamTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/** 懒连接瑞幸官方 MCP；断线后下次调用自动重连 */
export class McpUpstream implements Upstream {
  private client?: Promise<Client>;
  private tools?: UpstreamTool[];

  constructor(private makeTransport: () => Transport) {}

  static http(url: string, token?: string): McpUpstream {
    return new McpUpstream(
      () =>
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
        }),
    );
  }

  private connect(): Promise<Client> {
    if (!this.client) {
      const c = new Client({ name: "lucky-agent", version: "0.1.0" });
      c.onclose = () => {
        this.client = undefined;
      };
      this.client = c.connect(this.makeTransport()).then(
        () => c,
        (e) => {
          this.client = undefined;
          throw friendly(e);
        },
      );
    }
    return this.client;
  }

  async listTools(): Promise<UpstreamTool[]> {
    if (!this.tools) {
      const c = await this.connect();
      const { tools } = await c.listTools();
      this.tools = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    }
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const c = await this.connect();
    try {
      const r = await c.callTool({ name, arguments: args });
      const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content
        .map((p) => (p.type === "text" ? p.text : JSON.stringify(p)))
        .join("\n");
      return { text, isError: Boolean(r.isError) || businessFailed(text) };
    } catch (e) {
      throw friendly(e);
    }
  }
}

/** 瑞幸把业务错误放在正常返回里：{"code":1000,"msg":"非法参数","success":false} */
export function businessFailed(text: string): boolean {
  try {
    const j = JSON.parse(text);
    return j?.success === false;
  } catch {
    return false;
  }
}

function friendly(e: unknown): Error {
  const msg = String((e as Error)?.message ?? e);
  if (/401|403|unauthorized|invalid token/i.test(msg)) {
    return new Error("瑞幸账户授权失效或 token 无效，请在官方平台重新获取 LUCKIN_MCP_TOKEN");
  }
  return new Error(`连接瑞幸官方 MCP 失败：${msg}`);
}
