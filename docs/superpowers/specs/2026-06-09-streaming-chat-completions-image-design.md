# 流式 chat/completions 图像生成 — 设计文档

**日期**: 2026-06-09
**状态**: 设计已确认,待写实现计划
**作者**: brainstorming with Claude

## 背景与问题

用户反馈生图"偶尔超时 / 现在要等好久",画廊模式参考图编辑任务跑满 600s(`DEFAULT_API_TIMEOUT`)后报"请求已取消"。

### 实测根因(2026-06-09,group_id=5 真 key 实打 api.sakrylle.com + 直连上游 right.codes)

| 接口 | Content-Type | 首字节 | 期间字节流动 |
|---|---|---|---|
| `POST /v1/images/generations`(gpt-image-2) | `application/json` | ~37s | **无**(即使传 `stream:true` 上游也忽略,返回整块 JSON) |
| `POST /v1/images/edits` + `stream:true` | `application/json` | ~67s | **无**(同样忽略 stream) |
| `POST /v1/chat/completions` + `stream:true` | **`text/event-stream`** | **~1.2-2.3s** | **有**(持续推 `Progressing...`→`1%`→...→`100%` 心跳) |

**根因**:`images/generations` 和 `images/edits` 生成期间零字节回传。慢图(~3min)的静默期超过 Cloudflare ~100s 空闲窗 → **524 切断**。前端只有单一总超时(600s),无法区分"上游在慢慢画"和"上游卡死干等",只能等满 600s 才 abort。前端现有的 `parseImagesApiStreamResponse` SSE 心跳逻辑在生图路径**从未被触发过**(上游对 images 接口从不返回 event-stream)。

**修复**:把 Sakrylle 图像生成改走流式 `chat/completions`。连续字节流让 Cloudflare 永不判空闲,且 `Progressing...` 进度块提供了真实心跳,可驱动空闲超时和 UI 进度。

### 前置条件(已完成)

网关侧已给 group-5 gpt-image-2 账号强制开 `chat_completions` capability。实测确认 `api.sakrylle.com` 现在返回真流式 SSE(首字节 1.5s),不再报 `400 model not register`。

### 数据契约(实测钉死)

```
块 0-7   delta.content = 进度文本 "Progressing...\n" "1% " "2% " ... "100% "   ← 心跳
块 8     finish_reason="stop"
         delta.content = "\nSuccessfully Generated Image\n\n![image](https://file*.aitohumanize.com/file/XXX.png)"
块 9     data: [DONE]
```

图片是终块 `delta.content` 里的 **Markdown `![image](URL)`**,不是 base64、不是结构化字段。上游过载时终块是 `excessive system load`(无 URL)。

### 实测覆盖的场景(全部通过)

- 文生图:纯文本 message → 流式正常
- 单/多参考图:每张作 `image_url` 多模态输入 → 流式正常
- 蒙版编辑:主图 + 蒙版两张 `image_url` + 文字说明 → 流式正常,**像素验证语义保留**(中心透明区变蓝、边角保持红,与 `images/edits` 真 mask 结果几乎一致)
- 大图:1024² png base64 请求体 1.21MB → 流式正常,无 413/体积限制

## 设计决策(brainstorming 确认)

1. **覆盖范围**:文生图 + 参考图 + 蒙版 + 大图 + 多图全部统一走流式 chat/completions
2. **空闲超时**:60 秒
3. **n>1 多图**:复用现有 `runImageRequestsWithRefill` 凑满 N 逻辑
4. **错误分类**:idle-stall 可重试 / 用户取消不重试 / 整体超时不重试 / 503 账号池不消耗补发预算
5. **路由架构**:方案 A —— 在 `callImagesApiSingle` 内部分流

## §1 架构与路由

入口链路不变:`api.ts::callImageApi` → `callOpenAICompatibleImageApi` → `callImagesApi`(images 模式)→ `callImagesApiSingle` / `callImagesApiConcurrent`。

**分流点**在 `callImagesApiSingle` 顶部(`openaiCompatibleImageApi.ts:635`):

```
callImagesApiSingle(opts, profile):
  if (shouldUseChatImagePath(profile)):
      return callImagesApiViaChat(opts, profile)
  ... 现有 multipart/JSON 逻辑不变 ...
```

`shouldUseChatImagePath(profile)` 门控:
- `profile.streamChatCompletionsImage === true`(新字段,默认 true)
- **且** `isSakrylleApiBaseUrl(profile.baseUrl)`(只对 Sakrylle 启用,保多服务商架构 — fal.ai / 自定义 HTTP 不受影响)

