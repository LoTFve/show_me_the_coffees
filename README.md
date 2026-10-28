# lucky-agent

瑞幸点单助手。一个本地 MCP Server，叠在瑞幸官方 MCP 之上，增加：

- 本地记忆：口味偏好、常用门店、收藏组合、最近订单（`~/.lucky-agent/data.json`）
- 拆单用券：10 杯拆成 10 单，每单用一张不同的券；整批只确认一次，逐单下单，失败即停，结果未知时不会自动重试
- 下单保护：下单 / 支付 / 取消等写操作必须二次确认，确认码一次性、5 分钟过期、参数改了就失效
- 配套 Skill：`skills/luckin-order/SKILL.md` 规定点单流程

## 工具

| 工具 | 作用 |
| --- | --- |
| `luckin_tools` | 列出官方工具，标注哪些是写操作 |
| `luckin_call` | 调用官方工具；写操作走两步确认 |
| `luckin_batch` | 拆单批量下单：每单各用一张券，整批确认一次，逐单执行，遇错即停 |
| `lucky_profile` | 读取偏好、门店、收藏、最近订单 |
| `lucky_remember` | 保存 / 删除偏好、门店、收藏 |

## 配置

打开 <https://open.lkcoffee.com/mcp>，用手机号和短信验证码登录，复制页面上的 Token。Token 大约一个月过期。

| 环境变量 | 说明 |
| --- | --- |
| `LUCKIN_MCP_TOKEN` | 官方 token，以 `Authorization: Bearer` 发送，不落盘 |
| `LUCKIN_MCP_URL` | 可选，官方 MCP 地址，默认 `https://gwmcp.lkcoffee.com/order/user/mcp` |
| `LUCKIN_WRITE_TOOLS` | 可选，逗号分隔，补充需要确认的官方工具名 |
| `LUCKY_AGENT_HOME` | 可选，数据目录，默认 `~/.lucky-agent` |

写操作按工具名识别（含 create / submit / pay / cancel 等，且不含 query / list / get 等）。拿到官方工具列表后，先用 `luckin_tools` 核对 `write` 标注，漏判的加进 `LUCKIN_WRITE_TOOLS`。

## 使用

```sh
npm install
npm run build
npm test
```

作为 Claude Code 插件加载（含 Skill 和 MCP）：

```sh
claude --plugin-dir .
```

或只注册 MCP：

```sh
claude mcp add lucky-agent -e LUCKIN_MCP_URL=<url> -e LUCKIN_MCP_TOKEN=<token> -- node /path/to/lucky-agent/dist/index.js
```
