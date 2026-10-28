# show_me_the_coffees

agents for ordering coffees for you with coupons all you had!

瑞幸点单助手，是一个 Claude Code 插件。瑞幸一单只能用一张券，点 10 杯想都用上券，就得手动下 10 单。装上这个插件后，说一句"点 10 杯生椰拿铁"，它会帮你找店、算价、拆单，你确认一次就能全部下完。

## 安装

需要 Claude Code 2.1.275 及以上，以及 Node.js 20 及以上。

在终端（PowerShell / bash）里运行：

```sh
claude plugin marketplace add LoTFve/show_me_the_coffees
claude plugin install lucky-agent@show-me-the-coffees
```

用终端版 Claude Code 的话，也可以在对话框里输入 `/plugin install lucky-agent --marketplace LoTFve/show_me_the_coffees`。VS Code 版不支持 `/plugin`，请用上面的终端命令。

装完重启 Claude Code。VS Code 里按 `Ctrl+Shift+P`，运行 `Reload Window`。

### 登录

第一次点单时，助手会让你提供瑞幸 Token：

1. 打开 <https://open.lkcoffee.com/mcp>，用手机号和短信验证码登录。
2. 复制页面上的 Token，直接发到对话里。

助手会先验证 Token，有效才保存到本机的 `~/.lucky-agent/token`，只有你能读。Token 大约一个月过期，过期后会提示你重新发一次，不用重启。

## 怎么用

直接用中文说就行，不用记命令。

| 你说 | 助手会做什么 |
| --- | --- |
| 我在科大高新，点 5 杯生椰拿铁 | 找附近门店，查商品和价格，报价后等你确认 |
| 来杯拿铁，超大杯少甜 | 按你说的规格报价 |
| 有什么美式 / 搜一下生椰 | 按关键词搜商品，列出名称、原价和券后价。只能按关键词搜，没有完整菜单 |
| 以后都少冰 / 公司那家店记一下 | 记住偏好或常用门店，下次自动带上 |
| 老样子 | 按你收藏的组合或上一单再点一次 |
| 取餐码是多少 | 按订单号查状态和取餐码 |

### 多杯：拆单还是合单，你来选

点多杯时，助手会把两种下法的价格一起列出来，由你决定：

| | 付款次数 | 合计 | 比合单省 |
| --- | --- | --- | --- |
| 合成一单 | 1 次 | ¥64.5（瑞幸给的准确价） | — |
| 拆单，券够 4 张 | 4 次 | 最多 ¥46 | 约 ¥22 |
| 拆单，只剩 1 张券 | 下 1 单就停 | ¥10.5 | 剩下 3 杯再问你 |

上表是 4 杯生椰拿铁的实际报价。合单时只有 1 杯能用券；拆单时每单各用一张，但每单都要单独扫码付款。

选拆单后：
- 你只确认一次，各单按顺序自动下完。两单之间会停 3 秒，被瑞幸限流（"手速太快"）时会自动重试。
- 每单都设了实付上限。券用完后，下一单会超过上限，就停在那里，不会按原价继续下。
- 下完后一次列出每单的付款二维码和 `weixin://` 链接，挨个扫码就能付完。

### 没有券时

如果预览发现这杯一张券都用不上，助手会提醒你先去瑞幸 App 或微信小程序领券，领完告诉它，它重新算价。不想领就按原价下。

## 安全

- 下单和取消都要你明确确认才执行。确认码只能用一次，5 分钟过期，参数改了就失效。
- 拆单遇到网络异常、不确定有没有下成功时，会停下让你核实，不会盲目重下。
- 付款只能你自己在手机上完成，助手碰不到你的微信。
- Token 只存在本机，只用来请求瑞幸官方接口。

## 限制

这些是瑞幸官方接口的限制，插件绕不开：

- **只能到店自取**，不支持外送。
- **每单单独付款**，没法合并成一次付款。
- **不能领券，也查不了券列表**。券只能去 App 或小程序领；你有几张券，要下单时才知道。
- **没有完整菜单**，只能按关键词搜，每次返回几款推荐。
- **下单后券马上被占用**，不用等付款。
- 门店有营业时间，打烊后不能下单。助手会提醒，并推荐附近还在营业的店。

## 工具

插件提供这些 MCP 工具，平时由助手自动调用，你不用直接用：

| 工具 | 作用 |
| --- | --- |
| `luckin_login` | 验证并保存 Token |
| `luckin_tools` | 列出瑞幸官方工具，标注哪些是写操作 |
| `luckin_call` | 调用官方工具；写操作走两步确认 |
| `luckin_batch` | 拆单下单：每单一张券，整批确认一次，遇错即停 |
| `lucky_profile` | 读取偏好、门店、收藏、最近订单 |
| `lucky_remember` | 保存或删除偏好、门店、收藏 |

## 开发

```sh
npm install
npm test
npm run build        # tsc 检查 + 打包到 bundle/server.mjs
npm run co-diagram   # 从 docs/luckin-co.md 重新生成关系图 HTML
claude --plugin-dir .
```

- `bundle/server.mjs` 是打包好的单文件，提交在仓库里，用户安装时不需要 `npm install`。改了 `src/` 要重新 `npm run build` 再提交。
- 瑞幸领域模型（概念、关系、约束）见 [docs/luckin-co.md](docs/luckin-co.md)，关系图见 [docs/luckin-co-diagram.md](docs/luckin-co-diagram.md)。可交互的版本是 [docs/luckin-co.html](docs/luckin-co.html)，下载后用浏览器打开。
- 给 AI agent 的开发规则见 [AGENTS.md](AGENTS.md)：改动走 PR、提交前测试、PR 描述要求，以及瑞幸接口的实测行为。

可选环境变量：

| 变量 | 说明 |
| --- | --- |
| `LUCKIN_MCP_TOKEN` | 瑞幸 Token，优先于本机保存的 |
| `LUCKIN_MCP_URL` | 官方 MCP 地址，默认 `https://gwmcp.lkcoffee.com/order/user/mcp` |
| `LUCKIN_WRITE_TOOLS` | 逗号分隔，补充需要确认的官方工具名 |
| `LUCKY_AGENT_HOME` | 数据目录，默认 `~/.lucky-agent` |