**并发层零改动**:`callImagesApiConcurrent` 的 `runImageRequestsWithRefill` 仍调 `callImagesApiSingle`,分流在其内部发生。凑满 N / worker pool 6 / 补发预算 / `onPartialImage` 槽位接线全部自动复用。文生图、参考图、蒙版、多图统统经过这个分流点,实现"全部统一走流式"。

**新增独立文件** `src/lib/chatCompletionsImageApi.ts`,放 `callImagesApiViaChat` + SSE 解析。理由:`openaiCompatibleImageApi.ts` 已 883 行偏大,新路径是独立职责,单独成文件更清晰、更易测。`openaiCompatibleImageApi.ts` 只加分流判断 + import。

## §2 新组件:chatCompletionsImageApi.ts

职责切成两个纯函数,各自独立可测。

### ① callImagesApiViaChat(opts, profile): Promise<CallApiResult>

构造 chat 请求体:
- `model: profile.model`、`stream: true`
- `messages: [{ role:'user', content: [...] }]`
- content 数组组装:
  - 第一项 `{type:'text', text: PROMPT_REWRITE_GUARD_PREFIX + '\n' + prompt}`(保留改写防护,见 CLAUDE.md)
  - 每张输入图 `{type:'image_url', image_url:{url: dataUrl}}`
  - 蒙版作为额外一张 `image_url` + 文字说明蒙版语义(实测语义成立)
  - 纯文生图时 content 只有 text 项
- 双 `AbortController` 计时器(见 §3)
- `fetch` POST 到 `chat/completions`(`buildApiUrl(profile.baseUrl, 'chat/completions', ...)`)→ 交给 `parseChatCompletionImageStream`
- 复用现有 `getSakrylleImageRequestParams`、`createRequestHeaders`、`buildApiUrl`

### ② parseChatCompletionImageStream(response, mime, onPartialImage, resetIdle): Promise<CallApiResult>

- 复用现有 `readJsonServerSentEvents`(`openaiCompatibleImageApi.ts:230`,已能读 SSE block)
- 每个 `chat.completion.chunk`:累积 `delta.content`,进度文本块当心跳(触发 `resetIdle()`,不产图)
- 终块(`finish_reason:'stop'`)或全文累积后:正则 `/!\[.*?\]\((https?:\/\/[^)]+)\)/` 提取图片 URL
- 提到 URL → `fetchImageUrlAsDataUrl(url, mime, signal)` 转 dataURL(现成函数,`imageApiShared.ts:137`),填进 `CallApiResult.images` + 记 `rawImageUrls`
- **防御性解析**:`delta.content` 可能是 string 或数组,两种都容忍;流正常结束但未提取到任何图片 URL(实测过载时终块是 `excessive system load`)→ 抛可重试错误(当作上游过载),不静默返回空

## §3 双计时器超时 + 错误三拆分

### 双计时器(共用一个 AbortController)

```
overallTimeoutId = setTimeout(abort, profile.timeout * 1000)   // 600s 封顶,不复位
idleTimeoutId    = setTimeout(abort, IDLE_TIMEOUT_MS)           // 60s,每个 SSE chunk 复位
```

- 复位点:`readJsonServerSentEvents` 读循环里每次 `reader.read()` 拿到字节 → `clearTimeout(idleTimeoutId)` + 重设。这是"字节流动"的唯一观测点。
- 进度心跳块每 ~3s 来一次,正常情况永不摸到 60s。
- 两个计时器都在 `finally` clear。
- `IDLE_TIMEOUT_MS = 60000` 常量(实测:首字节 1.2-21s、心跳间隔 ~3s,60s 留足余量不误杀大图上传)。

### abort 来源区分

三种 abort 触发同一个 `controller.abort()`,用自定义 reason 区分:
- 空闲超时:`abort(reason)` 带 `name='IdleTimeout'`
- 整体超时:`abort(reason)` 带 `name='OverallTimeout'`
- 用户取消:外部传入的 signal(现有机制,现有 reason)

### isRetryableError 三拆分(openaiCompatibleImageApi.ts:76)

| 错误 | 可重试 | 理由 |
|---|---|---|
| 空闲超时(60s 无字节) | ✅ | 上游卡死,重试可能换账号成功 |
| 整体超时(有字节流动但到 600s) | ❌ | 真太慢,重试再烧 600s + ¥ |
| 用户主动取消 | ❌ | 用户意图,绝不重试 |
| 网络 TypeError / 429 / 5xx | ✅ | 现状保留 |
| 503 "No available compatible accounts" | 特殊见下 | |

