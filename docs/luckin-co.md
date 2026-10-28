# 瑞幸点单 CO（概念与关系契约）

按《本体与KE标注SOP》0.14 无 CO 模式建立：先定身份和粒度，再定角色、签名和基数，最后命名。依据是 2026-10-28 对瑞幸官方 MCP（`https://gwmcp.lkcoffee.com/order/user/mcp`）的实际调用结果，下文称"实测"。官方 schema 只给字段，不给语义，所以每条关系的含义和基数都单独写了依据。

状态：候选，未经独立建模比对。第 5 节列出的缺口未解决前，相关契约不能当作已确认。

## 1. 需求拆解

| 需求 | 对象 | 关系 | 条件 | 输出 |
| --- | --- | --- | --- | --- |
| 找附近的店 | 门店、坐标 | 门店位于坐标 | 距离、营业状态 | 门店集合 |
| 看菜单 | 门店、商品 | 门店在售商品 | 关键词 | 商品集合 |
| 选规格 | 商品、属性、选项 | 商品有属性，属性有选项 | 选项可选 | 规格（sku） |
| 算价 | 门店、订单行、券 | 报价选券 | 每单至多一张券 | 实付金额、所用券 |
| 下单、拆单 | 订单、订单行、券 | 订单用券 | 门店营业、券未被占用、实付不超过上限 | 订单、付款方式 |
| 取餐 | 订单 | 订单有取餐码 | 订单已付款 | 取餐码 |

## 2. 概念

| 概念 | 语义角色 | 身份依据（实测字段） | 说明 |
| --- | --- | --- | --- |
| `Store` | 有身份的对象 | `deptId` | 同名门店可以不同。 |
| `Product` | 有身份的对象 | `productId` | 同一商品在不同门店价格可以不同（生椰拿铁国贸店原价 ¥20，科大高新店 ¥18），所以价格挂在"商品 × 门店"上，不挂在商品上。 |
| `Attribute` | 领域类别 | `attributeId` | 杯型、温度、糖度、咖啡豆、浓度、奶油等。实测 4 款商品中，同名属性的 ID 一致（杯型 64、温度 17、糖度 18、咖啡豆 50、浓度 113），所以作为跨商品共享的类别，不按商品复制。 |
| `Option` | 领域类别 | `attributeId`（子层） | 大杯 365、超大杯 594、冰 57、热 56、少甜 112 等。每个选项属于一个属性。 |
| `Sku` | 有身份的对象 | `skuCode` | 下单的必填字段。实测每种选项组合对应一个 sku：大杯 `SP2077-01134`、超大杯 `SP2077-01033`、少甜 `SP2077-00933`。选项一定，sku 就一定，见 3.2 的 `sku_option`。 |
| `Coupon` | 有身份的对象 | 券码，如 `SY…1954` | 只能通过报价看到，没有查券列表的接口。 |
| `Quote` | 记录 | 无官方 ID | 每次预览都是一次独立计算。同样的商品，在不同时刻、券不同时结果也不同，所以要建成记录，不能挂成商品属性。 |
| `OrderLine` | 记录 | 无官方 ID | 订单中的一行：商品、sku、数量。 |
| `Order` | 有身份的对象 | `orderIdStr` | 用字符串，不用 Number：实测 `orderId` 为 19 位，超过 JS 安全整数范围。 |
| `OrderStatus` | 领域类别 | `orderStatus` | 实测见到 80 =「已完成」，其他取值未见到。 |
| `Price` | 带单位的量 | 金额 + 人民币 | 用 `unit(Number , yuan)` 构造，不用裸 Number。原价、实付、优惠分别是不同关系，不合并。 |
| `Coordinate` | 复合值 | 经度、纬度 | 门店查询入参，顺序按官方字段名 `longitude`、`latitude`，不按习惯交换。 |
| `Date`、`Time`、`DateTime` | 时间 | — | 营业时间是日内时刻 `Time`；下单时间、取餐时间是 `DateTime`。 |

不建的概念：
- **商品分类**：官方数据里没有分类字段，只有"新品"标签。按名称关键词分类是推断出来的，不能作为领域概念。
- **用户、账户**：只通过 Token 隐含。本体里不出现用户 ID，也不从工具参数接收身份。

## 3. 关系（op）

每条关系附上输入角色、基数和依据。单值的意思是"在当前输入下最多一个结果"。

