# 瑞幸点单 CO（Concept 与 Operator）

按《本体与KE标注SOP》0.14 无 CO 模式建立：先定身份和粒度，再定角色、签名和基数，最后命名。依据是 2026-10-28 对瑞幸官方 MCP（`https://gwmcp.lkcoffee.com/order/user/mcp`）的实际调用结果，下文称"实测"。官方 schema 只给字段，不给语义，所以每个算子的含义和基数都单独写了依据。CO 指 Concept（概念）和 Operator（算子）：第 2 节是 Concept，第 3 节是 Operator，第 4 节是作用在它们上的约束。

状态：候选，未经独立建模比对。第 5 节列出的缺口未解决前，相关契约不能当作已确认。

关系图见 [luckin-co-diagram.md](luckin-co-diagram.md)（GitHub 上直接看）；可交互的版本是 [luckin-co.html](luckin-co.html)，下载后用浏览器打开，点概念能看到它的全部算子。HTML 由 `npm run co-diagram` 从本文件生成，改了算子后重新运行即可。

## 1. 需求拆解

| 需求 | 对象 | 对象间的联系 | 条件 | 输出 |
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
| `Price` | 带单位的量 | 金额 + 人民币 | 用 `unit(Number , yuan)` 构造，不用裸 Number。原价、实付、优惠分别是不同算子，不合并。 |
| `Coordinate` | 复合值 | 经度、纬度 | 门店查询入参，顺序按官方字段名 `longitude`、`latitude`，不按习惯交换。 |
| `Date`、`Time`、`DateTime` | 时间 | — | 营业时间是日内时刻 `Time`；下单时间、取餐时间是 `DateTime`。 |

不建的概念：
- **商品分类**：官方数据里没有分类字段，只有"新品"标签。按名称关键词分类是推断出来的，不能作为领域概念。
- **用户、账户**：只通过 Token 隐含。本体里不出现用户 ID，也不从工具参数接收身份。

## 3. 算子（Operator）

算子是最上层的抽象：凡是"输入一个或多个概念，返回一个结果"的都是算子。关系只是算子的一种。按返回什么、输入几个，本文的 50 个算子分成下面几类：

| 种类 | 返回什么 | 输入 | 数量 | 例子 |
| --- | --- | --- | --- | --- |
| 属性 | 值（字符串、数值、金额、时间、坐标） | 1 个概念 | 17 | `store_name`、`quote_payprice`、`order_pickupcode` |
| 带参数的属性 | 值 | 多个 | 3 | `store_product_initialprice(Store , Product)`：价格随门店变化 |
| 谓词 | Bool | 1 个或多个 | 8 | `is_store_open(Store , DateTime)`、`is_coupon_occupied(Coupon , DateTime)` |
| 二元关系 | 一个概念或一组概念 | 1 个概念 | 15 | `order_store`、`quote_coupon`、`sku_option` |
| 多元关系、变换 | 概念 | 多个 | 6 | `sku_switch(Store , Sku , Option)`：把一个 sku 换成另一个；`store_product_search(Store , String)` |
| 通用算子 | 任意 | 任意概念 | 1 | `count` |

分类的意义在于检查方式不同：属性和带参数的属性要核对单位和时间锚点（SOP 第 7 节）；谓词要说明未知时不等于 false；关系要核对方向和基数；变换要说明输入输出之间的约束（见 4.6）；通用算子不需要领域依据。

