# 移除「流式 chat/completions 生图」+ 流式传输默认开启

日期: 2026-06-12

## 背景

设置 → API 页的「流式传输」分组当前有三项：

1. **流式 chat/completions 生图** (`streamChatCompletionsImage`) — 默认 `true`，Sakrylle 官方接口下走 `POST chat/completions` `stream:true` 路径（v0.10.3 引入，为防 Cloudflare 524）
2. **流式传输** (`streamImages`) — images 模式默认 `false`，走 `images/generations|edits` `stream:true` + `partial_images` 心跳
3. **请求中间步骤图像数** (`streamPartialImages`) — 默认 `1`

链路优先级：`shouldUseChatImagePath`（= `streamChatCompletionsImage===true && Sakrylle`）优先于 `streamImages`。

## 目标

1. **删除「流式 chat/completions 生图」** — 彻底移除整条 chat/completions 图像链路（字段 + 代码 + 文件 + 测试 + 文档），而非仅藏 UI。原因：该开关默认 `true`，仅藏 UI 会让现有用户/新档继续走 chat 路径，等于没删；强制 false 也要改同样的默认值，不如彻底删干净，避免死代码。
2. **流式传输（`streamImages`）默认改为开启** — openai 在 images 模式也默认 `true`。配合默认 `partial_images=1` 的心跳，慢图靠中间图维持连接，缓解 524。
3. **保留** 流式传输开关 + 请求中间步骤图像数下拉。

旧档 localStorage 里残留的 `streamChatCompletionsImage:true` 在读取层全部删除后被自然忽略，无需迁移。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/lib/apiProfiles.ts` | `getDefaultStreamImages`：openai 任意模式返回 `true`；删 `streamChatCompletionsImage` 默认值（createDefaultOpenAIProfile / normalize / load / DEFAULT_SETTINGS 四处） |
| `src/types.ts` | 删 `ApiProfile` 与 draft 类型里的 `streamChatCompletionsImage?: boolean`（两处） |
| `src/lib/openaiCompatibleImageApi.ts` | 删 `shouldUseChatImagePath`、`callImagesApiSingle` 里的 dispatch、`callImagesApiViaChat` import |
| `src/lib/chatCompletionsImageApi.ts` + `.test.ts` | 删除文件 |
| `src/store.ts` | `TimeoutStreamingHintProfile` Pick 去掉字段；删 `getTimeoutStreamingHint` 里 chat 分支；hint Pick（1972）与 hintProfile（4625）去字段 |
| `src/components/SettingsModal.tsx` | 删 chat 开关 UI 子块；删 export/url 拼装里的字段（723）；line 116 dedup 检查不涉及该字段（无需改） |
| `src/locales/zh.json` / `en.json` | 删 `settings.api.streamChatImage` / `streamChatImageHint`；删失效的 `errors.timeoutHintChatOverall` |
| `src/lib/openaiCompatibleImageApi.test.ts` | 删 `shouldUseChatImagePath` describe 块 + import |
| `src/lib/apiProfiles.test.ts` / `api.test.ts` / `oauthFallback.test.ts` | 更新 `streamImages` 默认断言（images 模式现为 true）+ 删 `streamChatCompletionsImage` 断言 |
| `CLAUDE.md` | 更新 v0.10.3「流式 chat/completions 图像路径」段，标记已移除 |

## 测试策略

TDD：先更新测试断言（`streamImages` 默认 true、移除 chat 字段/函数），跑测试看红，再改实现转绿。最终 `npm run test` + `npm run build` 全绿。

## 风险

- 移除 chat 路径后，慢图依赖 `streamImages`+`partial_images` 心跳防 524。默认 `partial_images=1` 已提供心跳，但 CLAUDE.md v0.10.3 曾记录「images/generations 即使 stream:true 也返回整块 JSON」。该结论与 streamImages 心跳机制存在张力——属用户已知的产品决策，本次按用户指示执行；上线后需观察慢图是否仍触发 524。
