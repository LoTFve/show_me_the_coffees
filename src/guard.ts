import { createHash, randomBytes } from "node:crypto";

// 名字里带这些词的上游工具视为会产生真实交易/副作用
const WRITE_PATTERN = /(create|submit|place|pay|cancel|checkout|confirm|下单|支付|取消)/i;
// 明确是只读的词优先放行，例如 query_order / order_list / order_detail
const READ_PATTERN = /(query|list|get|detail|search|preview|calc|price|quote|查询)/i;

export function isWriteTool(name: string, extra: string[] = []): boolean {
  if (extra.includes(name)) return true;
  if (READ_PATTERN.test(name)) return false;
  return WRITE_PATTERN.test(name);
}

/** 参数稳定序列化：键排序，保证同样的参数得到同样的指纹 */
export function fingerprint(tool: string, args: Record<string, unknown>): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash("sha256").update(JSON.stringify([tool, stable(args)])).digest("hex");
}

/**
 * 两步确认：第一次调用写工具只拿到确认码；
 * 必须用完全相同的参数 + 确认码再次调用才会真正执行。确认码一次性、会过期。
 */
export class ConfirmGate {
  private pending = new Map<string, { fp: string; expires: number }>();

  constructor(
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  issue(tool: string, args: Record<string, unknown>): string {
    this.sweep();
    const code = randomBytes(3).toString("hex").toUpperCase();
    this.pending.set(code, { fp: fingerprint(tool, args), expires: this.now() + this.ttlMs });
    return code;
  }

  /** 校验并消费确认码；返回失败原因或 null */
  redeem(code: string, tool: string, args: Record<string, unknown>): string | null {
    this.sweep();
    const entry = this.pending.get(code);
    if (!entry) return "确认码无效或已过期，请重新预览";
    if (entry.fp !== fingerprint(tool, args)) return "参数和预览时不一致，请重新预览";
    this.pending.delete(code);
    return null;
  }

  private sweep() {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expires <= t) this.pending.delete(k);
  }
}
