# AGENTS.md

给在这个仓库里工作的 AI agent（Claude Code、Codex 等）看的规则。

## Git 和发布

- **不要直接推 `main`。** 每次改动新建分支（如 `feat/xxx`、`fix/xxx`），推到远程后开 PR，等仓库所有者审核合并。
- 插件是用户直接从 `main` 安装的，合并到 `main` 就等于发布。所以：
  - 推送、开 PR、合并前都要先问用户。
  - 不要在 PR 合并前更新本机已安装的插件（`claude plugin update`）。
- 改了 `src/` 后要运行 `npm run build`，把重新生成的 `bundle/server.mjs` 一起提交。用户安装时不会再 build。
- 发布前在 `.claude-plugin/plugin.json` 里升版本号，不升的话用户的 `claude plugin update` 拿不到新版。
- 提交前确认没有 Token：`grep -rn <token 前几位> --exclude-dir=node_modules --exclude-dir=.git .`

## 验证

- `npm test` 必须全部通过。测试用模拟的上游服务，不连真实瑞幸接口。
- `claude plugin validate .` 必须通过。
- 连真实接口时只能调只读工具（`queryShopList`、`searchProductForMcp`、`previewOrder`、`queryOrderDetailInfo` 等）。`createOrder` 和 `cancelOrder` 会产生真实订单或扣款，必须经用户明确同意。

## 瑞幸官方 MCP 的实际行为（实测，不在官方文档里）

- 地址 `https://gwmcp.lkcoffee.com/order/user/mcp`，`Authorization: Bearer <token>`。Token 在 https://open.lkcoffee.com/mcp 获取，大约一个月过期。
- Token 无效时，HTTP 层返回 `{"message":"访问令牌无效或已过期"}`。
- 业务错误不会设置 MCP 的 `isError`，而是放在正常返回里：`{"code":1000,"msg":"...","success":false}`。要看 `success` 字段。
- 每单只能用一张券。`previewOrder` 会自动选最便宜的那张券，预览时不占用券。
- 券在 `createOrder` 之后马上被占用，不用等付款，所以拆单可以连续下。
- 连续下单太快会被限流：`{"code":1000,"msg":"您手速太快啦，稍后重试吧~"}`，这时不会生成订单，重试是安全的。
- `createOrder` 返回 `payOrderQrCodeUrl`（二维码页）和 `payOrderUrl`（`weixin://`），每单单独付款，不能合并付款。
- 没有领券、查券列表、最近订单列表的接口。查订单只能按订单号，取餐码在 `queryOrderDetailInfo` 的 `takeMealCodeInfo.code`。
- 门店有营业时间，`workStatus` 为"打烊中"时不要下单。

## 产品原则

- 目标是降低用户的使用成本：一条命令安装，Token 在对话里给。
- 涉及钱的选择交给用户，比如合单还是拆单。要先把每种方式的价格和要付几次款列出来。
- 不做绕过官方接口的事，比如抓私有接口领券。
