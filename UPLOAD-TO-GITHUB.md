# 上传到 GitHub

本项目已经按独立仓库整理，目录内不含 `node_modules`、构建临时目录、日志、真实凭据或安装包。

## 上传前检查

```bash
node scripts/build-client.mjs --check
node verify-host.cjs
node verify-client.mjs
node verify-subscriptions.mjs
node verify-provider-runtime.mjs
node verify-compat.mjs
```

以上 5 个验证脚本全部通过后再上传。Host 与 provider runtime 的脚本需要能解析 `package.json` 中的依赖（在 DSH profile 内运行，或先安装依赖）；本仓库不包含 `node_modules`。

## 创建仓库

在本项目目录执行：

```bash
git init
git add .
git commit -m "feat: initial dsh-Subscription-Management release"
git branch -M main
git remote add origin https://github.com/<用户名>/dsh-Subscription-Management.git
git push -u origin main
```

也可以使用 GitHub Desktop 的 **Add Existing Repository**，然后 Publish。

## 发布安装包

```bash
node scripts/build-client.mjs
pnpm pack --pack-destination dist
```

将生成的 `.tgz` 上传到 GitHub Releases。版本号为 `1.0.3`，建议标签 `v1.0.3`：

```bash
git tag -a v1.0.3 -m "1.0.3"
git push origin v1.0.3
```

## 必须排除

- `node_modules/`、`dist/`、`tmp/`、`.tmp/`
- `*.tgz`、`*.zip`、`*.log`
- `.env`、密钥、token、Cookie、OAuth 凭据文件
- 本机绝对路径、个人 profile 数据和真实账户响应

`.gitignore` 已覆盖常见产物。上传前仍应执行敏感词检查，并确认 `subscriptions.json`、`host/subscriptions/` 与 `host/provider-runtime/` 已提交。
