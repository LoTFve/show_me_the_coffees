// 高德 Web 服务：把用户说的地标或地址换成经纬度，用来查附近门店。
// 返回的是高德坐标（GCJ-02），和瑞幸门店坐标同一坐标系，可以直接传给 queryShopList。

export interface Place {
  name: string;
  address: string;
  city: string;
  district: string;
  longitude: number;
  latitude: number;
}

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const POI_URL = "https://restapi.amap.com/v5/place/text";

/** 高德的 location 是“经度,纬度”字符串 */
function parseLocation(s: unknown): [number, number] | null {
  if (typeof s !== "string") return null;
  const [lng, lat] = s.split(",").map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90 ? [lng, lat] : null;
}

/** 错误信息里去掉 key，避免它出现在工具返回或日志里 */
const scrub = (s: string, key: string) => (key ? s.split(key).join("***") : s);

/**
 * 关键字搜地点，最多返回 limit 个候选。city 可选，传了就只在该城市内搜。
 * 只用 POI 搜索：用户说的多半是地标（“高新银泰”），结构化地址也能搜到。
 */
export async function searchPlace(key: string, keywords: string, opts: { city?: string; limit?: number; fetch?: Fetch } = {}): Promise<Place[]> {
  const kw = keywords.trim();
  if (!kw || kw.length > 80) throw new Error("地点关键词要 1–80 个字");
  const q = new URLSearchParams({ key, keywords: kw, page_size: String(Math.min(opts.limit ?? 5, 10)) });
  if (opts.city?.trim()) {
    q.set("region", opts.city.trim());
    q.set("city_limit", "true");
  }
  const f = opts.fetch ?? ((u: string) => fetch(u));
  let body: { status?: string; info?: string; infocode?: string; pois?: Array<Record<string, unknown>> };
  try {
    const r = await f(`${POI_URL}?${q}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    body = (await r.json()) as typeof body;
  } catch (e) {
    throw new Error(scrub(`高德地点搜索失败：${(e as Error).message}`, key));
  }
  if (body.status !== "1") {
    const why = body.infocode === "10001" ? "Key 无效" : body.infocode === "10003" ? "今天的免费额度用完了" : body.info ?? "未知错误";
    throw new Error(scrub(`高德返回错误：${why}（${body.infocode ?? "-"}）`, key));
  }
  const out: Place[] = [];
  for (const p of body.pois ?? []) {
    const loc = parseLocation(p.location);
    if (!loc) continue;
    out.push({
      name: String(p.name ?? ""),
      address: typeof p.address === "string" ? p.address : "",
      city: String(p.cityname ?? ""),
      district: String(p.adname ?? ""),
      longitude: loc[0],
      latitude: loc[1],
    });
  }
  return out;
}
