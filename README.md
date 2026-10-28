# show_me_the_coffees

agents for ordering coffees for you with coupons all you had!

瑞幸点单助手。瑞幸一单只能用一张券，点 10 杯就要手动下 10 单。这个插件帮你自动拆单，每单用一张券，整批只需确认一次。

## 安装

需要 Claude Code 2.1.275 及以上，以及 Node.js 20 及以上。

在 Claude Code 对话框里输入（不是终端）：

```
/plugin install lucky-agent --marketplace LoTFve/show_me_the_coffees
```

或者在终端（PowerShell / bash）里运行：

```sh
claude plugin marketplace add LoTFve/show_me_the_coffees
claude plugin install lucky-agent@show-me-the-coffees
```

装完重启 Claude Code。

装好后直接说"点 10 杯生椰拿铁"。第一次用时会让你登录：

1. 打开 <https://open.lkcoffee.com/mcp>，用手机号和短信验证码登录
2. 复制页面上的 Token，发到对话里

Token 保存在本机 `~/.lucky-agent/token`，只有你能读。大约一个月过期，过期后会提示你重新发一次。

## 能做什么

- 拆单用券：每单先预览，用瑞幸自动选出的券下单。实付超过上限或券重复就停，不会在券用完后按原价继续下
- 下单保护：下单和取消必须你确认，确认码一次性、5 分钟过期、参数改了就失效
- 记住偏好：口味、常用门店、收藏的组合，下次说"老样子"就行

官方接口目前只支持到店自取。

## 工具

| 工具 | 作用 |
| --- | --- |
| `luckin_login` | 验证并保存 Token |
| `luckin_tools` | 列出官方工具，标注哪些是写操作 |
| `luckin_call` | 调用官方工具；写操作走两步确认 |
| `luckin_batch` | 拆单下单：每单一张券，整批确认一次，遇错即停 |
| `lucky_profile` | 读取偏好、门店、收藏、最近订单 |
| `lucky_remember` | 保存 / 删除偏好、门店、收藏 |

## 开发

```sh
npm install
npm test
npm run build   # tsc 检查 + 打包到 bundle/server.mjs
claude --plugin-dir .
```

`bundle/server.mjs` 是打包好的单文件，提交在仓库里，用户安装时不需要 `npm install`。改了 `src/` 记得重新 `npm run build` 再提交。

可选环境变量：`LUCKIN_MCP_TOKEN`（优先于保存的 Token）、`LUCKIN_MCP_URL`（默认 `https://gwmcp.lkcoffee.com/order/user/mcp`）、`LUCKIN_WRITE_TOOLS`、`LUCKY_AGENT_HOME`。
