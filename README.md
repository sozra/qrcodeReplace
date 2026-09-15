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

```bash
npx wrangler pages deploy . --project-name qr-replace
```
