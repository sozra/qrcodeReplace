# QR 置换台

在图片中定位二维码、替换内容，并按原区域的尺寸和透视绘制新码。

纯静态、零构建、零依赖上传：识别（jsQR）与生成（qrcode-generator）全部在浏览器本地完成，图片不离开设备。

## 使用

直接打开 `index.html`（`file://`），无需安装或构建。也可以在项目目录启动静态服务器：

```bash
python3 -m http.server 8931
```

然后访问 [本地页面](http://localhost:8931)。

拖入 / 粘贴 / 选择图片 → 自动检测二维码 → 输入替换文本 → 调整区域 → 验证并下载或复制结果。

识别、编辑和 PNG 下载可在本地文件模式下使用。复制图片需要浏览器支持剪贴板 API 并允许写入；复制不可用时可下载 PNG。

## 导出前扫描验证

- 点击「下载 PNG」或「复制结果」后，先生成最终 PNG，再从该 PNG 的像素中逐个扫描已启用的替换区域，检查解码内容是否与当前替换文本一致。
- 「验证结果」可提前运行同样的检查，不会下载或复制图片。侧栏按二维码编号显示「通过」「未通过」或「未验证」；停用替换的区域不参与验证。
- 若有已启用区域未通过或未能验证，导出前会显示确认框。可以「返回检查」，调整四角、缩短内容后重试，也可明确选择「仍然下载」或「仍然复制」。
- 修改内容或区域后，旧验证结果会清除，下一次导出重新验证。查看原图、缩放和平移不改变实际导出内容。

验证通过表示当前 jsQR 解码器能从导出图片读出预期内容，不代表所有扫码软件或再次压缩后的图片都能识别。若替换文本过长，应用会显示容量错误并暂停导出；容量允许时，新码版本可能自动增加，检测卡片会显示原码和新码版本。

## 手动框选与四角调整

1. 自动检测遗漏时，点击预览区「手动框选」，拖出二维码范围。
2. 应用会对原图的局部区域重新扫描；识别成功后采用识别出的四角。识别失败时也会添加手动区域，可继续编辑。
3. 点击二维码或检测卡片的「调整四角」，拖动四个黄色手柄，使其贴合实际码区边缘，**不要把外围白边算入码区**。可先放大再调整透视。
4. 使用「验证结果」检查效果。区域可「停用替换」或「移除」；误操作可撤销。框选过程中按 `Esc` 或点击「取消」退出。

重新扫描会保留已有编辑和手动区域。点击卡片只选中目标，是否替换由卡片上的独立按钮控制。

## 对比、缩放与撤销

「原图对比」切换原图和编辑结果；查看原图时，按钮变为「返回结果」。导出始终使用编辑结果，预览上的框线和手柄不会进入 PNG。

预览区支持 `+` / `−` 按钮、鼠标滚轮和触屏双指缩放；拖动空白位置或启用「平移」后拖动图片可移动视图。「适应」恢复整图预览。

| 快捷键 | 操作 |
| --- | --- |
| `+` / `=`、`-` | 放大、缩小 |
| `0` | 适应预览区域 |
| `⌘/Ctrl Z` | 撤销 |
| `⌘/Ctrl Shift Z` 或 `⌘/Ctrl Y` | 重做 |
| `Esc` | 取消当前框选或拖动 |

缩放和编辑撤销快捷键在文本输入框外生效；输入框内保留浏览器原生文字撤销。也可随时使用工具栏「撤销」「重做」按钮。

编辑历史包括替换文本、渲染选项、二维码区域及取票号处理，最多保留 **60 个状态（含当前状态）**。连续输入会合并记录，一次拖动作为一次编辑；缩放、平移和原图对比不进入历史。导入新图片会重置历史，刷新页面后不会保留编辑。

## 取票号处理

电影票/取票码场景：如果二维码内容是一串数字（如淘票票取票号），会自动定位码下方印刷的号码，
检测卡片里可选择「遮盖」（底色盖掉）或「换号」（生成等长随机数，按原字高/字色/粗细/空格分组绘回）。
蓝色号码框可拖动、四角缩放，也可以点「框选」重新拖一个区域。
二维码替换和取票号处理独立控制；停用二维码替换后，已开启的号码处理仍然有效。

## 验证开发改动

无需安装依赖，运行历史记录与二维码回扫测试：

```bash
node --test tests/*.test.cjs
```

`tests/editor.browser.js` 提供浏览器集成检查。在本地页面打开后，可用 agent-browser 执行：

```bash
agent-browser open http://localhost:8931
agent-browser eval --stdin < tests/editor.browser.js
```

检查使用合成图片，会替换当前页面的编辑状态；下载和剪贴板写入会被拦截，不会写入系统剪贴板。

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
