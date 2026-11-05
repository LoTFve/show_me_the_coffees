# 瑞幸官方 MCP · 到店自取线实现说明

回答问题：这仓库里"用瑞幸官方 MCP 完成到店自取点单"这条线，现在实现到什么程度，后续接手要怎么用、改哪里。

| | |
| --- | --- |
| **版本** | 2026-11-05 |
| **owner** | LoTFve |
| **范围** | 官方 MCP 自取线：会话契约、查店/菜单/核价、建单、分批付款。不含云手机、外送、推荐算法、卡片 UI |
| **状态** | 可用，未经真实多单付款闭环验证（见第 6 节） |
| **相关** | 工具契约与本体 [luckin-co.md](luckin-co.md)；仓库规则 [../AGENTS.md](../AGENTS.md)；真实返回夹具 [../test/fixtures/](../test/fixtures/) |

> 这条线对应飞书《最优下单 · 瑞幸插件开发 Spec v1》的 §5 工具契约（自取分支）。spec 的意图识别（§2）、推荐算法（§4）、云手机（§6）、卡片（§7）尚未实现。

## 结论

> **自取线端到端通了**：用户说想喝什么 → 查店 → 配菜 → 核价 → 建待付款单 → 汇总付款入口，全程用瑞幸官方只读/写工具完成。付款由用户本人扫码，插件不代付。
>
> **工具是有状态的会话契约，不是透传**。`luckin_start` 开会话后，槽位、授权、revision、拆单进度都存在会话里；每个工具返回带 `state` / `allowed_actions` / `revision`，宿主据此判断下一步。老的 `luckin_call` / `luckin_batch` 透传工具保留不动，是平行路径。
>
> **"未付款订单最多 3 单"是真实硬约束**（AGENTS.md 实测），不是设计选择。拆单超过 3 单时不会一次下完：先下满 3 单，剩余记进会话，用户付掉几单腾出名额后由 `luckin_wait_payment` 自动续下。
>
> **真实返回字段已实测并固化为夹具**。查店/搜品/核价/订单详情四个接口的真实返回（脱敏后）在 `test/fixtures/`，解析逻辑以它们为基准，不靠猜字段。
>
> **已知局限**：已付款订单的 `orderStatus` 具体码未验证（拓字段那单没付款），续单判断用"非待付款(10)即腾出名额"兜底；比价只有单方案核价，还没做 spec §5.2 的拆单 vs 合单比价。

## 1. 工具契约

七个契约工具，按点单流程排列。参数只列关键项，完整定义见 [../src/server.ts](../src/server.ts)。

| 工具 | 作用 | 关键入参 | 关键返回 | 副作用 |
| --- | --- | --- | --- | --- |
| `luckin_start` | 开会话 / 改单重新起步 | `utterance`（用户原话） | `session_id`、`revision=1`、`missing` | 只建本地会话 |
| `luckin_resolve_order` | 按槽位落用户理解 | `session_id`、`slots`、`authorization`、`expected_revision?` | `resolved`/`missing`、`state` | 改会话，revision+1 |
| `luckin_find_store` | 查附近门店 | `longitude`、`latitude`、`include_closed?` | 营业中门店列表 | 只读 |
| `luckin_get_menu` | 搜商品 | `deptId`、`query` | 商品及默认 sku、价格 | 只读 |
| `luckin_quote_best` | 核价 | `session_id`、`expected_revision?` | `quote`（实付、原价、优惠、券码） | 只读，不占券 |
| `luckin_prepare_checkout` | 建待付款单（唯一建单入口） | `session_id`、`confirm_code?`、`expected_revision?` | 建单结果、付款入口、剩余单提示 | 写：createOrder |
| `luckin_wait_payment` | 付款后自动续下剩余单 | `session_id`、`max_wait_seconds?` | 续单结果或"还在等付款" | 写：createOrder（续单时） |

**调用顺序**：`start` → `resolve_order`（可多次，补槽位）→ `find_store` / `get_menu`（查到的 `deptId` / `productList` 由宿主填回 `resolve_order` 的 `store` / `items` 槽位）→ `quote_best`（核价）→ `prepare_checkout`（建单）→ 超 3 单时 `wait_payment`（续单）→ `luckin_paysheet`（汇总付款入口）。

**槽位与官方参数的落点**：`store` 槽位要存 `{ deptId, longitude, latitude }`，`items` 槽位要存官方 `productList`（每项 `{ productId, skuCode, amount }`）。这两个由宿主从 `find_store` / `get_menu` 的返回里挑好后，通过 `resolve_order` 填入；插件不替宿主猜门店或商品。

## 2. 状态机与会话

**state 目前两档**（[../src/session.ts](../src/session.ts)）：

- `collecting`：还缺必填槽位（`fulfillment` / `store` / `items`），要问用户。
- `items_ready`：三个必填槽位齐全，可以核价、建单。

`revision` 每次改订单内容 +1。写工具可带 `expected_revision`，与当前不符返回 `REVISION_CONFLICT`，不执行——防止宿主拿旧版本的理解去建单。

