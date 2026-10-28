import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Favorite {
  /** 自己起的名字，如“老样子”“下午提神” */
  name: string;
  /** 自然语言描述，如“生椰拿铁 大杯 少冰 少甜” */
  description: string;
  /** 可选：上游返回的商品 / 规格 ID，方便直接复用 */
  items?: unknown;
}

export interface OrderLog {
  at: string;
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export interface Data {
  /** 口味偏好：甜度、温度、奶、忌口等，自由键值 */
  preferences: Record<string, string>;
  /** 常用门店：别名 -> 门店信息 */
  stores: Record<string, { storeId?: string; name: string; note?: string }>;
  favorites: Favorite[];
  orders: OrderLog[];
}

const empty = (): Data => ({ preferences: {}, stores: {}, favorites: [], orders: [] });
const MAX_ORDERS = 50;

export class LocalStore {
  private file: string;

  constructor(private dir: string) {
    this.file = join(dir, "data.json");
  }

  async read(): Promise<Data> {
    try {
      return { ...empty(), ...JSON.parse(await readFile(this.file, "utf8")) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw e;
    }
  }

  async update(fn: (d: Data) => void): Promise<Data> {
    const data = await this.read();
    fn(data);
    data.orders = data.orders.slice(-MAX_ORDERS);
    await mkdir(this.dir, { recursive: true });
    // 先写临时文件再改名，避免写一半损坏
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, this.file);
    return data;
  }
}
