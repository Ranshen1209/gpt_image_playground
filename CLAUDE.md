# CLAUDE.md

Sakrylle 图像生成站 fork of [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)。维护笔记 — 只记 operational facts、gotchas、"why" decisions。"做了什么"看 `git log` / `git diff upstream/main`。

## 这是什么

纯前端 SPA — React 19 + TypeScript + Vite 6 + Tailwind 3 + Zustand 5 + i18next。所有数据存浏览器 IndexedDB，不经任何服务器（除调用图像 API 本身）。**没有后端**，部署即一份静态文件。

在 Sakrylle 生态里的位置：用户在 [sub.sakrylle.com](https://sub.sakrylle.com) 通过 OAuth 2.0 PKCE 登录或申请 GPT-Image group API key，本站负责 UI / 历史 / 画廊 / 蒙版编辑器 / Agent 多轮对话。所有图像调用真正打 [api.sakrylle.com/v1/images/*](https://api.sakrylle.com)，再由 sub2api 转发到 `ai.centos.hk` 上游。

- **Upstream**: [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) (MIT)
- **Fork**: [Ranshen1209/sakrylle-image](https://github.com/Ranshen1209/sakrylle-image), 主线 `theme/sakrylle`
- **生产域名**: `image.sakrylle.com`（OAuth redirect URI 已写死该域名 SSR fallback；挂同一 nginx + sslh 栈）
- **状态**: v0.10.0 — Sakrylle 化、OAuth PKCE 登录、OIDC 发现、多 Group 切换、OAuth Bearer 回退、i18n 中英双语、Liquid Glass UI、View Transition 主题切换均已落地

## Sakrylle API 集成（最重要）

整个 app 本质是一次 HTTP 调用 + UI。**默认目标必须是 `https://api.sakrylle.com/v1`**。

### 端点契约

| 模式 | 路径（相对 baseUrl） | 用途 |
|---|---|---|
| Images API | `POST images/generations` | 文生图 |
| Images API | `POST images/edits` | 参考图 / 蒙版编辑（multipart） |
| Responses API | `POST responses` | Agent 多轮对话 + 流式图像 |
| 平台 API | `GET me` | 用户信息 / 余额 / group 列表（v2，需 OAuth Bearer + scope） |
| 平台 API | `GET account/balance` | 余额 + group 元信息（v1 legacy fallback） |
| 平台 API | `GET models` | 模型列表（需 OAuth Bearer，含 group-scoped 查询） |

`baseUrl` 形如 `https://api.sakrylle.com/v1`（无尾斜杠 — `apiProfiles.ts::normalizeBaseUrl` 会去掉）。请求路径直接拼在后面。

### 模型

- **唯一可用模型**: `gpt-image-2`（在 `src/lib/apiProfiles.ts` `DEFAULT_IMAGES_MODEL`）
- Sakrylle GPT-Image group 不挂任何其他模型；上游 `ai.centos.hk` 也只对此 group 暴露 `gpt-image-2`
- Responses API 默认模型 `gpt-5.5`（`DEFAULT_RESPONSES_MODEL`）— Agent 模式用，不是图像模型本身。**但 GPT-Image group key 不能调 GPT-Pro/Plus 的 chat 模型**（一个 key 绑定一个 group），所以 Agent 模式在 Sakrylle 上需要用户配置 GPT-Pro/Plus 那边的 key

### 认证 + 计费

- **两种 Auth 路径**：
  1. OAuth 2.0 PKCE 登录（推荐，sub.sakrylle.com）→ access_token 自动用于平台 API + **回退为图像 API Key**（见下方"OAuth Bearer 回退"）
  2. 用户手动粘 API Key（来自 sub.sakrylle.com console）→ 存 IndexedDB profile，用于图像 API
- **OAuth Bearer 回退** (`src/lib/oauthFallback.ts`): 当用户登录了 Sakrylle OAuth 但未配 API Key 时，自动用 access_token 调 `/v1/images/*` 和 `/v1/responses`。仅适用于 Sakrylle 官方 baseUrl，其他服务商仍要求显式 apiKey。scope 检查：Images 模式需 `images:create` 或 `image_generation`；Responses 模式需 `responses:create`
- **多 Group OAuth** (`src/lib/groupSelection.ts`): OAuth 授权可返回多个 group 的 token（主 token 的 `group` + `additionalTokens[]`）。用户可为 Images / Responses 模式分别选择不同 group。选择持久化到 `localStorage` key `sakrylle-image-playground.selected-groups`。Group 名缓存到 `sakrylle-image-playground.group-names` 避免回退名（"Group 5"）
- **v2 Scopes**（canonical）: `profile:read account:read account:balance:read models:read images:create responses:create offline_access`。OIDC 启用时追加 `openid profile email`。Legacy v1 aliases（`image_generation`, `balance:read`）在弃用窗口期仍接受
- **Group 约束**: key 必须属于 `allow_image_generation=true` 的 group。Sakrylle 当前只有 `group_id=5` (GPT-Image, `rate_multiplier=1.0`) 满足。其他 group 的 key 调 `/v1/images/*` 会 403 `"Image generation is not enabled for this group"`
- **计费模型**: `billing_mode='per_request'`, `per_request_price=0.15`（USD），**不按 token 计费**。每次成功调用扣 ￥0.15（Sakrylle 内部 USD 计价 → UI 渲染 ￥）。失败不扣
- **一 key 一 group**: 用户若同时要 chat + image，可通过 OAuth 多 group（一个授权覆盖多 group）或手动配置两个 key

### 默认配置注入

五条独立的环境变量驱动各自语义：

| 变量 | 用途 | 出处 | Fallback 链 |
|---|---|---|---|
| `VITE_DEFAULT_API_URL` | 用户可见的图像 API 默认 baseUrl（profile 可改写） | `apiProfiles.ts` `DEFAULT_BASE_URL` | → `https://api.sakrylle.com/v1` |
| `VITE_SAKRYLLE_PLATFORM_API` | 平台 API 基址（账户/余额/模型，用户不可改） | `sakrylleAccount.ts` `SAKRYLLE_API_BASE` | → `VITE_DEFAULT_API_URL` → `https://api.sakrylle.com/v1` |
| `VITE_SAKRYLLE_OAUTH_BASE` | OAuth / OIDC 端点 base | `sakrylleAuth.ts` `OAUTH_BASE` | → `https://sub.sakrylle.com` |
| `VITE_SAKRYLLE_OAUTH_CLIENT_ID` | OAuth client_id | `sakrylleAuth.ts` `CLIENT_ID` | → `sakrylle-image-playground` |
| `VITE_SAKRYLLE_OIDC_ENABLED` | OIDC feature flag (`'true'` 启用) | `sakrylleAuth.ts` `OIDC_ENABLED` | → `false`（默认关） |

构建期写入 bundle。Docker 入口 `deploy/inject-api-url.sh` 在容器启动时把占位符替换成 env。

## OIDC 客户端（v0.10.0，feature flag）

`VITE_SAKRYLLE_OIDC_ENABLED=true` 时启用 OpenID Connect 层，往上加在 OAuth PKCE 之上：

- **OIDC Discovery** (`src/lib/sakrylleOidcDiscovery.ts`): 启动时 `GET /.well-known/openid-configuration` 获取 IdP 端点，缓存 1 小时。失败时 fallback 到硬编码端点（`OAUTH_BASE + /oauth/authorize` 等）。所有端点必须与 issuer 同源（安全校验）
- **Scopes 扩展**: 基础 v2 scopes 前追加 `openid profile email`
- **id_token**: 授权码换取时解析 id_token JWT（不验签名），提取 `sub`/`name`/`email`/`preferred_username`。nonce 防重放。`idTokenClaims` 合并到 `/v1/me` 用户信息（作为 identity 主源）
- **RP-Initiated Logout**: `logoutAndRevoke()` 重定向到 IdP `end_session_endpoint`，携带 `id_token_hint` + `post_logout_redirect_uri`
- **Docker 占位符**: `__VITE_SAKRYLLE_OIDC_ENABLED_PLACEHOLDER__`，容器 env `OIDC_ENABLED`（默认 `false`）
- **参考文档**: `docs/OAUTH_V2_INTEGRATION.md`，OIDC RP 集成指南 `oidc-docs/06-oidc-rp-integration-guide.md`

## OAuth 2.0 PKCE 登录（v0.5.0 起，v2 增强 v0.10.0）

按 `docs/OAUTH_V2_INTEGRATION.md`（v2 主文档）和 `docs/OAUTH_CLIENT_INTEGRATION.md`（v1 参考）实现。

- **入口**: `src/lib/sakrylleAuth.ts` — `beginLogin()` / `handleCallback()` / `refreshIfNeeded()` / `forceRefreshToken()` / `refreshWithGroupId()` / `logout()` / `logoutAndRevoke()`
- **多 Group 入口**: `src/lib/groupSelection.ts` — `getAvailableGroups()` / `ensureSelectedGroupId()` / `getGroupAccessToken()` / `fetchResponsesApiGroups()`
- **OAuth Bearer 回退**: `src/lib/oauthFallback.ts` — `canUseOAuthForProfile()` / `resolveBearerToken()`
- **Redirect URI**: `${window.location.origin}/oauth/callback`，SSR fallback `https://image.sakrylle.com/oauth/callback`
- **Storage keys**:
  - `sakrylle-image-playground.auth` (localStorage) — `SakrylleAuthToken`（含 `accessToken`、`refreshToken`、`expiresAt`、`scope`、`refreshTokenExpiresAt`、`group`、`additionalTokens[]`、`idToken`/`idTokenClaims`（OIDC））
  - `sakrylle-image-playground.pkce-verifier` / `sakrylle-image-playground.pkce-state` / `sakrylle-image-playground.oidc-nonce` (sessionStorage) — beginLogin 写入，handleCallback 消费后清掉
  - `sakrylle-image-playground.selected-groups` (localStorage) — `{ images?: number, responses?: number }`
  - `sakrylle-image-playground.group-names` (localStorage) — `{ [groupId: string]: string }` 缓存友好名
- **Scope（v2 canonical）**: `profile:read account:read account:balance:read models:read images:create responses:create offline_access`。OIDC 启用时加 `openid profile email`
- **多 Group 授权**: OAuth grant 可返回多 group 的 token — 主 token 绑定 `group`，额外 group 在 `additionalTokens[]`。用户可为 Images / Responses API 分别选择不同 group。`refreshWithGroupId(groupId)` 用指定 group_id 轮换 token（不改变主 token）。`getGroupAccessToken()` 不触发 refresh，用于 model selector 并发安全读取
- **Refresh**: `expiresAt - 60s` 内自动刷；`/v1/*` 401 invalid_token 触发 `forceRefreshToken` → 单次重试，多并发 401 通过 `dedupedForceRefresh` 合并为一次轮换。**`refresh_token` 必须每次轮换**（docs §2.4），缺失即抛 terminal 错；同时授权码换取也要求返回 refresh_token（docs §2.1）
- **Family-anchored refresh 过期** (v2 §5): `refreshTokenExpiresAt` 记录 refresh token 家族的绝对过期时间（从初始 grant 起算，非滚动）。每次轮换 server 回传剩余 TTL；过期前强制重新授权而非徒劳 refresh
- **`tokenFromPayload(payload, opts)`**: `opts.requireRefresh` 显式区分授权码与刷新两条路径，两边目前都传 `true`。`opts.previousRefreshTokenExpiresAt` 保留家族过期锚点跨轮换传递
- **`main.tsx` 处理回调**: `window.location.pathname === '/oauth/callback'` 触发 `handleCallback`，完成后 `history.replaceState` 回首页。catch 只 log `err.message` 不 log error 对象 — server 错误描述可能含 token 片段

平台 API 调用统一走 `sakrylleAccount.ts::authedFetch`，封装 401 重试 + token 注入。`/v1/me` 是 v2 首选用户信息端点（scope-cropped），`/v1/account/balance` 为 v1 legacy fallback。

## i18n（中英双语，i18next）

i18next + react-i18next。所有翻译资源 inline，不走 lazy load — bundle 大小不痛。

### 关键文件

- `src/lib/i18n.ts` — 初始化 i18next，挂 `languageChanged` 事件持久化 + 设 `<html lang>`，`fallbackLng: 'zh'`
- `src/lib/language.ts` — `Language = 'zh' | 'en'`、`readStoredLanguage()` / `persistLanguage()` / `applyLanguage()`，localStorage key `sakrylle-image-playground.language`，浏览器语言推断（zh-* → zh / en-* → en / 其它 → zh，与 fallbackLng 一致）
- `src/locales/zh.json` + `src/locales/en.json` — 嵌套：`common.*` `header.*` `welcome.*` `settings.*` `agent.*` `errors.*` `errors.profile.*`
- `src/locales/locales.test.ts` — parity 测试：key 集合一致 / 无空字符串（白名单 `Before/After/Prefix/Suffix` 拼接尾缀）/ 占位符匹配
- `src/lib/agentSentinels.ts` — **持久化数据语言迁移核心**：写 IndexedDB / store 时用 `__sakrylle:agent_stopped__` `__sakrylle:openai_interrupted__` sentinel 而非翻译后字符串；渲染时 `renderAgentStopped` / `resolveErrorForDisplay` 按当前语言翻译，同时识别 zh/en 历史字面量。`errorMessagePrefix` 缓存 + `languageChanged` 刷新避免热路径反复 `t()`

### 添加新字符串

1. 在 `src/locales/zh.json` 加 key，再在 `en.json` 同位置加翻译（`locales.test.ts` 会强制 parity）
2. 组件里 `const { t } = useTranslation()` → `{t('namespace.key')}`
3. lib 里 `import i18n from './i18n'` → `i18n.t('errors.x')`
4. 带变量用 `{{name}}`：`t('settings.api.deleteConfirmMessage', { name })`
5. **品牌名 "Sakrylle" 不翻**；技术词（API、URL、API Key、token、OAuth）保持英文不翻
6. 持久化（IndexedDB / store）任何错误消息**必须用 sentinel**，参考 `agentSentinels.ts`。直接存翻译后字符串会导致语言切换后旧记录残留旧语言

### 当前覆盖范围

- Header / App 欢迎弹窗 / SettingsModal 5 tab / ConfirmDialog / AgentWorkspace / InputBar / TaskCard / TaskGrid / DetailModal / SearchBar / HistoryModal / MaskEditorModal / SizePickerModal / SupportPromptModal / Toast / store toast 文案 / openaiCompatibleImageApi 错误
- `apiProfiles.ts` `validateApiProfile` / `validateImportedProfileRecord` 抛错走 `errors.profile.*`
- `sakrylleAuth.ts` `handleCallback` 抛错走 `errors.oauth*`（`'OAuth refresh_token rotation missing — terminal'` 保留英文 — 是开发者级 invariant 错）
- `Header.tsx` 顶部地球图标语言切换按钮，zh ↔ en 单击切换

### 仍含中文硬编码

- `SettingsModal.tsx` 里 `'新配置'` / `'默认'` / `'（复制）'` 用作 profile 默认名 — 影响数据持久化结构，迁移要兼容旧数据
- `src/lib/openaiCompatibleImageApi.ts` 等 lib 抛出的部分错误信息（按需迁移）

## 主题切换 + FOUC 防护

- `src/lib/theme.ts` — `Theme = 'light' | 'dark'`、`readStoredTheme()` / `applyThemeClass()` / `switchTheme(next, opts)`。利用 View Transition API 做圆形扩散，origin 来自点击坐标；prefers-reduced-motion 时降级为即时切换
- **暗色首屏 FOUC 防护**: `index.html` `<head>` 内联同步 IIFE（在 React mount 之前）读 `localStorage` 应用 `dark` class + `<html lang>`。所有 storage / matchMedia 调用包 try/catch，IIFE 防全局污染。**rebase 上游若改 head 顺序，必须保留这段在 `<link>` 之前**
- localStorage key: `sakrylle-image-playground.theme`

## Sakrylle 化现状（rebrand 已落地，gotchas 在此）

具体改了什么看 `git log theme/sakrylle ^upstream/main`。下面只记**改后必须知道的 operational facts**：

- **品牌字符串**: `index.html` title / `apple-mobile-web-app-title` / `manifest.webmanifest` `name` 已替为 "Sakrylle 图像工坊"。`<meta name="theme-color">` = `#9181bd`
- **主题色**: `src/index.css :root --primary` = `253 26% 62%`（Monet `#9181bd`）。**所有 Tailwind `blue-*` 已 sweep 成莫奈紫 hex 字面量**（`#f1edf8` / `#c4b8e0` / `#9181bd` / `#7d6cb0` / `#6e5fa6` / `#5b4d8e`）— rebase 上游时新增的 `blue-*` 必须同步替换，否则视觉撕裂
- **Liquid Glass utility**: `src/index.css` 末尾 `@layer utilities` 定义 `.glass-panel` / `.glass-card` / `.glass-input-shell` / `.glass-button` / `.glass-button-primary` — 自带 light/dark mode、移动端 blur 降级、`@supports` 不支持 backdrop-filter 时降级为半透明纯色。新组件优先用这些 class，不要写新的 `bg-white/X backdrop-blur` 组合
- **背景 ambient**: `body` 必须挂 `sakrylle-ambient` class（`index.html`），它给 `::before` 喷三点莫奈紫光斑做玻璃背景层。上游 rebase 若改 `body` class 要保住这个
- **Logo**: `src/components/icons.tsx::SakrylleLogo` 是行内 SVG（紫色渐变 + 五瓣樱花 + 金色花心）。Header 左上角和 PWA icon 共用。**不要**重新引入 `public/pwa-icon.svg`
- **Header 里被砍的**: PWA「安装为应用」按钮 + `beforeinstallprompt` 整套逻辑、「操作指南」按钮 + `HelpModal.tsx` 文件全删。Service Worker 注册仍在 `main.tsx`（PWA 离线缓存还要），只是不再主动 prompt 安装
- **余额轮询**: `Header.tsx` `useEffect` 60s 一次拉 `fetchBalance()`，**仅 `document.visibilityState === 'visible'` 时拉**；`visibilitychange` 从 hidden → visible 立即触发一次 refresh。后台 tab 不烧网关流量。`storage` 事件监听 OAuth 登出/换号同步多 tab。充值按钮硬编码跳 `https://sub.sakrylle.com/purchase`（`SAKRYLLE_PURCHASE_URL`）
- **关于页**: `SettingsModal.tsx` `activeTab === 'about'` 主链接指 Ranshen1209 fork，**必须保留** CookSleep 原仓库链接 + MIT 协议链接以符合署名要求。文件内有英中双语 AI 防删注释，rebase 时若上游改了致谢文案要小心 reconcile
- **默认 baseUrl**: `apiProfiles.ts` `DEFAULT_BASE_URL` fallback 已是 `'https://api.sakrylle.com/v1'`（不再 fallback 到 openai.com）。生产部署仍建议 `VITE_DEFAULT_API_URL` 显式注入，方便切环境

## 多服务商架构 — 别砍

本站设计成 **多服务商**架构（OpenAI 兼容 / fal.ai / 自定义 HTTP），不是 Sakrylle-only。改造时**保留多服务商**，只改默认值，不要砍 fal.ai 等代码路径 — 用户可能配自己的 key 调别处。

- **Images API vs Responses API**: 两套接口都打 OpenAI 兼容路径，区别在请求结构。Sakrylle 网关同时支持，但 Responses API 流式（`stream: true`）路径稳定性受上游影响 — 见 commit `63a2b29` "继续修复 Images API 流式响应兼容性 (fix #70)"。**Sakrylle 当前 GPT-Image group 不保证支持 Responses API 流式图像**，TODO：拿 group_id=5 的 key 实测 `POST /v1/responses` 行为，写明
- **Codex CLI 兼容模式**: Toggle 后会把多图请求拆成并发单图。Sakrylle 不是 Codex CLI 上游 — 默认关
- **n>1 多图并发拆分** (`openaiCompatibleImageApi.ts::callImagesApiConcurrent` / `callResponsesImageApi`, v0.10.2): `streamImages: true`（Sakrylle 默认）或 codexCli 开启时，`n>1` 会拆成 n 个各自 `n:1` 的独立请求。**实测定论（2026-06-09，group_id=5 key 实打 api.sakrylle.com）**：① 上游 gpt-image-2 **不支持单请求 `n>1`** —— `n:2`/`n:3` 都忽略 n 只回 1 张且只按 1 张计费，所以拆分是拿到 N 张的**唯一**办法，"走原生单请求 n=N"这条路不通；② 网关单用户**并发墙=6** —— 6 并发 6/6 全成功，7+ 触发 429 `"Concurrency limit exceeded for user"`，故 `MAX_CONCURRENT_IMAGE_REQUESTS=6` 贴墙取值；③ 单请求慢 22~101s，但默认 `DEFAULT_API_TIMEOUT=600s` 充足。**实现**（`runImageRequestsWithRefill`）：拆成 n 个 `n:1` 请求，worker-pool 限流 6 在飞；失败子请求（含 429/5xx，由 `isRetryableError` 判定，error 经 `makeApiError` 带 `httpStatus`）**补发凑满 N**，补发预算 `IMAGE_REQUEST_REFILL_BUDGET_FACTOR=1`（总请求 ≤ 2N，防持续失败烧钱，按次 ¥0.15 计最坏 2N×¥0.15）；每个子请求自带 `callWithRetry`（transient 退避重试 1 次）+ 成功即 `onPartialImage({final:true})` 推进 `streamPreviewSlots[taskId][requestIndex]` 预览槽位逐张呈现；本轮零成功且全为不可重试失败（4xx/moderation）则立即停止不补发；凑满后无 `partialFailure`，撞预算/硬限制仍缺则保留成功图 + 经 `CallApiResult.partialFailure` 弹 `toast.generationPartialFailure`（目标 vs 实际计数），全失败 throw。**注意**：上游 `ai.centos.hk` 偶发整体 502 `"Upstream request failed"`（2026-06-09 实测遇到过一段），此时补发也补不满，正确降级为部分/全失败报错
- **PROMPT_REWRITE_GUARD_PREFIX** (`openaiCompatibleImageApi.ts`): Responses API 始终前置 `"Use the following text as the complete prompt. Do not rewrite it:"`。Sakrylle 上游若改写提示词会触发 UI 提示开 Codex 兼容模式
- **Agent 多轮对话**: 历史存 IndexedDB（`db.ts`），上限不靠 localStorage 撑（commit `2690edb`）。分支引用严格限定当前路径，避免跨分支误用图片。流式 markdown 渲染用 `streamdown`（`tailwind.config.js` 的 content 数组包含 `node_modules/streamdown/dist/*.js` 以扫描其 class）
- **Image profile delegation**: Agent 模式可指定 `ApiProfile.imageProfileId` 引用另一个 Images profile — Agent 对话时切换到该 profile 调 Images API 生成图像

## Store 架构（Zustand 5）

`src/store.ts` (~4600 行) — Zustand 5 + `persist` 中间件，是整个 app 的集中状态管理。`persist` 把 `AppSettings`、`tasks`、`agentConversations` 写 `localStorage`（`sakrylle-store` key），图片/缩略图仍走 `src/lib/db.ts` IndexedDB。

**关键状态切片**:
- `settings: AppSettings` — 含 `profiles[]`、`activeProfileId`、`apiMode`、`appMode` 等
- `tasks: TaskRecord[]` — 所有生成任务
- `agentConversations: AgentConversation[]` — Agent 对话历史
- `input` — 当前输入框 prompt / `inputImages` / `maskDraft`
- `ui` — toast 队列 / modal 开关 / agent 输入草稿 / 选中 task

**核心 actions**:
- `submitTask()` — 画廊模式提交生成任务
- `submitAgentMessage()` — Agent 模式提交消息 + 流式处理
- `retryTask()` / `regenerateAgentAssistantMessage()` — 重试
- `exportData()` / `importData()` — ZIP 导入导出
- `clearData()` — 清空数据
- `initStore()` — 启动时初始化（迁移旧状态、清理过期草稿、恢复中断任务）

**图片缓存层**（store 内置，非 Zustand state）:
- 内存 LRU 缓存：`imageCache`（最多 8 张原图）、`thumbnailCache`（最多 80 张缩略图）
- 缩略图 backfill: 优先渲染可视区卡片，`requestIdleCallback` 分批生成缩略图写 IndexedDB
- 缩略图订阅: `subscribeImageThumbnail(id, cb)` → 组件挂载时订阅，缓存命中立即回调，否则等待 backfill

**关键 import 链**: store → db.ts（IndexedDB）/ agentApi.ts（Agent API）/ api.ts（Images API 单入口）/ openaiCompatibleImageApi.ts（实际 HTTP）/ groupSelection.ts / oauthFallback.ts / agentSentinels.ts

## 测试

`npm run test`（vitest run，CI 友好）。重点：

- `src/lib/sakrylleAuth.test.ts` — PKCE / state CSRF / refresh 轮换 / handleCallback / logout / OIDC 路径
- `src/lib/sakrylleAccount.test.ts` — `formatBalance` / `fetchBalance` 含 401 dedupe + retry + terminal logout
- `src/lib/sakrylleOidcDiscovery.test.ts` — OIDC discovery 缓存 / fallback / issuer 校验
- `src/lib/oauthFallback.test.ts` — OAuth Bearer 回退条件判断
- `src/lib/groupSelection.test.ts` — 多 group 选择 / 名缓存 / capability 过滤
- `src/lib/sakrylleImageSize.test.ts` — Sakrylle 特有尺寸映射
- `src/lib/agentSentinels.test.ts` — sentinel 识别（含 zh/en legacy 字面量）+ 渲染翻译
- `src/lib/agentApi.test.ts` — Agent API 请求构造 / batch call 解析
- `src/locales/locales.test.ts` — locale parity（key 集 / 空字符串 / 占位符）
- 既有：`apiProfiles.test.ts` `api.test.ts` `urlSettings.test.ts` `store.test.ts` 等

改 default API 字面量记得更新对应测试断言。

## 部署

上游支持 4 种，Sakrylle fork 主推 Docker：

1. **Docker → 自家 nginx 栈**（推荐，与 sub2api / docs / status 同款）— 见 [生产部署 (image.sakrylle.com)](#生产部署-imagesakrylllecom)
2. **Cloudflare Workers** — `npm run deploy:cf` 把 `dist/` 上传成 static assets。需先 `wrangler login`。Sakrylle 化需在 build 前 `export VITE_DEFAULT_API_URL=https://api.sakrylle.com/v1`
3. **Vercel** — 上游内置按钮，Sakrylle fork 重新接入即可。`.dev` 域名国内不通，需绑自定义域名走 Cloudflare DNS（不 proxied）
4. **GitHub Pages** — `.github/workflows/deploy.yml` 在 push tag `v*` 时触发。Sakrylle fork 改 base URL 后可用作备用入口

## 生产部署 (image.sakrylle.com)

完整运维 runbook 在 Obsidian vault `20 Work/ServerOps/Self-Hosted/GPT Image Playground 部署.md`（首次接入 / 灾难恢复看那边）。本节是发版需要的最小信息集。

### 触发条件 vs sub2api

跟 sub2api `theme/monet-purple` 不一样的两点：

- **构建靠 `workflow_dispatch` 手动触发，不是分支 push**。`.github/workflows/docker.yml` 配的是 `push: tags: ['v*']` + `workflow_dispatch`，但**实测 tag push 不可靠触发**（v0.8.18~v0.9.0 每次都是手动 dispatch；2026-05-31 发 v0.9.0 时推了 tag 也没触发，只能手动）。所以发版**别指望推 tag 自动构建**，推完 tag 直接 `gh workflow run docker.yml --ref theme/sakrylle` 手动触发。tag 仍要打（版本标记 + 内容追溯），只是不当触发器用。直接 `git push origin theme/sakrylle` 更不会触发
- **多平台镜像** `linux/amd64` + `linux/arm64`。日本 VPS 只用 amd64，但 tag 一次产物两架构，未来迁 ARM 不用重构
- **镜像名必须小写**（GHCR 限制）：`ghcr.io/ranshen1209/gpt_image_playground:latest`，workflow 里用 `${{ github.repository_owner }}` 自动拿到的 `Ranshen1209` 已被 docker action 处理为小写

### 日常发版

```bash
# 1. bump 版本号 — package.json + public/sw.js CACHE_NAME 必须同步
#    sw.js CACHE_NAME 不动会让旧用户的 Service Worker 继续派发旧 chunk
vim package.json public/sw.js
git add package.json public/sw.js && git commit -m "chore: release v0.X.Y"

# 2. 推主分支 + 推 tag（tag 只作版本标记，不可靠触发构建 — 见上）
git push origin theme/sakrylle
git tag v0.X.Y && git push origin v0.X.Y

# 3. 手动触发 GHA 构建（别等 tag 自动触发，它不工作）+ 等完成（约 1 分钟）
gh workflow run docker.yml -R Ranshen1209/sakrylle-image --ref theme/sakrylle
sleep 6 && gh run list -R Ranshen1209/sakrylle-image --workflow=docker.yml --limit=1
gh run watch -R Ranshen1209/sakrylle-image

# 4. 服务器拉新镜像 + 重启
ssh ssh-tokyo 'docker pull ghcr.io/ranshen1209/gpt_image_playground:latest && \
  cd /opt/stack && docker compose up -d gpt-image-playground'

# 5. 验证
curl -sS -o /dev/null -w "%{http_code}\n" https://image.sakrylle.com/
ssh ssh-tokyo 'docker exec gpt-image-playground sh -c "grep -roh \"https://api.sakrylle.com/v1\" /usr/share/nginx/html/assets | head -1"'
# 抓一段 bundle 看默认 baseUrl 是否被 inject-api-url.sh 替换成 api.sakrylle.com
# 输出空字符串说明占位符没被替换 — 检查 compose 里的 DEFAULT_API_URL env
```

**回滚预案**：升级前先记下当前线上镜像 digest 作回滚基准：

```bash
ssh ssh-tokyo 'docker inspect ghcr.io/ranshen1209/gpt_image_playground:latest --format "{{index .RepoDigests 0}}"'
# 出问题时用旧 digest 重启（compose 临时指定 image 或直接 docker run）
# 例 v0.8.21 基准：ghcr.io/ranshen1209/gpt_image_playground@sha256:58f5e676...455aa
```

`:latest` tag 每次构建都会移动到最新，所以回滚必须靠**记下的 digest**，不能靠 tag。

### 镜像注入约定

`deploy/Dockerfile` build 阶段把 `VITE_DEFAULT_API_URL` 等写成 `__VITE_..._PLACEHOLDER__` 占位符进 bundle，运行时 `deploy/inject-api-url.sh` (`/docker-entrypoint.d/40-inject-api-url.sh`) 用 `sed` 替换为容器环境变量值。**所以同一镜像可以挂不同环境** — compose 改 env 即可，不用重构。

| 容器 env | bundle 占位符 | 默认 / fallback |
|---|---|---|
| `DEFAULT_API_URL` | `__VITE_DEFAULT_API_URL_PLACEHOLDER__` | `https://api.sakrylle.com/v1` |
| `ENABLE_API_PROXY` | `__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__` | `false` |
| `LOCK_API_PROXY` | `__VITE_API_PROXY_LOCKED_PLACEHOLDER__` | `false` |
| `OAUTH_BASE` | `__VITE_SAKRYLLE_OAUTH_BASE_PLACEHOLDER__` | `https://sub.sakrylle.com` |
| `OAUTH_CLIENT_ID` | `__VITE_SAKRYLLE_OAUTH_CLIENT_ID_PLACEHOLDER__` | `sakrylle-image-playground` |
| `OIDC_ENABLED` | `__VITE_SAKRYLLE_OIDC_ENABLED_PLACEHOLDER__` | `false` |
| `API_PROXY_URL` | nginx `${API_PROXY_URL}`（仅启用代理时） | 空 |
| `HOST` / `PORT` | nginx listen | `0.0.0.0:80` |

`ENABLE_API_PROXY=false`（生产配置）时 `inject-api-url.sh` 会把 nginx config 里 `# BEGIN API PROXY` 到 `# END API PROXY` 整段删掉，避免误开同源代理。**前端默认走浏览器直连 `https://api.sakrylle.com/v1`，不走容器 nginx 代理** — 这是 Sakrylle 部署的有意选择（直连 api 子域名让 CORS / OAuth / 监控边界更清晰）。

### 与 sub2api 的耦合

OAuth PKCE client 已在 sub2api migration `143_oauth_seed_sakrylle.sql` 注册：

- `client_id`: `sakrylle-image-playground`
- `redirect_uris`: `https://image.sakrylle.com/oauth/callback`、`http://localhost:5173/oauth/callback`（精确白名单，**不是前缀匹配**）
- `default_group_id=5`（GPT-Image，按次 $0.15/call，`allow_image_generation=true`）

要换域名 / 加测试回调：去 sub2api 服务器 `psql` 改 `oauth_clients.redirect_uris`（jsonb 数组），**不要在本仓库改** — 这表是 sub2api 持有的，本仓库改了也没用。

### 首次部署（一次性）

DNS、nginx、compose 三件套照 Obsidian 部署文档走。摘要：

1. Cloudflare 添 A 记录 `image.sakrylle.com → 64.83.47.108`（DNS only，不 proxied）
2. `/opt/stack/nginx/conf.d/sakrylle-image.conf`：80 → 301 https；8443 → SSL（复用 `sakrylle.com` wildcard cert）→ `proxy_pass http://gpt-image-playground:80`，`client_max_body_size 600m`（蒙版编辑器多图上传可能很大），`proxy_read_timeout 600s`（流式图像生成），`proxy_buffering off`
3. `/opt/stack/docker-compose.yml` 加服务 `gpt-image-playground`，挂 `stack_default` 网络，`DEFAULT_API_URL=https://api.sakrylle.com/v1`，`ENABLE_API_PROXY=false`，`depends_on: nginx`
4. `docker compose up -d gpt-image-playground` + `docker exec nginx nginx -s reload`
5. 浏览器开 `https://image.sakrylle.com/`，点登录 → 确认跳 `sub.sakrylle.com/oauth/authorize?...client_id=sakrylle-image-playground...` 不报 `redirect_uri_mismatch`

## 同步上游

```bash
git fetch upstream && git checkout theme/sakrylle && git rebase upstream/main
```

预期冲突文件（已 rebrand，rebase 上游必冲）：

- `index.html`（title / theme-color / icon / `sakrylle-ambient` body class / **首屏 FOUC IIFE**）
- `src/index.css`（`--primary` HSL + 末尾 `glass-*` utility 块 + `sakrylle-ambient` 渐变 + `mention-tag` 紫色配色）
- `src/lib/apiProfiles.ts`（`DEFAULT_BASE_URL` fallback + i18n 错误信息）
- `src/components/Header.tsx`（已大改：Logo + 余额 + 充值 + 删 install/help + 主题/语言切换 + visibility 轮询）
- `src/components/SettingsModal.tsx` 关于页段 + i18n 改造
- `src/components/icons.tsx`（新增 `SakrylleLogo` / `CoinIcon`）
- `src/main.tsx`（OAuth callback 处理 + i18n import）
- `src/App.tsx`（首次访问弹窗 + i18n）
- `tailwind.config.js`（如果加了 sakrylle 自定义色阶）
- `README.md`（必冲，每次手动 reconcile 或干脆维护两份）
- `public/manifest.webmanifest` + `public/favicon.png`（图标 + 名称）
- `package.json` `version` 字段
- `public/sw.js` `CACHE_NAME` 版本
- `deploy/Dockerfile`（新增 `__VITE_SAKRYLLE_*` + `__VITE_DOCKER_*` 占位符）
- `deploy/inject-api-url.sh`（新增 OAUTH_BASE / OAUTH_CLIENT_ID / OIDC_ENABLED 注入逻辑）
- `src/vite-env.d.ts`（`ImportMetaEnv` 新增 Sakrylle 变量声明）
- `src/store.ts`（import groupSelection / oauthFallback / sakrylle 模块）

新增文件（rebase 上游不会冲，但要保留）：

- `src/lib/sakrylleAuth.ts` + `.test.ts` — OAuth PKCE + OIDC
- `src/lib/sakrylleAccount.ts` + `.test.ts` — 平台 API（余额/模型/me）
- `src/lib/sakrylleOidcDiscovery.ts` + `.test.ts` — OIDC Discovery
- `src/lib/oauthFallback.ts` + `.test.ts` — OAuth Bearer 回退
- `src/lib/groupSelection.ts` + `.test.ts` — 多 Group 选择
- `src/lib/sakrylleImageSize.ts` + `.test.ts` — Sakrylle 特有尺寸
- `src/lib/i18n.ts` / `src/lib/language.ts` / `src/lib/agentSentinels.ts` + `.test.ts`
- `src/lib/theme.ts`
- `src/locales/zh.json` / `en.json` / `locales.test.ts`
- `src/components/HelpModal.tsx` **已删除** — rebase 若上游改了它，按 ours 处理（保持删除）
- `docs/OAUTH_V2_INTEGRATION.md` / `docs/SAKRYLLE_API_SPEC.md` — API 契约文档
- `oidc-docs/` — OIDC RP 集成指南（外部参考）

跟 sub2api / relay-pulse 同样的"重新删上游新增页 / 重写主题"模式 — 上游加新 feature 时优先 rebase，主题文件冲突按 ours 处理。**特别注意**：上游若引入新组件含 `blue-*` Tailwind class，rebase 后必须 sweep 成莫奈紫 hex（参考之前的 perl 替换脚本）。

## 常见操作

```bash
npm install                                              # 装依赖
npm run dev                                              # 本地开发 http://localhost:5173
npm run mock:api                                         # 起本地故障模拟服务（docs/mock-image-api.md）
npm run test                                             # vitest run（CI 友好）
npm run test:watch                                       # 开发期 watch 模式
npx vitest run src/lib/someFile.test.ts                  # 跑单个测试文件
npm run build                                            # tsc -b && vite build → dist/
npm run preview                                          # 预览 dist/
npm run deploy:cf                                        # build + wrangler deploy
```

构建时 `vite.config.ts` 注入两个全局常量：
- `__APP_VERSION__` — 来自 `package.json` version，用于 UI 版本显示 + Service Worker 缓存一致性
- `__DEV_PROXY_CONFIG__` — 来自 `dev-proxy.config.json`（dev 模式），`null` 表示未启用

# 把默认配置注入构建产物（compile-time）
VITE_DEFAULT_API_URL=https://api.sakrylle.com/v1 \
VITE_SAKRYLLE_PLATFORM_API=https://api.sakrylle.com/v1 \
VITE_SAKRYLLE_OAUTH_BASE=https://sub.sakrylle.com \
VITE_SAKRYLLE_OAUTH_CLIENT_ID=sakrylle-image-playground \
VITE_SAKRYLLE_OIDC_ENABLED=false \
npm run build

# 发版（触发 GHA 多平台 Docker 构建 → ghcr.io）
# 1. bump package.json version + public/sw.js CACHE_NAME
# 2. git tag vX.Y.Z && git push origin vX.Y.Z
```

## 关联仓库 / 资源

- Sakrylle API 主站: [Ranshen1209/sub2api](https://github.com/Ranshen1209/sub2api) `theme/monet-purple`
- 文档站: [Ranshen1209/sakrylle-docs](https://github.com/Ranshen1209/sakrylle-docs)
- 状态页: [Ranshen1209/relay-pulse](https://github.com/Ranshen1209/relay-pulse) `theme/sakrylle`
- 服务器: `ssh-tokyo` (`64.83.47.108`)，stack 在 `/opt/stack`
- Obsidian 部署笔记: `20 Work/ServerOps/Self-Hosted/Sub2API 部署.md`（image 站上线后新增对应 note）


## Sakrylle OIDC Documentation Governance

- `oidc-docs/` is tracked in this repository and is **product-local** documentation for Sakrylle Image only.
- Canonical platform docs live in `../sub2api/sakrylle-docs/`, especially:
  - `10-platform-identity/current-state.md`
  - `10-platform-identity/rp-integration-guide.md`
  - `10-platform-identity/commercial-boundaries.md`
  - `10-platform-identity/configuration-isolation.md`
- Local docs are limited to:
  - `oidc-docs/README.md`
  - `oidc-docs/local-integration.md`
  - `oidc-docs/implementation-status.md`
  - `oidc-docs/troubleshooting.md`
  - `oidc-docs/historical/` for preserved old Image research/plans.
- Do **not** duplicate OIDC Provider protocol, claims policy, roadmap, risk register, or design-system content here. Link to the center docs instead.
- When changing OAuth/OIDC client behavior, `VITE_SAKRYLLE_*` envs, `OIDC_ENABLED`, token storage, discovery, nonce/id_token handling, logout/revoke, group routing, or Image rollout status, update `oidc-docs/` in the same change and update center docs if the shared platform contract changes.