**授权范围**（`authorization`，spec §5.1）：`select_items`、`auto_substitute`、`allow_split`、`prepare_unpaid_order`、`max_total_cents`。`pay` 不开放，付款永远本人完成。`prepare_unpaid_order=true` 时 `prepare_checkout` 直接建单（付款本身即确认）；未授权时先返回确认码，宿主把金额告诉用户、用户确认后带 `confirm_code` 再调。

**错误码**：`SESSION_NOT_FOUND`、`REVISION_CONFLICT`、`CONSTRAINT_UNSAT`（缺槽位或槽位非法）、`NEEDS_CONFIRM`（未授权建单，返回确认码）。

## 3. 拆单与未付款上限

瑞幸每单只能用一张券，所以多杯拆成每单 1 杯，各用一张券（`previewOrder` 自动选券）。但瑞幸限制**未付款订单最多 3 单**：已有 3 单未付款时再 `createOrder` 返回 `{"code":1000,"msg":"您有未支付订单，请先支付后再下新单吧","success":false}`，不生成订单（2026-11-02 实测，上限是否恒为 3、是否只算同店未验证）。

处理方式（[../src/server.ts](../src/server.ts) 的 `executeBatch` + `luckin_wait_payment`）：

1. `prepare_checkout` 一次最多下 3 单（按当前未付款名额），剩余单记进会话的 `checkout` job（门店、每单上限、已下单的 orderId、未下的 productList）。
2. 返回里提示用户先付掉已下的单。
3. 用户付款后调 `luckin_wait_payment`：有界轮询（默认 25 秒，每 ≥3 秒一次）用 `queryOrderDetailInfo` 查已下单的 `orderStatus`；`orderStatus=10` 是待付款，非 10 视为已腾出名额；一旦有名额就续下剩余单。没腾出就返回"还在等付款"，可重复调。

**防重复下单**：每单建单前先 `previewOrder`；命中限流（"手速太快"）时瑞幸明确没建单，退避重试安全；网络异常时不盲目重试（可能已下单），如实报"结果未知，请先核实"。续单只下 `remaining` 里还没下的，不重放已下的。

**旧 `luckin_batch`**：没有会话和续单路径，保持原行为——连续下所有单，仅保留"命中未付款上限就安全停下"的兜底。要分批续单用 `prepare_checkout` + `wait_payment`。

## 4. 实测字段

真实返回（脱敏后）存在 [../test/fixtures/](../test/fixtures/)，解析在 [../src/luckin.ts](../src/luckin.ts)。字段名以实测为准，官方 schema 不给语义。

| 接口 | 参数 | 用到的字段 |
| --- | --- | --- |
| `queryShopList` | `longitude`、`latitude` | `data[]`：`deptId`、`deptName`、`address`、`longitude`、`latitude`、`workStatus`（"营业中"/"打烊中"）、`workTimeStart/End`、`distance` |
| `searchProductForMcp` | `deptId`、`query`（不是 keyword） | `data[]`：`productId`、`productName`、`skuCode`、`initialPrice`、`estimatePrice`、`fallback` |
| `previewOrder` | `deptId`、`productList` | `data`：`discountPrice`（券后实付）、`totalInitialPrice`、`privilegeMoney`、`couponCodeList`、`shopInfo` |
| `queryOrderDetailInfo` | `orderId`（string） | `data`：`orderStatus`（10=待付款）、`orderStatusName`、`takeMealCodeInfo.code`（付款后出取餐码）、`orderPayAmount` |

坐标是经度在前。高德返回的 GCJ-02 坐标可直接传 `queryShopList`（AGENTS.md 实测）。

## 5. 代码落点

| 文件 | 内容 |
| --- | --- |
| [../src/session.ts](../src/session.ts) | 会话表、revision 校验、授权、拆单 job |
| [../src/envelope.ts](../src/envelope.ts) | 统一返回信封、`allowed_actions` 随 state 变化 |
| [../src/luckin.ts](../src/luckin.ts) | 解析四个官方返回 |
| [../src/server.ts](../src/server.ts) | 七个契约工具、`executeBatch` 共享执行逻辑 |
| [../test/session.test.ts](../test/session.test.ts) | 契约工具端到端测试（含 3 单上限、自动续单） |
| [../test/luckin.test.ts](../test/luckin.test.ts) | 解析器测试，基于真实夹具 |

## 6. 没做的 / 已知问题

- **已付款的 `orderStatus` 码未验证**。拓字段那单没付款，只拿到待付款(10)。续单判断用"非 10 即腾出名额"兜底：逻辑偏保守（宁可多等也不误续），但若待付款和已付款之间有别的中间态，可能偏早续单。有真实付款样本后应校准。
- **没做多单真实付款闭环验证**。只读链路连真实接口跑通；单笔 `createOrder` 下过一单（未付款、已自动取消）拓字段。拆单建多单、付款后续单的全流程未在真实接口上跑过。
- **比价只有单方案核价**。`quote_best` 返回单方案实付，还没做 spec §5.2 的"拆 N 单 vs 一单"比价和基线。
- **会话不持久化**（内存），进程重启即清空。跨会话恢复留到接云端编排时做。
- **`max_total_cents` 平摊成每单上限**：有总额授权时按单数平摊；未给授权用一个宽松上限兜底防止券用完按原价下单。单均上限对价格不均的拆单不够精细。
- spec 的意图识别、推荐算法、云手机、卡片 UI、文案规范均未实现。

