/**
 * 瑞幸官方返回的解析（字段名来自 2026-11-04 实测，见 test/fixtures/）。
 * 只负责把原始 JSON 解析成结构化的域对象，不调接口、不含状态。
 */

/** queryShopList 返回的一家门店 */
export interface Store {
  deptId: number;
  name: string;
  address: string;
  longitude: number;
  latitude: number;
  /** 当前营业状态，如“营业中”“打烊中” */
  workStatus: string;
  workTimeStart?: string;
  workTimeEnd?: string;
  /** 直线距离（公里） */
  distance?: number;
  tags: string[];
}

/** searchProductForMcp 返回的一个商品 */
export interface Product {
  productId: number;
  name: string;
  skuCode: string;
  /** 原价（元） */
  initialPrice?: number;
  /** 券后预估价（元），实际价以 previewOrder 为准 */
  estimatePrice?: number;
  /** 搜索是否降级（没精确命中时的兜底结果） */
  fallback?: boolean;
  tags: string[];
}

/** previewOrder 返回的核价结果 */
export interface Quote {
  /** 券后实付（元） */
  payPrice: number;
  /** 原价合计（元） */
  initialPrice: number;
  /** 优惠金额（元） */
  privilege: number;
  /** 自动选中的券码；createOrder 要原样回传 */
  couponCodeList: string[];
  deptId?: number;
  deptName?: string;
}

const parse = (text: string): any => {
  const j = JSON.parse(text);
  if (j && j.success === false) {
    throw new Error(`瑞幸返回失败：${j.msg ?? "未知错误"}`);
  }
  return j;
};

export function parseStores(text: string): Store[] {
  const d = parse(text).data;
  if (!Array.isArray(d)) return [];
  return d.map((s: any) => ({
    deptId: s.deptId,
    name: s.deptName,
    address: s.address,
    longitude: s.longitude,
    latitude: s.latitude,
    workStatus: s.workStatus,
    workTimeStart: s.workTimeStart,
    workTimeEnd: s.workTimeEnd,
    distance: s.distance,
    tags: Array.isArray(s.deptTags) ? s.deptTags : [],
  }));
}

export function parseProducts(text: string): Product[] {
  const d = parse(text).data;
  if (!Array.isArray(d)) return [];
  return d.map((p: any) => ({
    productId: p.productId,
    name: p.productName,
    skuCode: p.skuCode,
    initialPrice: p.initialPrice,
    estimatePrice: p.estimatePrice,
    fallback: p.fallback,
    tags: Array.isArray(p.tags) ? p.tags : [],
  }));
}

export function parseQuote(text: string): Quote {
  const d = parse(text).data ?? {};
  const payPrice = Number(d.discountPrice);
  if (!Number.isFinite(payPrice)) throw new Error("previewOrder 没有返回价格");
  return {
    payPrice,
    initialPrice: Number(d.totalInitialPrice) || 0,
    privilege: Number(d.privilegeMoney) || 0,
    couponCodeList: Array.isArray(d.couponCodeList) ? d.couponCodeList : [],
    deptId: d.shopInfo?.deptId,
    deptName: d.shopInfo?.deptName,
  };
}

/** 门店此刻能不能下单（spec：workStatus 为“打烊中”时不要下单） */
export const isOpen = (s: Store): boolean => s.workStatus === "营业中";

/** 一个下单方案（spec §5.2 的 plan） */
export interface Plan {
  kind: "combined" | "split";
  /** 实付合计（元） */
  payYuan: number;
  /** 要付几次款 */
  orderCount: number;
  /** 拆单实付是乐观下界：预览不占券，真实可能更高 */
  estimated: boolean;
}

/**
 * 比较合单和拆单两个方案（spec §5.2）。
 * combinedPayYuan：一次 previewOrder 全部商品的实付；准。
 * splitPays：每杯单独 previewOrder 的实付数组；求和是乐观下界（预览不占券，
 *   每杯都按能拿到最便宜券估，真实下单时券被占用、后面的单可能更贵）。
 * baselineYuan：原价合计（不加本次优惠），用来算省了多少。
 */
export function comparePlans(combinedPayYuan: number, splitPays: number[], baselineYuan: number) {
  const splitTotal = splitPays.reduce((s, p) => s + p, 0);
  const combined: Plan = { kind: "combined", payYuan: combinedPayYuan, orderCount: 1, estimated: false };
  const split: Plan = { kind: "split", payYuan: splitTotal, orderCount: splitPays.length, estimated: true };
  const cheaper = split.payYuan < combined.payYuan ? "split" : "combined";
  return {
    plans: [combined, split],
    cheaper,
    baselineYuan,
    // 省多少：拿两方案里更省的那个和原价比；拆单是估计，所以是“最多省”
    maxSaveYuan: Math.max(0, baselineYuan - Math.min(combined.payYuan, split.payYuan)),
  };
}