### 3.1 门店

```ke
concept Store ,
concept Coordinate ,
concept Time ,
concept DateTime ,

op store_name(Store) : String ,
op store_address(Store) : String ,
op store_coordinate(Store) : Coordinate ,
op store_opentime(Store) : Time ,
op store_closetime(Store) : Time ,
op is_store_open(Store , DateTime) : Bool ,
op is_store_delivery_supported(Store) : Bool ,
op coordinate_nearby_store(Coordinate) : set(Store) ,
op store_distance(Store , Coordinate) : Number ;
```

- `store_opentime`、`store_closetime`：单值。依据是 `workTimeStart`、`workTimeEnd`，实测每家店各一个。
- `is_store_open(Store , DateTime)`：营业状态会随时间变化，所以时间是参数。官方 `workStatus` 只是查询那一刻的值（科大高新店 17:54 前营业，18:00 后"打烊中"），不能当成门店的固定属性。
- `coordinate_nearby_store`：多值，依据是 `queryShopList` 返回列表（实测 8 家）。
- `store_distance`：单位是公里，依据是实测 `distance: 0.5867` 和地图距离对得上。官方没有写明单位，见缺口 G5。

### 3.2 商品与规格

```ke
concept Store ,
concept Product ,
concept Attribute ,
concept Option ,
concept Sku ,
concept Price ,

op product_name(Product) : String ,
op store_product_search(Store , String) : set(Product) ,
op is_product_search_fallback(Store , String , Product) : Bool ,
op is_product_new(Product) : Bool ,
op store_product_initialprice(Store , Product) : Price ,
op product_attribute(Product) : set(Attribute) ,
op attribute_option(Attribute) : set(Option) ,
op option_attribute(Option) : Attribute ,
op store_product_attribute_option(Store , Product , Attribute) : set(Option) ,
op product_attribute_defaultoption(Product , Attribute) : Option ,
op is_product_option_selectable(Store , Product , Option) : Bool ,
op product_option_extraprice(Product , Option) : Price ,
op product_defaultsku(Store , Product) : Sku ,
op sku_product(Sku) : Product ,
op sku_option(Sku) : set(Option) ,
op sku_switch(Store , Sku , Option) : Sku ;
```

- `store_product_search`：多值，依据是实测搜"咖啡"返回 3 款、搜"菜单"返回空集合。只是推荐，不是完整菜单，不能用来推出"门店只卖这些"。
- `is_product_search_fallback`：搜不到时官方会塞默认推荐，标 `fallback: true`。"是不是推荐"取决于这次搜的词，所以关键词是参数，不是商品属性。
- `store_product_initialprice`：单值，依据是 `initialPrice`。不挂在 `Product` 上，因为跨门店实测价格不同。
- `store_product_attribute_option(Store , Product , Attribute)`：某门店的某商品在某属性下能选的选项，是 `attribute_option` 的子集。比如生椰拿铁的奶油只有"无奶油"。门店是参数，依据是实测：同一款生椰拿铁，国贸店的咖啡豆多一个"埃塞金烘"（774），科大高新店没有。保留两层关系，不合并成一层。
- `option_attribute`：单值。每个选项只属于一个属性，依据是实测中选项的 ID 只出现在一个属性组下。
- `product_attribute_defaultoption`：单值，依据是 `queryProductDetailInfo` 中每个属性有且只有一个 `selected: true`（实测 6 个属性都是如此）。
- `is_product_option_selectable`：依据是 `canSelected: 1`。门店缺货时可能变，所以门店是参数（推断，未实测到不可选的情况）。
- `product_option_extraprice`：依据是选项的 `price`（超大杯 +¥3，加单份浓缩 +¥3）。国贸店和科大高新店实测加价一致，所以按商品取，不加门店参数。只比了两家店，样本少，见缺口 G4。
- `sku_option`：多值。依据是 `switchProduct` 返回的新 sku 中，每个属性正好一个 `selected: true`。
- `sku_switch(Store , Sku , Option)`：单值。把 sku 的某一个选项换成另一个，得到新 sku，对应 `switchProduct`。实测超大杯 `01134 → 01033`，少甜 `01134 → 00933`，切换后原价变为原价加选项加价（¥18 + ¥3 = ¥21）。

### 3.3 报价与券

