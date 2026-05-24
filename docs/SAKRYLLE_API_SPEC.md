# Sakrylle 图像工坊 API 对接契约

> 给 sub2api 的 Claude Code 看的对接契约。本仓库的前端代码已经按这份文档编写，等 sub2api 实现下面的 endpoint 后即可联调。
>
> 本仓库（`Ranshen1209/gpt_image_playground`，theme 待迁到 `theme/sakrylle`）即 `image.sakrylle.com` 的前端，与 `sub.sakrylle.com`（sub2api）配合使用。

## 高层架构

```
浏览器（image.sakrylle.com SPA）
    ├── OAuth 2.0 Authorization Code + PKCE → sub.sakrylle.com/oauth/{authorize,token}
    ├── 余额查询  GET /v1/account/balance     ← Bearer access_token
    ├── 模型列表  GET /v1/models               ← Bearer access_token
    └── 图像生成  POST /v1/images/{generations,edits}  ← Bearer access_token
```

`access_token` 既是 OAuth token，也直接当 GPT-Image group key 给 `/v1/images/*` 用 — sub2api 在 `/v1/*` 中间件需要识别两种 Authorization：原始 group key（`sk-...`）以及 OAuth access_token，对后者解析出对应用户的 group key 后内部转发。

---

## 1. OAuth 2.0 Authorization Code + PKCE

### 1.1 客户端注册

sub2api 后台先建一条 client：

| 字段 | 值 |
|---|---|
| `client_id` | `sakrylle-image-playground` |
| `client_secret` | **不设置**（PKCE 公开 client） |
| `redirect_uris` | `https://image.sakrylle.com/oauth/callback`、`http://localhost:5173/oauth/callback` |
| `allowed_scopes` | `image_generation`、`balance:read`、`models:read` |
| `pkce_required` | `true` |

### 1.2 `GET /oauth/authorize`

**Query 参数（必填）**：

| 参数 | 说明 |
|---|---|
| `client_id` | `sakrylle-image-playground` |
| `redirect_uri` | 必须命中 client 的 `redirect_uris` 白名单 |
| `response_type` | 固定 `code` |
| `scope` | 空格分隔，如 `image_generation balance:read models:read` |
| `state` | 前端生成的随机字符串，原样回传 |
| `code_challenge` | PKCE verifier 的 SHA-256 base64url |
| `code_challenge_method` | 固定 `S256` |

**用户同意**：
```
HTTP/1.1 302 Found
Location: <redirect_uri>?code=<authcode>&state=<state>
```

`code` 短期有效（建议 10 min TTL，单次使用）。

**用户拒绝**：
```
Location: <redirect_uri>?error=access_denied&state=<state>
```

### 1.3 `POST /oauth/token`

`Content-Type: application/x-www-form-urlencoded`。

**授权码换 access_token**（`grant_type=authorization_code`）：

```
grant_type=authorization_code
code=<authcode>
redirect_uri=<必须与 authorize 时一致>
client_id=sakrylle-image-playground
code_verifier=<PKCE verifier 原文>
```

成功响应：
```json
{
  "access_token": "sk_oauth_...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "refresh_token": "rt_...",
  "scope": "image_generation balance:read models:read"
}
```

`access_token` 内部需要绑定到该用户的 GPT-Image group key（group_id=5），以便 `/v1/images/*` 的下游处理直接拿来扣 group 余额。

**refresh_token 续期**（`grant_type=refresh_token`）：

```
grant_type=refresh_token
refresh_token=<rt_...>
client_id=sakrylle-image-playground
```

响应同上。建议旋转 refresh_token（每次返回新值）。

### 1.4 错误响应

OAuth 标准错误（4xx）：

```json
{ "error": "invalid_grant", "error_description": "authorization code expired" }
```

可能取值：`invalid_request`、`invalid_client`、`invalid_grant`、`unauthorized_client`、`unsupported_grant_type`、`invalid_scope`。

---

## 2. 账户余额

### `GET /v1/account/balance`

**Header**: `Authorization: Bearer <access_token>`

**响应**：
```json
{
  "user_id": "uuid-or-int",
  "username": "alice",
  "credit_remaining_cny": 12.34,
  "credit_remaining_usd": 1.78,
  "currency_display": "CNY",
  "rate_multiplier": 1.0,
  "group_id": 5,
  "group_name": "GPT-Image"
}
```

字段说明：
- `credit_remaining_cny` / `credit_remaining_usd`：以两种货币展示的剩余额度（前端只渲染 CNY，但保留 USD 做扩展）
- `currency_display`：前端默认显示哪一种（`CNY` 或 `USD`）
- `rate_multiplier`：当前 group 的扣费倍率
- `group_id`、`group_name`：用户当前 group（GPT-Image group_id=5）

