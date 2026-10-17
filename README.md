# QR 置换台

把图片里的二维码替换成另一个内容无关的二维码——等尺寸、等密度、贴合透视，不扫一次几乎看不出区别。

纯静态、零构建、零依赖上传：识别（jsQR）与生成（qrcode-generator）全部在浏览器本地完成，图片不离开设备。

## 使用

直接打开 `index.html`，或任意静态服务器：

```bash
python3 -m http.server 8931
```

拖入 / 粘贴图片 → 自动检测图中二维码 → 输入替换文本 → 下载或复制结果。

## 部署

生产环境沿用 Cloudflare Pages 项目 **`qr-replace`**，账户 `bab57804ce6e2b0f0431d30a54b23f5d`，生产分支 **`main`**，网址为 [qr-replace.pages.dev](https://qr-replace.pages.dev)。使用 Direct Upload，由 GitHub Actions 管理发布。

`.github/workflows/cloudflare.yml` 在推送和 Pull Request 时检查 JavaScript 语法、运行已提交的模块测试、打包静态文件并执行 Chromium 集成检查。只有 `main` 的推送或在 `main` 手动运行工作流才会发布生产；其他分支和 PR 只检查与构建。

网站仍可直接打开，无需构建或运行时依赖。CI 的“构建”只把 `index.html`、`styles.css`、根目录运行时 `*.js` 和 `vendor/` 复制到 `dist/`，不会改变浏览器代码。README、测试、Git 文件和开发凭据不会上传。新增其他静态资源时，请同时更新 `scripts/build.mjs` 的打包清单。

本地复现 CI（Node.js 24）：

```bash
npm ci
npm run check
npm run build
npx --no-install playwright install chromium
npm run test:browser
```

浏览器检查会导入合成二维码、替换内容、下载 PNG 并回扫验证；已提交的 `tests/*.browser.js` 也会执行。模块测试发现规则为 `tests/*.test.cjs`。开发工具版本固定于 `package-lock.json`。

GitHub 仓库的 [Actions Secrets 设置](https://github.com/sozra/qrcodeReplace/settings/secrets/actions) 必须保存 `CLOUDFLARE_API_TOKEN`。Token 需在上述账户拥有 **Account → Cloudflare Pages → Edit** 权限；账户 ID 为非敏感配置，已写入工作流。请仅在设置页输入凭据，不要提交到仓库或粘贴到聊天。

检查通过后，工作流上传 `static-site` artifact，部署任务下载并发布同一份 `dist/`，不会再次构建。生产发布不会取消正在进行的发布。部署后会校验线上 `/_deployment.json` 的提交号和所有静态资源的 SHA-256，确认生产域名实际提供本次产物；校验失败会使 Actions 失败。

手动发布（本机先运行 `npx --no-install wrangler login`，或安全设置部署环境变量）：

```bash
npm run check
npm run build
npm run test:browser
npm run deploy -- --commit-hash "$(git rev-parse HEAD)"
npm run verify:deployment
```

此仓库不管理 Cloudflare 线上变量、Secret 或绑定，不添加 `wrangler.jsonc`，不运行 `pages secret` 或更新项目配置的命令。后续发布只上传静态产物，线上配置继续在 Cloudflare 控制台管理。部署失败时，在 [Actions](https://github.com/sozra/qrcodeReplace/actions) 检查日志并重新运行；回退可在 Cloudflare Pages 的生产部署记录中选择已成功的部署。