每个算子都附上输入角色、基数和依据。单值的意思是"在当前输入下最多一个结果"。

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
- `store_product_attribute_option(Store , Product , Attribute)`：某门店的某商品在某属性下能选的选项，是 `attribute_option` 的子集。比如生椰拿铁的奶油只有"无奶油"。门店是参数，依据是实测：同一款生椰拿铁，国贸店的咖啡豆多一个"埃塞金烘"（774），科大高新店没有。保留两个算子，不合并成一个。
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
- `order_payqrcodeurl`、`order_paydeeplink`：单值，依据是 `payOrderQrCodeUrl`、`payOrderUrl`。每单各有一个，没有合并付款的算子。
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
(o : sku_option(sku_switch(st , s , o)) :- var st : Store , var s : Sku , var o : Option , is_product_option_selectable(st , sku_product(s) , o) = true) ;
```

第一条：每个 sku 在每个属性上恰好选中一个选项。依据是实测的 3 个 sku 都满足。

第二条：切换到某个选项后，新 sku 包含这个选项。写法沿用 SOP 10.9 的成员约束 `x : 集合`。实测超大杯、少甜两次切换都满足。

"同一属性的旧选项被换掉、其他属性不变"在实测中也成立，但要写成规则得先有集合运算接口，这里不写，只在文字中记录（缺口 G7）。

原价随选项加价（大杯 ¥18，超大杯 ¥21）只有一个样本，不写成规则。

### 4.7 下单太快时不生成订单

被限流（`{"code":1000,"msg":"您手速太快啦，稍后重试吧~"}`）的那次调用不生成 `Order`，所以重试不会重复下单。这是工具层的行为，不是领域算子，记在第 7 节的工具契约里，不另建概念。

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
| G8 | `switchProduct` 的 `operation` 各取值的含义。实测 `1`、`3` 结果相同；两个开源项目（smart-luckin、xiaokui-luckin-mcp）都只用 `3` | `sku_switch` 是否需要第 4 个参数表示"选中"或"取消" | 试更多取值（只读），或等官方文档 |

## 6. 选项与别名

`Attribute` 和 `Option` 的取值是本体的一部分，只收实测见过的。正名用瑞幸官方名称；别名是用户口语说法，对所有用户都成立，属于领域词表。别名只能指向一个选项，有歧义的口语不收。

**ID 只在同一种概念内唯一。** 实测属性"气泡"的 ID 是 112，选项"少甜"的 ID 也是 112。所以引用选项时要连同属性一起写，比如 `18/112`（糖度 / 少甜），不能只写 `112`。

| 属性 | 选项 | 正名 | 别名 | 加价 | 见于 |
| --- | --- | --- | --- | --- | --- |
| 64 杯型 | 365 | 大杯 | 大的 | — | 4 款 |
| 64 杯型 | 594 | 超大杯 | 特大杯、最大杯 | +¥3 | 4 款 |
| 17 温度 | 57 | 冰 | 冰的、加冰 | — | 4 款 |
| 17 温度 | 56 | 热 | 热的、温的 | — | 生椰拿铁 |
| 17 温度 | 790 | 全冰去水 | — | — | 全冰黑巧美式 |
| 18 糖度 | 60 | 标准甜 | 正常糖、全糖 | — | 4 款 |
| 18 糖度 | 112 | 少甜 | 少糖 | — | 4 款 |
| 18 糖度 | 59 | 少少甜 | — | — | 4 款 |
| 18 糖度 | 254 | 微甜 | 微糖 | — | 4 款 |
| 18 糖度 | 69 | 不另外加糖 | 无糖、不加糖 | — | 4 款 |
| 50 咖啡豆 | 379 | 意式拼配 | — | — | 4 款 |
| 50 咖啡豆 | 634 | 深烘拼配 | 深烘 | — | 4 款 |
| 50 咖啡豆 | 774 | 埃塞金烘 | — | — | 生椰拿铁（仅国贸店） |
| 113 咖啡浓度 | 706 | 默认浓度 | — | — | 4 款 |
| 113 咖啡浓度 | 707 | 加单份浓缩 | 加浓、加一份浓缩 | +¥3 | 4 款 |
| 16 奶油 | 53 | 无奶油 | — | — | 生椰拿铁 |
| 37 风味 | 830 | 默认黑巧 | — | — | 全冰黑巧美式 |
| 37 风味 | 821 | 多黑巧 | — | +¥2 | 全冰黑巧美式 |
| 102 奶基 | 817 | 液体奶酪 | — | — | 全冰黑巧美式 |
| 102 奶基 | 813 | 丝绒 | — | — | 全冰黑巧美式 |
| 102 奶基 | 869 | 椰浆 | — | — | 全冰黑巧美式 |
| 102 奶基 | 875 | 淡奶油 | — | — | 全冰黑巧美式 |
| 112 气泡 | 699 | 气泡 | 加气泡 | +¥2 | 乳酸菌美式 |
| 112 气泡 | 700 | 无气泡 | 不要气泡 | — | 乳酸菌美式 |
| 114 小料 | 897 | 不含桃丁 | — | — | 紫苏桃气泡美式 |
| 120 吸管 | 797 | 百亿活菌吸管 | — | — | 乳酸菌美式 |

"见于"中的 4 款指 2026-10-29 在科大高新校区店查过详情的生椰拿铁、紫苏桃气泡美式、全冰黑巧美式、乳酸菌美式。没见过的选项不在表里，不代表瑞幸没有。

没收的别名：
- **"中杯"**：实测只有大杯和超大杯，没有中杯。用户说"中杯"多半是想要小的那一档，但这是推断，不是对所有用户都成立，所以不当别名。遇到时告诉用户"没有中杯，最小是大杯"，让用户确认。
- **"去冰""少冰"**：实测温度只有冰、热、全冰去水，没有少冰、去冰。"去冰"和"全冰去水"意思相反，不能当别名。遇到时要告诉用户这款没有这个选项。
- **"半糖"**：对应少甜还是微甜说不准，有歧义，不收。遇到时问用户。
- **"燕麦奶"**等奶类：实测见到的奶基只有液体奶酪、丝绒、椰浆、淡奶油，没有燕麦奶，不收。

加价和 3.2 的 `product_option_extraprice(Product , Option)` 一致：加单份浓缩在 4 款商品上都是 +¥3，所以表里写的是实测值，但签名仍按商品区分，因为多黑巧、气泡只在单款商品上见过。

## 7. 工具契约

工具是瑞幸官方接口和本插件提供的 MCP 工具，不是 CO 里的 Operator。一个工具调用一次会返回多个算子的值，这张表写明每个工具实现了哪些算子，以及调用时的前置条件和效果。实现层的检查以这张表为准。

| 工具 | 读/写 | 前置条件 | 效果 | 实现的算子 |
| --- | --- | --- | --- | --- |
| `queryShopList` | 读 | 有坐标 | 返回附近门店及其当前营业状态 | `coordinate_nearby_store`、`store_name`、`store_address`、`store_coordinate`、`store_opentime`、`store_closetime`、`is_store_open`、`is_store_delivery_supported`、`store_distance` |
| `searchProductForMcp` | 读 | 门店、关键词 | 返回推荐商品，可能有 fallback | `store_product_search`、`is_product_search_fallback`、`product_name`、`is_product_new`、`store_product_initialprice`、`product_defaultsku` |
| `queryProductDetailInfo` | 读 | 门店、商品 | 返回属性、选项、默认值、加价 | `product_attribute`、`store_product_attribute_option`、`option_attribute`、`product_attribute_defaultoption`、`is_product_option_selectable`、`product_option_extraprice` |
| `switchProduct` | 读 | 选项在该门店可选 | 返回新 sku 及其原价、券后预估价 | `sku_switch`、`sku_option`、`sku_product` |
| `previewOrder` | 读 | 门店、订单行 | 生成一条 `Quote`；不占用券（4.4） | `quote_store`、`quote_orderline`、`quote_coupon`、`quote_initialprice`、`quote_payprice`、`quote_discount`、`orderline_sku`、`orderline_product`、`orderline_amount` |
| `createOrder` | 写 | 4.5；`couponCodeList` 来自同一订单行的报价；用户已确认 | 生成 `Order`；券马上被占用（4.3）。被限流时不生成订单（4.7） | `order_store`、`order_orderline`、`order_coupon`、`order_payprice`、`order_payqrcodeurl`、`order_paydeeplink`、`is_order_payment_needed` |
| `queryOrderDetailInfo` | 读 | 订单号 | 返回状态、取餐码 | `order_status`、`order_createtime`、`order_pickuptime`、`order_pickupcode` |
| `cancelOrder` | 写 | 用户已确认 | 订单取消；券是否退回见 G2 | `order_status` 的状态变化 |
| `luckin_batch`（插件） | 写（组合） | 每单都满足 `createOrder` 的前置条件；`quote_payprice` 不超过每单上限；所选券和前面各单不重复 | 依次生成订单；有一单不满足就停 | 组合 `previewOrder` 和 `createOrder` |

有 6 个算子没有工具直接返回，要靠推导或由插件计算：

| 算子 | 怎么得到 |
| --- | --- |
| `attribute_option` | 把各商品的 `store_product_attribute_option` 取并集。官方没有按属性列出全部选项的接口 |
| `coupon_order` | 从订单反查：哪些订单的 `order_coupon` 包含这张券。官方没有按券查订单的接口 |
| `is_coupon_occupied` | 由约束 4.3 推出 |
| `quote_time` | 插件调用 `previewOrder` 的时刻，官方不返回 |
| `is_order_allowed` | 插件的业务规则（4.5），由 `luckin_batch` 在下单前检查 |
| `count` | 通用算子，不对应工具 |

`switchProduct` 的 `operation` 参数：实测 `1` 和 `3` 切换糖度都得到同一个 sku（`SP2077-00933`），官方没有写明各取值的含义，见缺口 G8。

## 8. 本体之外

**本体不包含用户数据。** 本体描述的是瑞幸领域：门店、商品、选项、报价、订单，以及作用在它们上的算子。下面这些是某个用户的数据，放在本体之外维护：

| 数据 | 存在哪里 | 和本体的关系 |
| --- | --- | --- |
| 口味偏好、常用门店、收藏 | 偏好库 `~/.lucky-agent/data.json` | 只引用本体里的 ID，比如 `18/112`、门店 `606675`、sku `SP2077-00933`。不定义新概念，不存选项的文字名称 |
| 瑞幸 Token | `~/.lucky-agent/token` | 无。用户身份只来自 Token，本体里没有用户 |
| 下单记录 | 偏好库的 `orders` | 引用订单号和 sku |

规则：
- 本体不知道偏好库的存在，偏好库依赖本体，反过来不成立。
- 偏好库里的 ID 可能失效，比如门店关闭、选项下架。读取时要检查，失效的提醒用户，不能静默使用。
- 口语别名放在本体（第 6 节），不放在偏好库：别名对所有用户都成立，偏好只对一个用户成立。

现在代码里的偏好库存的还是自由文字（如 `甜度=少甜`），没有引用本体 ID，要另外改。
