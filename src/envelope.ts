import type { ErrorCode, Session, State } from "./session.js";

/**
 * 工具返回信封（spec §5.1）。所有契约工具返回同一结构，宿主据此判断
 * 此刻能调什么（allowed_actions）、当前到哪一步（state）、哪些内容必须展示给用户。
 */
export interface Envelope {
  state: State;
  revision: number;
  session_id: string;
  /** 此刻可调用的工具名，不分先后（spec 本体概要） */
  allowed_actions: string[];
  /** 这些字段必须出现在给用户的回复里（spec §5.1） */
  reply_must_show_user: string[];
  /** 本次落下/缺失/有歧义的槽位，由各工具填 */
  slots?: unknown;
  ambiguous?: string[];
  missing?: string[];
  /** 可读降级文本，纯文本宿主用（spec §7.2） */
  fallback_markdown?: string;
  /** 当前授权范围，便于宿主判断能否代选、拆单、建单 */
  authorization?: unknown;
}

/** state 决定此刻允许的下一步工具（spec：allowed_actions 随状态变化）。 */
export function allowedActions(state: State): string[] {
  switch (state) {
    case "collecting":
      return ["luckin_resolve_order"];
    case "items_ready":
      // 核价/查店查菜单。quote_best 等后续步骤接入后会出现在这里
      return [
        "luckin_resolve_order",
        "luckin_find_store",
        "luckin_get_menu",
        "luckin_quote_best",
        "luckin_prepare_checkout",
        "luckin_wait_payment",
      ];
  }
}

/** 从会话构造信封，叠加本次工具给的额外字段。 */
export function envelope(session: Session, extra: Partial<Envelope> = {}): Envelope {
  return {
    state: session.state,
    revision: session.revision,
    session_id: session.id,
    allowed_actions: allowedActions(session.state),
    reply_must_show_user: [],
    ...extra,
  };
}

export interface CodedError {
  error: ErrorCode;
  detail: string;
  /** REVISION_CONFLICT 时带上当前 revision */
  current_revision?: number;
}