### 503 账号池枯竭特殊处理

实测秒回。现状算 5xx → 可重试 → 在 `runImageRequestsWithRefill` 消耗 2N 补发预算空转烧请求。设计:在 `runImageRequestsWithRefill`(`:122`)识别该特定 503(消息含 "No available compatible accounts"),当轮全是它且零成功 → 立即停止补发(复用现有"全不可重试失败即停"分支),给明确"上游账号繁忙"提示。

### store 超时提示

`getTimeoutStreamingHint`(`store.ts:127`)区分:空闲超时提示"网络中断或上游卡死,已自动重试";整体超时提示"生成超过时限"。新串走 i18n(`errors.*`,中英 parity),持久化用 sentinel(`agentSentinels.ts`)。

## §4 测试策略

### 新文件单测 chatCompletionsImageApi.test.ts(核心)

- `parseChatCompletionImageStream`:
  - 进度块只复位心跳不产图;终块 `![image](URL)` 正确提取 URL
  - `delta.content` string / 数组两种形态都容忍
  - 流正常结束但无 URL(模拟 `excessive system load`)→ 抛可重试错误
  - `onPartialImage` 拿到图后被调用
- `callImagesApiViaChat` 请求体构造:文生图只有 text 项;带参考图 → image_url 项;带蒙版 → 主图+蒙版两个 image_url + 文字说明;`PROMPT_REWRITE_GUARD_PREFIX` 保留
- 空闲超时:mock stall > 60s 的流 → abort + 归类可重试;mock 稳定心跳超过 60s 但每块都来 → 成功完成(证明心跳复位生效)

### 改 openaiCompatibleImageApi.test.ts

- `isRetryableError` 三拆分:idle=可重试、overall=不可重试、user-abort=不可重试、503 账号池=当轮全失败即停不烧预算
- `shouldUseChatImagePath` 门控:Sakrylle baseUrl+开关开=true,非 Sakrylle=false

### 改 apiProfiles.test.ts

`streamChatCompletionsImage` 默认 true;legacy profile 无此字段时归一化补默认

### 改 locales.test.ts

新 `errors.*` key 中英 parity

### 真 key 冒烟(实现后手动)

brainstorming 阶段已实测文生图/参考图/蒙版/多图/大图。实现后回归确认前端串联一致 + 故意触发空闲超时看是否 60s 快速失败。

## §5 改动文件清单

**新增**:
- `src/lib/chatCompletionsImageApi.ts` — `callImagesApiViaChat` + `parseChatCompletionImageStream`
- `src/lib/chatCompletionsImageApi.test.ts`

**修改**:
- `src/types.ts` — `ApiProfile` 加 `streamChatCompletionsImage?: boolean`
- `src/lib/apiProfiles.ts` — `createDefaultOpenAIProfile` 设默认 true;`normalizeApiProfile` 归一化(legacy 补默认)
- `src/lib/openaiCompatibleImageApi.ts` — `callImagesApiSingle` 顶部加 `shouldUseChatImagePath` 分流;`isRetryableError` 三拆分;`runImageRequestsWithRefill` 503 特殊处理;`export` 现有的 `readJsonServerSentEvents`(就地导出,不抽文件 — 避免动太多现有代码,新文件 import 即可)
- `src/store.ts` — `getTimeoutStreamingHint` 区分空闲/整体超时
- `src/locales/zh.json` + `en.json` — 新 `errors.*` 串
- `src/components/SettingsModal.tsx` — `streamChatCompletionsImage` 开关(与 `streamImages` 同区)
- `CLAUDE.md` — 端点表加 chat/completions 图像行;Images-vs-Responses 段加说明;新 profile 字段
- `package.json` version + `public/sw.js` CACHE_NAME

## §6 已知风险

1. **蒙版精度**:实测语义成立但只在 64×64 理想色块验证。真实复杂图 + 不规则蒙版边缘精度未必这么好。上线观察项,不阻塞实现。保留 `images/edits` 多 part 路径在非 Sakrylle baseUrl 下仍可用(本身就是多服务商回退)。
2. **6 并发墙**:只在 `images/generations` 实测,chat/completions 未复测。假设 6,见 429 再调。
3. **Agent 模式无关**:`/v1/responses`(用 `responsesModel`=gpt-5.5)在 group-5 key 上 503 是独立的一 key 一 group 约束问题,不在本设计范围。
4. **图片 URL 跨域**:chat 返回 `file*.aitohumanize.com` 的 HTTP URL,`fetchImageUrlAsDataUrl` 已有 CORS 探测 + 降级提示,复用即可。
