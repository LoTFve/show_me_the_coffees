import { homedir } from "node:os";
import { join } from "node:path";

// Token 在 https://open.lkcoffee.com/mcp 登录后获取
export const DEFAULT_UPSTREAM = "https://gwmcp.lkcoffee.com/order/user/mcp";

export interface Config {
  /** 瑞幸官方 MCP Server 地址（Streamable HTTP） */
  upstreamUrl?: string;
  /** 官方平台发放的访问 token，只在内存中使用，不落盘 */
  upstreamToken?: string;
  /** 本地数据目录：偏好、常用门店、下单记录 */
  dataDir: string;
  /** 额外视为“写操作”的上游工具名（逗号分隔），补充内置规则 */
  extraWriteTools: string[];
  /** 确认码有效期（毫秒） */
  confirmTtlMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    upstreamUrl: env.LUCKIN_MCP_URL || (env.LUCKIN_MCP_TOKEN ? DEFAULT_UPSTREAM : undefined),
    upstreamToken: env.LUCKIN_MCP_TOKEN || undefined,
    dataDir: env.LUCKY_AGENT_HOME || join(homedir(), ".lucky-agent"),
    extraWriteTools: (env.LUCKIN_WRITE_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    confirmTtlMs: Number(env.LUCKY_AGENT_CONFIRM_TTL_MS) || 5 * 60_000,
  };
}
