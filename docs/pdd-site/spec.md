# spec：小算盘官网和回调页

## 改动
- 新增 `site/`，纯静态 HTML，内联 CSS，没有 JS 和外部资源：
  - `site/index.html`：官网。
  - `site/pdd/callback/index.html`：回调页。用目录加 `index.html`，这样 `/pdd/callback/` 和 `/pdd/callback` 都能打开。
  - `site/.nojekyll`：不让 Jekyll 处理。
- 新增 `.github/workflows/pages.yml`：`main` 上 `site/**` 有改动时，用官方 `actions/upload-pages-artifact` 和 `actions/deploy-pages` 只发布 `site/` 目录。仓库里其他文件不进站点。
- 新增 `test/site.test.ts`：检查页面内容符合 PRD 规则。

## 对插件和安全的影响
- MCP 工具、Skill、插件配置、本地数据、环境变量：无。不升插件版本号，因为插件文件没变。
- 回调页没有脚本，不读 URL 参数。授权码即使出现在 URL 里，也不会被页面处理或发到别处。
- workflow 权限最小：`contents: read`、`pages: write`、`id-token: write`。
- 仓库公开后，源码和提交历史都可见。公开前已在全部历史里搜过 Token，没有找到。

## 边界情况
- 访问 `/pdd/callback?code=xxx&state=yyy`：照常显示页面。
- 在 Pages 设置好之前合并：workflow 会失败，不影响插件安装。所以先设置 Pages，再合并。
