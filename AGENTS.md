# 项目与部署约定

- 本项目是纯静态浏览器应用，二维码识别和生成在本机浏览器完成。保留直接打开 `index.html` 的使用方式；npm 依赖仅用于开发检查和发布。
- GitHub 仓库：`sozra/qrcodeReplace`。生产分支为 `main`；Cloudflare Pages 项目为 `qr-replace`，账户 ID 为 `bab57804ce6e2b0f0431d30a54b23f5d`，生产网址为 `https://qr-replace.pages.dev`。沿用 Pages Direct Upload，不自动迁移到 Workers 或新增同名目标。
- `.github/workflows/cloudflare.yml` 对推送和 PR 执行检查与构建；仅 `main` 推送及在 `main` 手动触发时部署。不要让 PR 或其他分支访问部署凭据或发布生产。
- 使用 Node.js 24 和 `npm ci`；Wrangler、Playwright 版本固定在 lockfile，Actions 固定到官方提交 SHA。更新依赖时同步 lockfile。
- 验证命令：`npm run check`、`npm run build`、`npx --no-install playwright install chromium`、`npm run test:browser`。检查会执行已提交的 `tests/*.test.cjs` 和 `tests/*.browser.js`；浏览器冒烟检查必须完成图片导入、二维码替换、PNG 下载和回扫。
- `scripts/build.mjs` 只复制 `index.html`、`styles.css`、根目录运行时 `*.js` 和 `vendor/` 到 `dist/`，并生成带提交号和资源哈希的 `_deployment.json`。新增资源时更新打包清单；禁止直接上传仓库根目录。
- 发布命令：`npm run deploy -- --commit-hash "$GITHUB_SHA" --commit-dirty=false`，实际执行 `wrangler pages deploy dist --project-name qr-replace --branch main`。发布经检查的 artifact，不重新生成另一份产物；随后运行 `npm run verify:deployment`，验证生产域名的提交号和所有资源哈希。
- GitHub 部署 Secret 为 `CLOUDFLARE_API_TOKEN`，仅在部署任务暴露。缺少时打开仓库的 Actions Secrets 设置页让用户填写；不要在聊天索取、输出、提交或复制本机 OAuth Token 到 GitHub。账户 ID 不是密钥。
- Cloudflare 线上变量、Secret、绑定和域名由控制台管理。不要添加会接管线上配置的 Wrangler 文件，也不要在 CI 设置、覆盖或删除这些配置。变更部署目标须先确认现有约定。
- 保留用户无关的未提交修改；只暂存本次相关文件或文档片段。推送前检查 `git status`、暂存 diff 和本地/远程分支差异，不能顺带发布未获授权的业务提交。文档已被用户修改时，保留原文，只补充相关部署段落。
