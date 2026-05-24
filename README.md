# 🌸 Sakrylle 图像工坊

基于 `gpt-image-2` 的在线图像生成与编辑站，[Sakrylle](https://sub.sakrylle.com) 生态前端。

- **在线访问**：[image.sakrylle.com](https://image.sakrylle.com)
- **账户申请**：[sub.sakrylle.com](https://sub.sakrylle.com)
- **API 文档**：[docs.sakrylle.com](https://docs.sakrylle.com)（图像 API 章节）

## 功能

- 文生图 / 参考图编辑 / 蒙版重绘
- 流式图像（实时看到中间步骤）
- 多任务并发，画廊式历史记录
- Agent 多轮对话生图
- PWA 安装，离线可启动 UI（生成仍需联网）
- 所有数据存浏览器 IndexedDB，**没有后端**

## 快速开始

### 一键登录（推荐）

1. 在 [sub.sakrylle.com](https://sub.sakrylle.com) 申请 GPT-Image group 账户
2. 打开 [image.sakrylle.com](https://image.sakrylle.com) 进设置面板
3. 点 **"使用 Sakrylle 账户登录"** → 跳 sub.sakrylle.com 授权 → 自动回来
4. 余额、模型自动拉取，直接开生

> OAuth 流程基于标准 OAuth 2.0 Authorization Code + PKCE，详见 [docs/SAKRYLLE_API_SPEC.md](./docs/SAKRYLLE_API_SPEC.md)。

### 手动配置（兼容期）

OAuth endpoint 未上线时可在设置面板手动粘贴 API Key：

1. 在 sub.sakrylle.com console 复制一个 GPT-Image group key
2. 设置面板 → API Key → 粘贴
3. 模型保持 `gpt-image-2`

### URL 一键导入

```
https://image.sakrylle.com/?apiKey=sk-...&model=gpt-image-2
```

支持的 query 参数：`apiKey`、`model`、`apiMode`（`images` 或 `responses`）、`streamImages`、`streamPartialImages`。

## 计费

- 默认模型 `gpt-image-2`，每次成功调用扣 **￥0.15**（per-request 计费，不按 token）
- 失败不扣
- 余额由 sub.sakrylle.com 维护

## 自部署

### Cloudflare Workers（推荐）

```bash
npm install
VITE_DEFAULT_API_URL=https://api.sakrylle.com/v1 npm run deploy:cf
```

需要先 `wrangler login`。`wrangler.jsonc` 已配置 worker name `sakrylle-image-playground`。

### Docker

```bash
docker pull ghcr.io/ranshen1209/gpt_image_playground:latest
docker run -d \
  -e DEFAULT_API_URL=https://api.sakrylle.com/v1 \
  -p 8080:80 \
  ghcr.io/ranshen1209/gpt_image_playground:latest
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEFAULT_API_URL` | `https://api.sakrylle.com/v1` | 默认填入设置面板的 API URL |
| `ENABLE_API_PROXY` | `false` | 启用 nginx 同源代理 |
| `LOCK_API_PROXY` | `false` | 强制开启 proxy（用户无法关） |

### GitHub Pages（备用入口）

push tag `v*` 触发 `.github/workflows/deploy.yml` 自动发到 GH Pages。

### 本地开发

```bash
npm install
npm run dev          # http://localhost:5173
npm run mock:api     # 本地故障模拟服务（docs/mock-image-api.md）
npm run test         # vitest run
npm run build        # tsc -b && vite build → dist/
```

## 同步上游

```bash
git fetch upstream
git rebase upstream/main
```

预期冲突：`index.html`、`src/index.css`、`src/lib/apiProfiles.ts`、`README.md`、`public/manifest.webmanifest`、`public/pwa-icon-512.png`。
冲突按 `ours` 解决（保留 Sakrylle 主题），上游新功能逐项 cherry-pick。

## 致谢

本站点（**Sakrylle 图像工坊**）基于开源项目 [GPT Image Playground](https://github.com/CookSleep/gpt_image_playground) ([MIT](https://github.com/CookSleep/gpt_image_playground/blob/main/LICENSE)) 二次开发。

感谢 [@CookSleep](https://github.com/CookSleep) 提供的优秀基础。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Ranshen1209/gpt_image_playground&type=Date)](https://www.star-history.com/#Ranshen1209/gpt_image_playground&Date)
