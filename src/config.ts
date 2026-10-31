import { homedir } from "node:os";
import { join } from "node:path";

// Token 在 https://open.lkcoffee.com/mcp 登录后获取
export const DEFAULT_UPSTREAM = "https://gwmcp.lkcoffee.com/order/user/mcp";
export const TOKEN_PAGE = "https://open.lkcoffee.com/mcp";

export interface Config {
  /** 瑞幸官方 MCP Server 地址（Streamable HTTP） */
  upstreamUrl: string;
  /** 环境变量里的 token；优先于本地保存的 token */
  upstreamToken?: string;
  /** 高德 Web 服务 Key；环境变量优先，其次是 amapKeyFile */
  amapKey?: string;
  amapKeyFile: string;
  /** 本地数据目录：偏好、常用门店、下单记录、token */
  dataDir: string;
  /** 用户在对话里给的 token 保存在这里（权限 600） */
  tokenFile: string;
  /** 额外视为“写操作”的上游工具名（逗号分隔），补充内置规则 */
  extraWriteTools: string[];
  /** 确认码有效期（毫秒） */
  confirmTtlMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.LUCKY_AGENT_HOME || join(homedir(), ".lucky-agent");
  return {
    upstreamUrl: env.LUCKIN_MCP_URL || DEFAULT_UPSTREAM,
    upstreamToken: env.LUCKIN_MCP_TOKEN || undefined,
    amapKey: env.AMAP_KEY || undefined,
    amapKeyFile: join(dataDir, "amap-key"),
    dataDir,
    tokenFile: join(dataDir, "token"),
    extraWriteTools: (env.LUCKIN_WRITE_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    confirmTtlMs: Number(env.LUCKY_AGENT_CONFIRM_TTL_MS) || 5 * 60_000,
  };
}
