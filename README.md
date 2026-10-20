# QR 置换台

在图片中定位二维码、替换内容，并按原区域的尺寸和透视绘制新码。

纯静态、零构建、零依赖上传：识别（jsQR）与生成（qrcode-generator）全部在浏览器本地完成，图片不离开设备。

## 使用

直接打开 `index.html`（`file://`），无需安装或构建。也可以在项目目录启动静态服务器：

```bash
python3 -m http.server 8931
```

然后访问 [本地页面](http://localhost:8931)。

拖入 / 粘贴 / 选择图片 → 在「选择处理目标」中选中二维码或添加遮盖 → 编辑所选目标 → 验证并导出。

侧栏按「选择处理目标 → 编辑所选目标 → 高级设置与偏好 → 验证并导出」排列。容错等级、版本控制和默认偏好收在可展开的高级设置中；点击检测卡片会定位并选中对应区域，启用开关独立控制是否应用修改。

识别、编辑和 PNG 下载可在本地文件模式下使用。复制图片需要浏览器支持剪贴板 API 并允许写入；支持文件分享的浏览器还会显示「分享」，可调用系统分享菜单。复制或分享不可用时可下载 PNG。

## 每个二维码独立编辑

- 每个目标独立保存替换内容与处理方式：「替换内容」生成新码；「遮盖二维码」用周围底色覆盖码区；「保留原码」保留原图中的二维码。
- 输入框和快速预设只作用于当前所选二维码。需要统一内容时，点击「将此内容应用到所有替换目标」；处于遮盖或保留模式的目标不会因此改变。
- 「替换内容」模式下，空输入会显示提示并暂停导出，不会隐式遮盖原码。内容超过二维码容量时，同样会显示持续的错误提示，修正后才能导出。
- 每张卡片的启用开关控制该二维码及其取票号处理。关闭后，这一组修改都暂停；再次启用会恢复原有设置。保留原码模式仅控制二维码，取票号仍可单独选择处理方式。

检测卡片分别显示原码版本与成功生成的新码版本。「沿用原码版本」默认开启；容量不足时不会自动改变密度。可缩短内容，或在高级设置中明确开启「容量不足时允许增加密度」。关闭「沿用原码版本」则按内容自动选择合适版本。手动添加但未识别出原码版本的区域，也会自动选择新码版本。

## 自动识别与重扫

自动识别会先扫描整图，再按原图尺寸进行局部分块扫描，改善大图中小二维码容易漏检的情况。识别期间显示进度，可随时点击「取消识别」；也可使用手动框选继续处理。

自动识别最多保留 32 个目标，可手动补充。单张图片支持 3200 万像素以内、单边不超过 16384 像素；超过时会提示缩小图片，已有图片与编辑保持不变。

重扫会匹配已有目标并保留替换内容、处理方式、调整后的四角、号码区域和手动添加的区域，任意遮盖区域也会保留。需要恢复当前图片的初始编辑状态时，使用「重置编辑」；重置操作可撤销。

## 任意区域遮盖

点击预览工具栏的「添加遮盖」或侧栏的「添加遮盖区域」，在图片上拖出矩形。它可用于二维码之外的文字、条码或其他区域，不要求图片中检测到二维码。

遮盖默认从周围采样底色，并使用不透明填充。选中区域后，可关闭「自动取底色」并选择自定义颜色；拖动区域内部移动位置，拖动边角调整大小。区域可单独启用、停用或删除，添加、编辑和删除均可撤销。框选时按 `Esc` 或点击「取消」退出。

## 自定义预设与默认偏好

在当前二维码输入替换内容后，填写「预设名称」并点击「保存预设」。点击已保存的预设可将其填入所选二维码，预设旁的删除按钮可移除该预设。

容错等级、版本选项等编辑偏好会在此浏览器中记住。替换文字只有通过「保存预设」或「将当前选择设为默认」才会持久保存；普通输入不会自动保存为下次使用的默认文字。默认值用于后续的新目标，不会覆盖已编辑目标。

预设和偏好存储于浏览器本地，原图、识别出的原始二维码内容与图片编辑历史不会保存到浏览器存储。高级设置中的「清除已保存偏好」可清除自定义预设及默认值；浏览器禁止本地存储时会显示提示，当前图片仍可继续编辑。

## 导出前扫描验证

- 点击「下载 PNG」「复制结果」或「分享」后，先生成最终 PNG，再从该 PNG 的像素中逐个扫描已启用的替换区域，检查解码内容是否与各自的替换文本一致。
- 「验证结果」可提前运行同样的检查，不会下载、复制或分享图片。侧栏按二维码编号显示「通过」「未通过」或「未验证」；停用、遮盖和保留原码的区域不参与替换内容验证。
- 若有已启用区域未通过或未能验证，导出前会显示确认框。可以「返回检查」，调整四角、缩短内容后重试，也可明确选择「仍然下载」或「仍然复制」。
- 修改内容或区域后，旧验证结果会清除，下一次导出重新验证。查看原图、缩放和平移不改变实际导出内容。

验证通过表示当前 jsQR 解码器能从导出图片读出预期内容，不代表所有扫码软件或再次压缩后的图片都能识别。若遮盖区域与替换码重叠，验证会基于遮盖后的最终图片检查结果。

## 手动框选与四角调整

1. 自动检测遗漏时，点击预览区「框选二维码」，拖出二维码范围。
2. 应用会对原图的局部区域重新扫描；识别成功后采用识别出的四角。识别失败时也会添加手动区域，可继续编辑。
3. 点击二维码或检测卡片的「调整四角」，拖动四个黄色手柄，使其贴合实际码区边缘，**不要把外围白边算入码区**。可先放大再调整透视。
4. 使用「验证结果」检查效果。区域可使用独立开关停用，也可「移除」；误操作可撤销。框选过程中按 `Esc` 或点击「取消」退出。

重新扫描会保留已有编辑和手动区域。点击卡片只选中目标，是否应用修改由卡片上的独立开关控制。

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

编辑历史包括各二维码的替换文本与处理方式、渲染选项、二维码区域、取票号处理及任意遮盖区域，最多保留 **60 个状态（含当前状态）**。连续输入会合并记录，一次拖动作为一次编辑；缩放、平移和原图对比不进入历史。导入新图片会重置历史，刷新页面后不会保留图片编辑。自定义预设和保存偏好的操作不进入图片编辑历史。

## 取票号处理

电影票/取票码场景：如果二维码内容是一串数字（如淘票票取票号），会自动定位码下方印刷的号码，
检测卡片里可选择「遮盖」（底色盖掉）或「换号」（生成等长随机数，按原字高/字色/粗细/空格分组绘回）。
蓝色号码框可拖动、四角缩放，也可以点「框选」重新拖一个区域。
二维码模式与取票号处理方式分别设置；关闭卡片上的启用开关会同时停止二维码与号码修改。

## 验证开发改动

无需安装依赖，运行模块测试：

```bash
node --test tests/*.test.cjs
```

`tests/*.browser.js` 提供编辑、工作流程与扫描并发的浏览器集成检查。在本地页面打开后，可用 agent-browser 执行：

```bash
agent-browser open http://localhost:8931
agent-browser eval --stdin < tests/editor.browser.js
agent-browser eval --stdin < tests/workflow.browser.js
agent-browser eval --stdin < tests/scan.browser.js
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

## Stripe 沙盒收费实验

此实验在上述静态应用之外增加可选的 **Pages Functions Advanced Mode** 支付接口，仍使用现有 `qr-replace` Pages Direct Upload，不创建或迁移到独立 Workers 项目。浏览器代码保持直接打开 `index.html` 的能力；二维码识别、图片处理和导出仍在本机完成。支付接口只处理购买状态，不接收图片或二维码内容。

默认 `BILLING_EXPERIMENT=off`，原功能免费。开启后可选：

| 开关 | 免费功能 | 测试购买后的效果 |
| --- | --- | --- |
| `exports`（本轮优先测试） | 图片导入、编辑、回扫验证 | 下载 PNG、复制结果、分享图片 |
| `adfree` | 所有编辑和导出功能 | 隐藏广告占位区 |

两种模式都支持一次性买断和每月订阅，只配置一个 Price ID 时仅显示对应方案。金额和币种从 Stripe 服务端读取；没有固定正式售价。`adfree` **尚未加载 AdSense 脚本，也不会展示或产生真实广告收入**。

### 本地沙盒联调

1. 在目标 Stripe 账户的 **Sandbox / 测试模式** 中创建测试商品：一次性固定价格和每月固定价格。可先用 USD 5.00 买断、USD 1.00/月验证流程，这不是正式定价。价格不可为零、阶梯计价或按用量计价。
2. 在该测试账户启用 [Customer Portal](https://dashboard.stripe.com/test/settings/billing/portal)，允许查看账单、更新支付方式及取消订阅。此实验不提供套餐切换、试用期或折扣；支付方式由 Stripe 动态选择，延迟付款仅在实际到账并收到通知后解锁。
3. 运行 `npm run setup:billing`。它生成被 Git 忽略的 `.dev.vars` 和随机 Cookie 签名密钥，不会覆盖已有配置，也不会输出密钥。
4. 仅在本地 `.dev.vars` 中填写 `STRIPE_SECRET_KEY=rk_test_…`（优先使用受限密钥，也支持 `sk_test_…`）、`STRIPE_ACCOUNT_ID=acct_…`、`STRIPE_PORTAL_CONFIGURATION=bpc_…`、`STRIPE_PRICE_LIFETIME=price_…` 和/或 `STRIPE_PRICE_MONTHLY=price_…`。不要把密钥发到聊天、放在前端或提交到 Git。
5. 在一个终端运行 `npm run listen:stripe`，使用固定版本 Stripe CLI 1.54.0 转发本沙盒事件。脚本读取本地密钥，验证账户，自动把签名密钥写入 `.dev.vars`，不输出密钥。看到“Webhook 已连接”后保持该进程运行，再在另一个终端启动：

   ```bash
   npm run build
   npm run dev:billing
   ```

6. 如果 Stripe CLI 长时间停在 `Getting ready...`，说明 WebSocket 尚未就绪。本轮本机访问 `stripecli-ws-nw.stripe.com` 超时，但 REST API 可用；可停止监听进程，改用 `npm run sync:stripe -- --watch`。它每 5 秒从 Stripe 拉取真实事件，在本地签名重放到同一个处理器，不会修改付款状态；这不等于验收了 Stripe 到公网 HTTPS 端点的投递。仍须保留 `dev:billing` 运行。
7. 打开 [本地支付测试](http://127.0.0.1:8788)。导入并修改二维码，点击下载应先弹出购买方案。选择方案会在新标签页打开 Stripe，原标签页图片不会丢失。
8. 在 Stripe 结账页使用测试卡 `4242 4242 4242 4242`、未来有效期和任意三位 CVC，完成后回到原编辑标签页，点击“刷新购买状态”，再下载并回扫。可用 `4000 0000 0000 0002` 测试拒付。禁止在沙盒中使用真实银行卡。
9. 分别验证取消结账、退款、订阅到期/取消、续费失败、浏览器刷新和 API 断网。将 `.dev.vars` 的 `BILLING_EXPERIMENT` 改为 `adfree` 并重启，验证免费导出及付费隐藏占位区。

`dev:billing` 使用本地 D1 绑定 `BILLING_DB`，首次请求创建订单表和通知去重表，数据保存在被忽略的 `.wrangler/` 中，不创建线上数据库。受限 API 密钥需要读取账户、价格、Checkout、PaymentIntent、账单付款和订阅，以及创建/过期 Checkout 和创建 Customer Portal 会话的权限；本地 CLI 还需要监听事件权限，具体权限在沙盒验证。

此版硬性拒绝 `sk_live_…`、`rk_live_…` 及 Stripe 返回的 `livemode=true`。真实 Stripe Hosted Checkout 需要手动使用测试卡验证；自动化测试使用明确的 Stripe 替身，不会提交真实付款或伪装成真实沙盒验收。

### 购买状态与账号决策

服务端创建 Checkout 后保存 D1 订单，并写入签名、HttpOnly、SameSite Cookie，绑定匿名浏览器和该 Checkout。刷新购买状态、返回应用或再次导出时，服务端都会重新读取 Stripe 的付款、退款/争议、订阅期限和最新账单状态。Webhook 校验原始请求签名和五分钟时间窗口，处理 Checkout 完成/异步成功/失败、订阅变化、账单付款/失败、退款与争议。每次通知重新查询 Stripe 当前状态，并将订单更新与事件 ID 原子保存，重复或乱序通知不会重复发放权益。只有经过 Webhook 确认且当前支付状态有效才解锁；未收到通知时显示“正在等待支付通知”。无需等待成功跳转才记录 Checkout，关掉支付标签页后仍可在原浏览器查询。URL 参数和 `localStorage` 中的“已支付”不能授予权益；网络错误不会沿用旧的已付费状态。

当前 Cookie 最长保留一年。更换浏览器、清除 Cookie、轮换签名密钥后不能恢复购买关系，因此“买断”目前只用于测试一次付款流程，**不是正式的永久授权**。只保留当前浏览器最近一笔结账；已解锁时阻止重复购买，待付款时复用原结账，未结束的订阅引导到 Portal 处理。

这轮不加入账号或 Google 登录，避免在尚未确定收费方式前增加账户数据。正式收费前应增加稳定账号（经过验证的邮箱登录即可，Google 登录可作为可选方式）、账号与已有订单的关联、购买恢复、生产数据库迁移与运行监控。当前已实现 D1 订单及签名校验、幂等 Webhook，但仍只允许沙盒，且不会发授权邮件。按 [Stripe fulfillment 指南](https://docs.stripe.com/checkout/fulfillment) 验证付款成功、续订、退款和取消事件。

纯浏览器处理和离线使用模式意味着收费入口可以被修改客户端绕过。正式商业模式可以考虑便利功能、持续服务或免广告，但本实验不提供不可绕过的图片处理授权。AdSense 正式接入还需要站点审核、发布商标识、隐私与必要的同意流程，遵守 [AdSense 计划政策](https://support.google.com/adsense/answer/48182?hl=zh-Hans)。

### Pages 打包与配置补充

以下是收费实验对前述“仅静态产物”说明的补充：`scripts/build.mjs` 还把 `server/billing.mjs` 打包为 `dist/_worker.js`，生成只匹配 `/api/*` 的 `_routes.json`，以及限制脚本、连接、嵌入等来源的 `_headers`。服务器代码、路由配置和公开静态资源一起作为已检查的 `dist/` artifact 发布；`.dev.vars`、示例、测试和文档均不上传。没有新增线上配置文件或在 CI 中配置 Stripe 密钥。

`_deployment.json.files` 仍包含所有公开静态资源的 SHA-256；`server` 字段记录服务端源文件、路由和安全响应头摘要。Pages 不公开 `_worker.js` / `_routes.json` / `_headers`，所以线上验证通过 `/api/deployment` 检查其编入的提交号和源文件/路由摘要，而非下载服务端代码。`npm run test:pages` 会在真正的本地 Pages runtime 中加载同一构建产物并校验 API 与静态资源。CI 会在原有检查之外执行该命令。

如要在线测试，在现有 Pages 项目的控制台中设置以下配置；先使用受控测试环境，确认后再发布。代码不会替你修改线上变量、域名、绑定或 Secret：

| 配置 | 用途 |
| --- | --- |
| `BILLING_EXPERIMENT` | `off`、`exports` 或 `adfree` |
| `BILLING_ORIGIN` | 实际访问的完整 origin，不带尾斜杠，例如 `https://qr-replace.pages.dev`；预览域名需要自己的配置 |
| `STRIPE_SECRET_KEY`（Secret） | 目标账户的 `rk_test_…` 或 `sk_test_…` |
| `STRIPE_ACCOUNT_ID` | 明确锁定的沙盒账户 ID |
| `STRIPE_WEBHOOK_SECRET`（Secret） | 当前环境的 `whsec_…`，线上端点和本地 CLI 各自独立 |
| `STRIPE_PORTAL_CONFIGURATION` | 本沙盒的客户门户配置 ID |
| `BILLING_DB`（D1 绑定） | 保存订单和通知去重信息的数据库，线上由控制台配置 |
| `BILLING_COOKIE_SECRET`（Secret） | 独立随机的至少 32 字符密钥 |
| `STRIPE_PRICE_LIFETIME` | 测试模式的一次性价格 ID，可省略 |
| `STRIPE_PRICE_MONTHLY` | 测试模式的每月价格 ID，可省略；两种价格至少填一种 |

使用 `npm run check`、`npm run build`、`npx --no-install playwright install chromium`、`npm run test:browser` 和 `npm run test:pages` 验证。支付测试涵盖两种收费模式、购买前后 PNG 回扫、付款状态、Cookie 篡改、CSRF、退款、订阅、Portal、网络失败与 `file://` 兼容。现有 GitHub Actions 的生产分支条件与部署凭据隔离保持不变。

### 本次 Stripe 官方集成计划（2026-10-19）

已通过 Stripe 插件 `stripe_implementation_planner` 生成并接受计划 `iguide_61VbgYcAltYLDCHlw41Dq6DeSheLU`。选定网页托管 Checkout、自助购买、固定价格、预付、Customer Portal。规划工具同时提供 Accounts v2 门户示例，但当前应用已有 Customers v1 流程，保留其 `customer` 绑定，不混用 `customer_account`。没有启用 Managed Payments、报价销售、自动税或真实收费。

| 沙盒配置 | 已配置值 |
| --- | --- |
| 账户 | `qrcodeReplace 沙盒` / `acct_1USIMHDq6DeSheLU` |
| 商品 | `prod_VTF6e1VHscyMsc`，qrcodeReplace 高级功能（沙盒测试） |
| 同一高级功能的买断价格 | `price_1USIccDq6DeSheLUD0qGgenn`，USD 5 / 次 |
| 同一高级功能的月订阅价格 | `price_1USIctDq6DeSheLUiguO97If`，USD 1 / 月 |
| 客户门户 | `bpc_1USIcyDq6DeSheLUlXymzw4D`，账单、支付方式更新、到期取消 |

以上均是测试对象；价格只是联调占位。默认先测试 `exports`；`adfree` 保留为另一种实验。

按官方计划核对后的实现：

- API 固定为 `2026-09-30.endive`，使用当前订阅条目的期限和独立 `InvoicePayment` 关联，不依赖旧版 invoice.payment_intent。
- Checkout 使用动态支付方式、Adaptive Pricing 和独立 integration identifier；买断启用 `invoice_creation`，订阅使用 flexible billing 并自动开账单。
- 此沙盒账户默认启用了 Managed Payments；本应用按已选普通 Payments 方案，在每笔 Checkout 显式传 `managed_payments[enabled]=false`，不改账户默认设置。
- Secret 仅在后端使用；支持受限密钥，并在创建结账时检查密钥对应的账户。前端无需可发布密钥或 Stripe.js。
- 本地 Stripe CLI 仅监听本沙盒；线上测试必须在 Stripe 建立指向实际 HTTPS `/api/billing/webhook` 的端点，并在 Pages 控制台配置对应签名 Secret 和 D1 绑定。代码不接管线上配置。
- 沙盒验收：买断/订阅 Checkout、未付款不解锁、通知后解锁、未返回成功页、重复/乱序通知、退款、续费失败、到期取消、Portal、两种实验和 PNG 回扫。
- 正式收费前确认收费模型和售价、添加账号与购买恢复、运行监控和数据迁移。Stripe Tax 需要先确认实际税务义务及有效注册，本轮不启用 `automatic_tax`；参见 [订阅税费配置](https://docs.stripe.com/billing/taxes/collect-taxes)。

本地重新 `npm run build` 后请重启 `dev:billing`，因为打包会重建 dist 目录，旧运行进程不一定重新加载服务端文件。

本轮实际沙盒联调已完成 USD 5 买断与 USD 1/月订阅，均由 Hosted Checkout 使用官方测试卡付款，Stripe 返回 `paid`，并生成对应 Invoice；本地事件重放后服务端返回 `paid: true`。买断解锁后实际下载 PNG，再重新导入识别，内容与预期替换内容一致。月订阅已通过 Portal 取消续订，Stripe 显示于 2026-11-19 终止；服务端确认本期仍 `paid: true` 且 `cancelAtPeriodEnd: true`，兼容 flexible billing 使用 `cancel_at` 表达期末取消的情况。自动回归另外覆盖退款、拒绝伪造通知、取消/到期、延迟付款和 PNG 下载回扫。公网 HTTPS Webhook 尚未部署与验收，本地 CLI WebSocket 连接超时的限制仍存在。

### Pages 在线沙盒配置（2026-10-20）

在上述本地联调之后，线上沙盒继续使用现有 `qr-replace` Pages 项目、`main` 生产分支和 `https://qr-replace.pages.dev`。另一个同名 Workers 项目不是本次发布目标。

- Pages 生产环境在控制台配置 `BILLING_EXPERIMENT=exports`，Stripe 仍为 `acct_1USIMHDq6DeSheLU` 沙盒，沿用上表的测试商品、价格和 Portal。
- D1 数据库 `qr-replace-billing-sandbox`（`e8c259f9-ebc0-4eb7-9ab8-5d8be8a0cea0`）绑定为 `BILLING_DB`，与本地数据库隔离。
- 公网 Webhook 为 `https://qr-replace.pages.dev/api/billing/webhook`，端点 ID `we_1USJ7kDq6DeSheLU43bS1SiD`，事件 API 版本 `2026-09-30.endive`。仅接收本沙盒的 Checkout、订阅、账单、退款和争议事件。
- Stripe API 密钥、公网 Webhook 签名密钥和独立的 Cookie 签名密钥在 Pages 控制台以 Secret 保存；公网签名密钥与本地 CLI 的密钥不同，不进入 Git 或构建产物。
- 线上直接接收 Stripe HTTPS 通知，不运行本地 `sync:stripe` 重放脚本。部署后需用线上应用创建新测试订单，验证真实通知投递、付款解锁和 PNG 下载回扫；本地购买 Cookie 不迁移到线上。

### Google 登录与跨设备权益（本次更新）

新增账号版继续使用上面的 Pages 项目、D1 绑定和 Stripe 沙盒。上文匿名浏览器版的 Cookie 恢复限制属于初版行为；账号版购买前需要 Google 登录，登录同一 Google 账号即可在其他浏览器或设备恢复有效权益。旧浏览器仍持有有效购买 Cookie 时，可点击“Google 登录并绑定本浏览器购买”迁移旧订单；清除了旧 Cookie 的匿名订单不能仅凭付款邮箱认领，已绑定订单也不能迁给另一个账号。

Google Cloud 项目为 `qrcodereplace`，应用名称 `qrcodeReplace`。首次配置步骤：

1. 在 Google Auth Platform 配置应用身份，目标对象选择“外部”，保持测试状态，按控制台要求添加测试用户。
2. 创建 **Web 应用** OAuth 客户端。已获授权重定向 URI 必须逐字匹配 `https://qr-replace.pages.dev/api/auth/google/callback`。本机联调可额外添加 `http://127.0.0.1:8788/api/auth/google/callback`。本实现采用服务端授权码流程，不嵌入 Google 脚本，不需要 JavaScript 来源配置。
3. 在现有 Pages 项目的生产环境控制台添加 `GOOGLE_CLIENT_ID`（文本）及 `GOOGLE_CLIENT_SECRET`（Secret）。本地值仅填入被忽略的 `.dev.vars`。不要在聊天、Git、构建产物或 CI 中保存密钥；CI 只部署已检查的 artifact。
4. 保留 `BILLING_EXPERIMENT=exports`、现有 D1 与全部 Stripe 沙盒配置，重新发布后验证 Google 登录。没有 Google 配置时新购买保持关闭，旧的有效匿名购买仍可使用，待配置完成再绑定。
5. 先在原购买浏览器登录并绑定旧记录，再用另一个浏览器登录同一 Google 账号，确认恢复导出和账单管理；不同账号不能看到原权益。新购买同样使用测试卡，退款与订阅失效后所有设备都会重新校验并停止授权。

服务端仅用 Google 已签名 ID Token 的稳定 `sub` 标识账号，邮箱和姓名用于显示与创建 Stripe 沙盒客户，邮箱相同不会合并账号。授权请求包含一次性 `state`、`nonce` 和 PKCE；`jose` 校验 Google 签名、签发者、受众、有效期和邮箱验证状态。授权码和 Google token 不保存，OAuth 临时记录十分钟过期。登录 Cookie 在 HTTPS 上使用 `__Host-`、HttpOnly、Secure、SameSite=Lax；D1 只保存随机会话 token 的 SHA-256 摘要，登录有效期三十天，退出立即撤销当前会话。Cookie 不包含付费授权状态。

新增 `auth_users`、`auth_sessions`、`auth_flows`、`billing_owners`、`billing_checkout_locks` 表，以幂等方式在首次请求时建立，保留原订单和通知表。订单中的旧买家 ID 不改写，通过所有者关系关联到账号；服务端按账号查询所有购买记录，仍须由已验签 Webhook 确认并复查 Stripe 当前状态才能解锁。创建结账页按账号加锁，跨浏览器复用待付款会话，避免重复创建订阅。关联了多个历史 Stripe 客户时，界面提供账单账户选择。

`jose` 与 `esbuild` 是固定在 lockfile 的发布依赖；构建时把后端及 JWT 校验器打包为单个 `_worker.js`，前端、离线使用和严格 CSP 保持原有方式。受限 Stripe API 密钥还需要创建 Customer 的权限。自动化测试使用本地 RSA 签名的 Google 协议替身，验证登录回调和跨浏览器恢复，但不代替真实 Google OAuth 授权验收。
