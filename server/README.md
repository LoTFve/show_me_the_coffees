# 本体库总服务器

团队共同维护瑞幸点单本体库（Concept 与 Operator）的服务，部署在 agent2c（`192.168.62.133`），只给团队成员用。

- 浏览：概念、算子（按属性、谓词、关系等分类）、属性、选项。
- 编辑：增删改选项和口语别名，保存前统一校验，比如一个别名只能指向一个选项。每次改动都记录是谁改的、改了什么。
- 发布：导出的 JSON 和仓库里的 `ontology/luckin.json` 格式相同。改好后提 PR 到本仓库，合并后插件和个人本地后台才会用上。服务器上的改动不会直接影响插件用户。

不存任何用户数据。偏好、Token、下单记录都在用户本机，见 `docs/luckin-co.md` 第 8 节。

## 运行

需要 Node 20 及以上，不依赖第三方包。

```sh
node server/index.mjs
```

| 环境变量 | 说明 | 默认 |
| --- | --- | --- |
| `CO_HOST` / `CO_PORT` | 监听地址 | `127.0.0.1` / `8790` |
| `CO_DATA` | 本体数据文件，第一次启动时从 `ontology/luckin.json` 复制 | `server/data/luckin.json` |
| `CO_MEMBERS` | 成员令牌文件，权限 600 | `server/data/members.json` |

只监听 127.0.0.1，团队成员通过 SSH 隧道访问：

```sh
ssh -N -L 8790:127.0.0.1:8790 agent2c-marx
```

然后打开 <http://127.0.0.1:8790/>。

## 成员

每个成员一个令牌，编辑记录里写的是成员名。添加成员：

```sh
node server/members.mjs add <名字>
```

令牌只在命令行里显示这一次，文件里只存它的 sha256。网页上输入令牌后会存进浏览器的 cookie（`HttpOnly`、`SameSite=Strict`），之后请求都带着它。脚本可以用 `X-Member-Key` 请求头。令牌不放进 URL。

## 部署到 agent2c

用户级 systemd 服务（marx 已开启 linger，断开 SSH、服务器重启后都会继续运行）：

```sh
systemctl --user status luckin-co
journalctl --user -u luckin-co -f
```

服务文件见 `server/luckin-co.service`。
