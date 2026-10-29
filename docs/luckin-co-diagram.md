# 瑞幸点单 CO 关系图

这是 [luckin-co.md](luckin-co.md) 的可视化版本，概念和算子以那份文档为准。图里的每条边都对应一个返回概念的算子（Operator），边上的标签就是算子名称。算子分属性、谓词、关系、变换等几类（见 `luckin-co.md` 第 3 节），图里只画返回概念的那几类，即二元关系，以及多元关系和变换（按第一个输入画）。

- 框：概念（Concept）。
- 线：一个返回概念的算子，从输入概念指向返回概念。`||` 表示单值，`o{` 表示多值（集合）。
- 属性（返回值）和谓词（返回 Bool）列在框里。

```mermaid
erDiagram
    Store ||--o{ Product : "store_product_search(Store, String)"
    Product ||--o{ Attribute : "product_attribute"
    Attribute ||--o{ Option : "attribute_option"
    Option }o--|| Attribute : "option_attribute"
    Sku }o--|| Product : "sku_product"
    Sku ||--o{ Option : "sku_option"
    Store ||--o{ Sku : "product_defaultsku(Store, Product) / sku_switch(Store, Sku, Option)"

    Quote }o--|| Store : "quote_store"
    Quote ||--o{ OrderLine : "quote_orderline"
    Quote ||--o{ Coupon : "quote_coupon（≤1，约束4.1）"

    Order }o--|| Store : "order_store"
    Order ||--o{ OrderLine : "order_orderline"
    Order ||--o{ Coupon : "order_coupon（≤1，约束4.1）"
    Coupon ||--o{ Order : "coupon_order"
    Order }o--|| OrderStatus : "order_status(Order, DateTime)"

    OrderLine }o--|| Sku : "orderline_sku"
    OrderLine }o--|| Product : "orderline_product"

    Store {
        String store_name
        String store_address
        Coordinate store_coordinate
        Time store_opentime
        Time store_closetime
        Bool is_store_open "参数 DateTime"
        Bool is_store_delivery_supported
    }
    Product {
        String product_name
        Bool is_product_new
        Price store_product_initialprice "参数 Store"
    }
    Option {
        Price product_option_extraprice "参数 Product"
        Bool is_product_option_selectable "参数 Store, Product"
    }
    Quote {
        Price quote_initialprice
        Price quote_discount
        Price quote_payprice "= 原价 − 优惠（约束4.2）"
        DateTime quote_time
    }
    OrderLine {
        Number orderline_amount
    }
    Order {
        String orderIdStr "身份"
        Price order_payprice
        DateTime order_createtime
        DateTime order_pickuptime
        String order_pickupcode
        String order_payqrcodeurl
        String order_paydeeplink
        Bool is_order_payment_needed
    }
    Coupon {
        String code "身份，只能从报价中看到"
        Bool is_coupon_occupied "参数 DateTime（约束4.3）"
    }
```

## 下单流程中的工具

下面是点单时调用工具的顺序。工具不是 CO 里的 Operator，每个工具实现了哪些算子见 `luckin-co.md` 第 7 节。普通框是读工具，双线框是写工具，菱形是前置条件检查。

```mermaid
flowchart LR
    A[queryShopList<br/>找门店] --> B[searchProductForMcp<br/>搜商品]
    B --> C[queryProductDetailInfo<br/>查属性和选项]
    C --> D[switchProduct<br/>换选项 → 新 sku]
    D --> E[previewOrder<br/>报价、自动选券<br/>不占用券]
    C --> E
    E --> F{门店营业中？<br/>实付 ≤ 上限？<br/>券未被前面各单用过？<br/>用户已确认？}
    F -- 是 --> G[[createOrder<br/>生成订单，券马上被占用]]
    F -- 否 --> H[停下，告诉用户原因]
    G -- 被限流，未生成订单 --> G
    G --> I[用户扫码付款]
    I --> J[queryOrderDetailInfo<br/>查状态、取餐码]
    G -. 拆单：下一单 .-> E
```

## 维护

改了 `luckin-co.md` 里的算子声明后，要同步改这张图。图里每条边的标签是算子名称，搜一下名称就能对上。