```ke
concept Store ,
concept Product ,
concept Sku ,
concept OrderLine ,
concept Quote ,
concept Coupon ,
concept Price ,

op quote_store(Quote) : Store ,
op quote_orderline(Quote) : set(OrderLine) ,
op quote_coupon(Quote) : set(Coupon) ,
op quote_initialprice(Quote) : Price ,
op quote_payprice(Quote) : Price ,
op quote_discount(Quote) : Price ,
op orderline_sku(OrderLine) : Sku ,
op orderline_product(OrderLine) : Product ,
op orderline_amount(OrderLine) : Number ;
```

- `quote_coupon`：集合，因为官方 `couponCodeList` 是数组。但实测元素数最多为 1。"一单最多一张券"写成约束（4.1），不改成单值签名，以免官方以后支持叠券时契约失效。
- `quote_payprice`、`quote_initialprice`、`quote_discount`：三者都单值，分别对应 `discountPrice`、`totalInitialPrice`、`privilegeMoney`。实测 18 − 8.1 = 9.9、20 − 9.1 = 10.9，满足 4.2 的等式，但这只是观察到的结果，官方没有说明，见缺口 G3。
- 报价不占用券：同一张券在多次预览中重复出现（`SY…2662` 在国贸店和科大高新店的预览中都被选中），所以报价不是事件，不改变券的状态。

### 3.4 订单

```ke
concept Order ,
concept OrderLine ,
concept OrderStatus ,
concept Coupon ,
concept Store ,
concept Price ,
concept DateTime ,

op order_store(Order) : Store ,
op order_orderline(Order) : set(OrderLine) ,
op order_coupon(Order) : set(Coupon) ,
op order_payprice(Order) : Price ,
op order_status(Order , DateTime) : OrderStatus ,
op order_createtime(Order) : DateTime ,
op order_pickuptime(Order) : DateTime ,
op order_pickupcode(Order) : String ,
op order_payqrcodeurl(Order) : String ,
op order_paydeeplink(Order) : String ,
op is_order_payment_needed(Order) : Bool ,
op coupon_order(Coupon) : set(Order) ;
```

- `order_status(Order , DateTime)`：状态会随时间变化，所以时间是参数。实测同一订单下单后待付款，后来变成"已完成"（80）。
- `order_pickupcode`：单值，用 String。依据是 `takeMealCodeInfo.code: "640"`，取餐码是给人念的编码，不做数值运算。
- `order_payqrcodeurl`、`order_paydeeplink`：单值，依据是 `payOrderQrCodeUrl`、`payOrderUrl`。每单各有一个，没有合并付款的关系。
- `coupon_order`：多值，因为取消订单后券可能退回再用，一张券的历史上可能关联多单（未验证，见缺口 G2）。在任意时刻至多关联一张有效订单，写成约束 4.3。

## 4. 约束与规则

只写充分条件，不反推。

### 4.1 每次报价、每个订单最多一张券

```ke
op count(Concept) : Number ,

(count(quote_coupon(q)) <= 1 :- var q : Quote) ,
(count(order_coupon(o)) <= 1 :- var o : Order) ;
```

依据：同一单 2 杯，实测只有 1 杯打折（科大高新店 1 杯 ¥9.9、2 杯 ¥28.9）。

### 4.2 实付 = 原价 − 优惠

```ke
(quote_payprice(q) = quote_initialprice(q) - quote_discount(q) :- var q : Quote) ;
```

观察结果，不是官方定义（缺口 G3）。

### 4.3 下单后券马上被占用，不用等付款

```ke
op is_coupon_occupied(Coupon , DateTime) : Bool ,

(is_coupon_occupied(c , t) = true :- var o : Order , var c : order_coupon(o) , var t : DateTime , t >= order_createtime(o)) ;
```

依据：第 1 单下单后、还没付款时，第 2 单的预览选了另一张券。这条规则只说明下单后券被占用，不说明取消后券是否释放（缺口 G2）。

### 4.4 报价只选未被占用的券

```ke
op quote_time(Quote) : DateTime ,

(is_coupon_occupied(c , quote_time(q)) = false :- var q : Quote , var c : quote_coupon(q)) ;
```

### 4.5 下单的前置条件

这是本插件的业务规则，不是官方约束：官方没有拦打烊下单，我们自己拦。

```ke
op is_order_allowed(Order) : Bool ,

(is_order_allowed(o) = true :- var o : Order , is_store_open(order_store(o) , order_createtime(o)) = true) ;
```

