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

## 提交前的测试

所有改动提交前都要通过全部测试，有失败就不提交。

- `npm test`（vitest），测试用模拟的上游服务，不连真实瑞幸接口。
- 改了 `src/` 的，还要跑 `npm run build`。它会做 `tsc` 类型检查并重新打包。
- 改了 `.claude-plugin/`、`.mcp.json` 或 `skills/` 的，还要跑 `claude plugin validate .`。
- 改了下单主链路（`luckin_batch`、`luckin_call` 的写操作、`src/upstream.ts`），还要用打包后的 `bundle/server.mjs` 连真实瑞幸接口，跑一遍只读流程：查门店 → 搜商品 → `previewOrder`。数据目录用临时目录（`LUCKY_AGENT_HOME`），跑完删掉。
- 以后加了其他语言的测试（比如 Python 的 `pytest`），也要一起跑。
- 失败的用例和本次改动无关时，可以提交，但要在 PR 描述里写清楚是哪些用例、为什么失败。

连真实接口时只能调只读工具（`queryShopList`、`searchProductForMcp`、`previewOrder`、`queryOrderDetailInfo` 等）。`createOrder` 和 `cancelOrder` 会产生真实订单或扣款，必须经用户明确同意。

## PR 描述

每个 PR 都要有完整的描述，至少写清楚下面四项。只写标题，或者只写"见提交记录"的 PR 不合格。

1. **改了什么、为什么改。**
2. **影响范围**：MCP 工具（名称、参数、返回格式）、Skill 流程、插件配置（`plugin.json`、`.mcp.json`、版本号）、本地数据（`~/.lucky-agent/` 下的文件格式）、环境变量。没有影响的写"无"。
3. **怎么验证的**：跑了哪些测试，结果怎样（比如"`npm test` 17 passed"）；有没有连真实瑞幸接口试过，试了哪些工具；有没有真实下单。
4. **没做的、已知的问题。**

## 给用户的 PR 链接

用户打开链接时，PR 描述必须已经填好上面四项，不需要再复制粘贴任何内容。

- **能用 `gh` 时**：直接 `gh pr create` 建好 PR，给 PR 本身的链接。描述写在 `--body-file` 里，不要用 `--body` 传长文本，那样换行和引号容易出错。
  - 改已有 PR 的描述时，`gh pr edit` 可能因为 GitHub 停用旧版 Projects 而报错（`Projects (classic) is being deprecated`），改不成功。这时改用 REST API：`gh api -X PATCH repos/LoTFve/show_me_the_coffees/pulls/<编号> -f title=... -F body=@<文件>`。
  - 改完用 `gh api repos/LoTFve/show_me_the_coffees/pulls/<编号> --jq .body` 读回来，确认四项都在，再把链接给用户。
- **不能用 `gh` 时**：
  1. 把分支整理成相对目标分支只有一个提交。提交信息第一行写 PR 标题，正文写完整描述。
  2. 给链接前运行 `git rev-list --count origin/<目标分支>..<分支>`，确认结果是 1。
  3. 给短链接：`https://github.com/LoTFve/show_me_the_coffees/compare/<目标分支>...<分支>?expand=1`。分支只有一个提交时，GitHub 会用提交信息自动填好标题和描述。
- **不要把描述放进链接的 `body=` 参数。** 中文编码后很容易超过 GitHub 的 URL 长度上限，打开就会报 "URL is too long"。
- 不要给打开后描述为空或不完整的链接，也不要只把描述贴在对话里，让用户自己复制。

## 鉴权和密钥

- 瑞幸 Token 只在服务端使用：从 `LUCKIN_MCP_TOKEN` 环境变量或 `~/.lucky-agent/token`（权限 600）读取，以 `Authorization: Bearer` 请求头发给上游。
- 不要把 Token 放进 URL 或查询参数，不要写进日志、错误信息、MCP 工具的返回结果，也不要写进 `data.json` 的下单记录。
- 不要把 Token 提交到仓库，也不要写进测试数据。
- 不要信任工具参数里传来的身份信息。用户身份只来自上面这个 Token。

## 瑞幸官方 MCP 的实际行为（实测，不在官方文档里）

- 地址 `https://gwmcp.lkcoffee.com/order/user/mcp`，`Authorization: Bearer <token>`。Token 在 https://open.lkcoffee.com/mcp 获取，大约一个月过期。
- Token 无效时，HTTP 层返回 `{"message":"访问令牌无效或已过期"}`。
- 业务错误不会设置 MCP 的 `isError`，而是放在正常返回里：`{"code":1000,"msg":"...","success":false}`。要看 `success` 字段。
- 每单只能用一张券。`previewOrder` 会自动选最便宜的那张券，预览时不占用券。
- 券在 `createOrder` 之后马上被占用，不用等付款，所以拆单可以连续下。
- **未付款订单最多 3 单**：已有 3 单未付款时，再调 `createOrder` 会返回 `{"code":1000,"msg":"您有未支付订单，请先支付后再下新单吧","success":false}`，不会生成订单。拆单超过 3 单时，要让用户先付掉前面的单，再继续下。2026-11-02 实测：第 1 到 3 单成功，第 4 单被拒。上限是不是固定 3 单、只算同一门店还是全部门店，都还没验证。
- **付款时限约 5 分钟**：下单后约 5 分钟内不付款，订单会被自动取消（`orderStatusName` 变成"已取消"，券退回）。`createOrder` 不返回截止时间，App 的待付款页才显示倒计时。2026-11-03 实测：09:52 下的单 09:57 在 App 里显示"请在 16 秒内完成支付"，随后取消；15:14 下的 3 单几分钟后全部取消。代码里的时限常量是 `src/paysheet.ts` 的 `PAY_WINDOW_MIN`，付款单和下单回复按"下单时刻 + 5 分钟"显示截止时间，是估计值。
- 连续下单太快会被限流：`{"code":1000,"msg":"您手速太快啦，稍后重试吧~"}`，这时不会生成订单，重试是安全的。
- `createOrder` 返回 `payOrderQrCodeUrl`（二维码页）和 `payOrderUrl`（`weixin://`），每单单独付款，不能合并付款。
- 没有领券、查券列表、最近订单列表的接口。查订单只能按订单号，取餐码在 `queryOrderDetailInfo` 的 `takeMealCodeInfo.code`。
- 门店有营业时间，`workStatus` 为"打烊中"时不要下单。
- 门店坐标是经度在前（`longitude`、`latitude`）。高德返回的 `location` 也是"经度,纬度"，坐标系是 GCJ-02，可以直接传给 `queryShopList`。不要用 GPS 原始坐标（WGS-84），国内会偏几百米。瑞幸没有文档说明，2026-10-31 实测：用高德坐标查瑞幸门店，瑞幸返回的距离和两点直线距离逐家一致（0.20 / 0.56 / 1.17 km）。

## 产品原则

- 目标是降低用户的使用成本：一条命令安装，Token 在对话里给。
- 涉及钱的选择交给用户，比如合单还是拆单。要先把每种方式的价格和要付几次款列出来。