**错误**：401（token 过期）、403（用户被禁用）。

---

## 3. 模型列表

### `GET /v1/models`

**Header**: `Authorization: Bearer <access_token>`

OpenAI 兼容格式 + 扩展字段：

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-image-2",
      "object": "model",
      "owned_by": "sakrylle",
      "allow_image_generation": true,
      "billing_mode": "per_request",
      "per_request_price_usd": 0.15
    }
  ]
}
```

只返回**当前用户的 group 实际可用**的模型，并标注 `allow_image_generation`。前端只渲染 `allow_image_generation === true` 的项。

---

## 4. 图像生成（已存在，需要兼容 OAuth token）

`POST /v1/images/generations` 与 `POST /v1/images/edits` 的请求/响应格式与 OpenAI Images API 一致（已有），不需要改业务逻辑。

**唯一新增**：Authorization header 现在可能是：
1. 传统 group key（`sk-...`，原有路径）
2. OAuth access_token（新增）

sub2api 的鉴权中间件应该都接受。OAuth access_token 内部映射到对应用户的 group key，然后走原本的 `/v1/images/*` 路径扣费即可。

每次成功调用按 `per_request_price_usd` 扣费（GPT-Image group 的 `billing_mode='per_request'`，`per_request_price=0.15`）。

### 4.1 错误码契约

| HTTP | 业务码 | 触发场景 | 前端处理 |
|---|---|---|---|
| 401 | - | token 过期/无效 | 触发 refresh_token 流程，失败则跳登录 |
| 403 | `image_generation_not_enabled` | group 不允许图像生成 | 弹"该账户暂不支持图像生成" |
| 403 | `insufficient_quota` | 余额不足 | 弹"余额不足"+ 链接到 sub.sakrylle.com 充值页 |
| 429 | - | 限速 | 重试或提示用户稍后再试 |

403 响应体格式（OpenAI 兼容）：
```json
{ "error": { "code": "image_generation_not_enabled", "message": "..." } }
```

---

## 5. 实现 Checklist（给 sub2api Claude）

- [ ] **数据库表**
  - [ ] `oauth_clients`：`client_id` / `redirect_uris (jsonb)` / `allowed_scopes (jsonb)` / `pkce_required (bool)` / `created_at`
  - [ ] `oauth_codes`：`code (PK)` / `client_id` / `user_id` / `redirect_uri` / `scope` / `code_challenge` / `code_challenge_method` / `expires_at`（10 min TTL）/ `used_at`
  - [ ] `oauth_tokens`：`access_token (PK)` / `refresh_token (unique)` / `client_id` / `user_id` / `scope` / `expires_at` / `refresh_expires_at` / `linked_group_id`

- [ ] **路由**
  - [ ] `GET  /oauth/authorize`：渲染同意页 → 302 回 `redirect_uri`
  - [ ] `POST /oauth/token` (authorization_code)：校验 PKCE，签发 access_token + refresh_token
  - [ ] `POST /oauth/token` (refresh_token)：旋转续期
  - [ ] `GET  /v1/account/balance`：读用户当前 group 的余额
  - [ ] `GET  /v1/models`：返回 `allow_image_generation` 字段
  - [ ] `/v1/images/*` 中间件兼容 OAuth token（解析为 group key → 原逻辑）

- [ ] **注册首个 client**
  - `client_id=sakrylle-image-playground`、`redirect_uris=[https://image.sakrylle.com/oauth/callback, http://localhost:5173/oauth/callback]`、`pkce_required=true`、`allowed_scopes=[image_generation, balance:read, models:read]`

- [ ] **CORS**：`https://image.sakrylle.com`、`http://localhost:5173` 加入 allow-origin（`/oauth/token`、`/v1/account/balance`、`/v1/models`、`/v1/images/*`）

- [ ] **测试**
  - [ ] PKCE 完整流程（curl + Python helper 都通）
  - [ ] access_token 调 `/v1/images/generations` 真扣余额
  - [ ] refresh_token 续期、旋转
  - [ ] state 不匹配的回调被拒绝
  - [ ] 错误 client_id / redirect_uri / scope 返 OAuth 标准错误

---

## 6. 前端的兼容期降级（已实现）

OAuth endpoint 未上线时本仓库前端的处理：

1. SettingsModal 启动时 `HEAD /oauth/authorize` 探测一次，结果缓存 5 分钟（sessionStorage）。
2. endpoint 不可用时登录按钮显示"账户系统准备中"灰色态。
3. 余额徽章不显示。
4. 模型下拉回落到硬编码 `['gpt-image-2']`。
5. 用户仍可在 SettingsModal 里手填 API Key（兼容期入口）走 `/v1/images/*` 现有 group key 流程。

sub2api 上线 OAuth 后无需前端改动，下次刷新即生效。