### 4.6 选项决定 sku，原价随选项加价

```ke
op count(Concept) : Number ,

(count({o | var o : sku_option(s) , option_attribute(o) = a}) = 1 :- var s : Sku , var a : product_attribute(sku_product(s))) ,
(sku_option(sku_switch(st , s , o)) : Option :- var st : Store , var s : Sku , var o : Option , is_product_option_selectable(st , sku_product(s) , o) = true) ;
```

第一条：每个 sku 在每个属性上恰好选中一个选项。依据是实测的 3 个 sku 都满足。

第二条只表示切换结果是一个合法的 sku。"切换后包含新选项、同一属性的旧选项被换掉、其他属性不变"在实测中成立，但要写成规则得先有集合运算接口，这里不写，只在文字中记录。

原价随选项加价的关系（大杯 ¥18，超大杯 ¥21）只有一个样本，不写成规则。

### 4.7 下单太快时不生成订单

被限流（`{"code":1000,"msg":"您手速太快啦，稍后重试吧~"}`）的那次调用不生成 `Order`，所以重试不会重复下单。这是操作层的行为，不是领域关系，记在第 6 节的操作契约里，不另建概念。

依据：限流那次调用之后，`luckin_batch` 只记录了第 1 单，查订单也只有一单。

## 5. 缺口

| 编号 | 缺口 | 会改变什么 | 怎么补 |
| --- | --- | --- | --- |
| G1 | ~~换选项后 `skuCode` 会不会变~~ **已解决**：会变，每种选项组合对应一个 sku | `OrderLine` 只挂 sku 即可 | 已用 `switchProduct` 实测 |
| G2 | 取消订单后券会不会退回 | 4.3 能否加"取消即释放"的规则；`coupon_order` 的基数 | 下单再取消，要用户同意 |
| G3 | 实付、原价、优惠三者的官方定义 | 4.2 是不是恒等式 | 只能从更多样本观察，官方没有文档 |
| G4 | ~~选项加价是不是跨门店一致~~ **部分解决**：两家店一致 | 暂不加门店参数；店更多时可能要改 | 再抽几家店查 |
| G7 | 选项切换的完整语义：同一属性的旧选项是否一定被换掉、其他属性是否一定不变 | 4.6 第二条能不能写完整 | 要先有集合差、并的运算接口 |
| G5 | `distance` 的单位 | `store_distance` 的返回类型要不要改成带单位的 `Length` | 官方没有文档，目前只能凭经验判断 |
| G6 | `OrderStatus` 除了 80 以外还有哪些取值 | 状态枚举和 `is_order_payment_needed` 的推导 | 观察更多订单 |

## 6. 操作（Operator）

概念层之外，每个官方工具和插件工具都按"读或写、前置条件、效果"记一份契约。实现层的检查以这张表为准。

| 操作 | 读/写 | 前置条件 | 效果 | 对应关系 |
| --- | --- | --- | --- | --- |
| `queryShopList` | 读 | 有坐标 | 返回门店及营业状态 | `coordinate_nearby_store`、3.1 |
| `searchProductForMcp` | 读 | 门店、关键词 | 返回推荐商品，可能有 fallback | `store_product_search` |
| `queryProductDetailInfo` | 读 | 门店、商品 | 返回属性、选项、默认值、加价 | 3.2 |
| `switchProduct` | 读 | 选项在该门店可选 | 返回新 sku 及其原价、券后预估价 | `sku_switch` |
| `previewOrder` | 读 | 门店、订单行 | 生成 `Quote`；不占用券 | 3.3、4.4 |
| `createOrder` | 写 | 4.5；`couponCodeList` 来自同一订单行的报价；用户已确认 | 生成 `Order`；券被占用（4.3）。被限流时不生成订单（4.7） | 3.4 |
| `queryOrderDetailInfo` | 读 | 订单号 | 返回状态、取餐码 | `order_status`、`order_pickupcode` |
| `cancelOrder` | 写 | 用户已确认 | 订单取消；券是否退回见 G2 | — |
| `luckin_batch` | 写（组合） | 每单都满足 `createOrder` 的前置条件；`quote_payprice` 不超过每单上限；所选券和前面各单不重复 | 依次生成订单；有一单不满足就停 | 组合 `previewOrder` 和 `createOrder` |
