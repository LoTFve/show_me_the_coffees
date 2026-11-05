import { randomBytes } from "node:crypto";

/**
 * 契约骨架（spec v1 §5）。这一层把官方 MCP 的透传工具包成有状态的会话：
 * 每个会话持有 revision、当前 state、授权范围和已落下的槽位。
 * 真正把槽位落到官方接口、算价、建单在后续步骤里填，这里只负责理解和状态。
 */

/** 槽位状态机（spec §6.5 的子集，骨架只到建单前）。 */
export type State =
  | "collecting" // 还缺必填槽位，要问用户
  | "items_ready"; // 槽位齐全，可以核价

/** 工具契约错误码（spec §5.1）。 */
export const ErrorCode = {
  REVISION_CONFLICT: "REVISION_CONFLICT",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  CONSTRAINT_UNSAT: "CONSTRAINT_UNSAT",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 槽位取值的来源，覆盖时同来源按先后（spec §3）。 */
export type SlotSource = "utterance" | "session" | "authorized_default" | "history" | "product_default";

export interface Slot {
  value: unknown;
  source: SlotSource;
  /** 用户原话里支撑这个取值的片段，没有就空 */
  evidence_span?: string;
  certainty?: number;
  needs_confirmation?: boolean;
}

/** 授权范围（spec §5.1）。pay 永远 false，不作为字段开放。 */
export interface Authorization {
  select_items: boolean;
  auto_substitute: boolean;
  allow_split: boolean;
  prepare_unpaid_order: boolean;
  max_total_cents?: number;
}

export function defaultAuthorization(): Authorization {
  return { select_items: false, auto_substitute: false, allow_split: false, prepare_unpaid_order: false };
}

/** 已下单的一单，用来轮询付款状态、续下剩余单 */
export interface PlacedOrder {
  orderId: string;
  /** 用户可见的说明，如“第 1 单” */
  label: string;
  /** 已观察到的付款状态：true 已不占未付款名额（已付/已取消），undefined 还没查 */
  settled?: boolean;
}

/**
 * 拆单建单任务（spec §5：prepare_checkout 返回持久 job）。
 * 瑞幸限制未付款单最多 3 单，所以拆单超过 3 单时分批建：
 * 先建一批，用户付掉几单腾出名额后，再建剩余的。
 */
export interface CheckoutJob {
  /** 还没建单的剩余单（官方 productList，每单 1 杯） */
  remaining: { productList: unknown; label: string }[];
  /** 已建单、待观察付款的单 */
  placed: PlacedOrder[];
  deptId: number;
  longitude: number;
  latitude: number;
  /** 每单实付上限（元） */
  maxPayEach: number;
}

export interface Session {
  id: string;
  revision: number;
  state: State;
  slots: Record<string, Slot>;
  authorization: Authorization;
  /** 用户最近一次的原话，供落槽位时取证 */
  utterance?: string;
  /** 进行中的拆单建单任务；分批建单时跨工具调用保留进度 */
  checkout?: CheckoutJob;
}

/** 内存会话表。P0 单机单用户，重启即清空；持久化留到接入云端编排时做。 */
export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private id: () => string = () => "s" + randomBytes(4).toString("hex")) {}

  start(utterance?: string): Session {
    const s: Session = {
      id: this.id(),
      revision: 1,
      state: "collecting",
      slots: {},
      authorization: defaultAuthorization(),
      utterance,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * 改订单内容：校验 expected_revision，通过后执行 mutate 并把 revision +1。
   * 返回最新 session 或错误码（spec §5.1 的 REVISION_CONFLICT / SESSION_NOT_FOUND）。
   */
  revise(
    id: string,
    expectedRevision: number | undefined,
    mutate: (s: Session) => void,
  ): { session: Session } | { error: ErrorCode; detail: string; current?: number } {
    const s = this.sessions.get(id);
    if (!s) return { error: ErrorCode.SESSION_NOT_FOUND, detail: `找不到会话 ${id}，请先调用 luckin_start` };
    if (expectedRevision !== undefined && expectedRevision !== s.revision) {
      return { error: ErrorCode.REVISION_CONFLICT, detail: "订单已被改过，请拉取最新版本后重试", current: s.revision };
    }
    mutate(s);
    s.revision += 1;
    return { session: s };
  }
}
