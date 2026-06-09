# 输入图上传前压缩(降采样 + 重编码)— 设计文档

**日期**: 2026-06-10
**状态**: 设计已确认,待写实现计划
**作者**: brainstorming with Claude

## 背景与问题

v0.10.3 上线流式 chat/completions 图像生成后,生产环境**大参考图编辑全部失败**。

### 实测根因(2026-06-10,真 key 实打 api.sakrylle.com)

用户上传图为 **2448×3264 RGB PNG,7.5MB**,base64 编码后膨胀到 **~9.5MB**。实测该请求:

```
[http 200 | 180s 超时 | 仅收到 1 个 Progressing... 心跳块]
```

对比 1.2MB 小图:40s 正常出图,心跳间隔 ~3s。

**根因链**:大图 base64(~9.5MB)请求体 → 上传 + 上游处理极慢 → 心跳块间隔远超 60 秒 → 撞 v0.10.3 引入的 60s 空闲超时 → idle abort 判定可重试 → `callWithRetry` 重试 → 又是大图又超时 → 最终失败。

文生图(无输入图,请求体小)在生产正常;只有**大输入图**(参考图/蒙版编辑)走 chat 路径时被这条链路杀死。

**修复方向**:用户上传图发给上游前,**按需降采样 + 重编码**,把 8MP 照片从 7.5MB 压到几百 KB。请求体变小 → 上传快 + 上游处理快 + 心跳密 → 不再撞空闲超时。这是治本(同时解决上传慢、处理慢、心跳稀疏),不是调大超时阈值的治标。

> 注:这是上一个流式功能 `2026-06-09-streaming-chat-completions-image-design.md` 的后续修复。空闲超时本身不改(它对正常图是对的),改的是"不再喂给上游过大的图"。

## 设计决策(brainstorming 确认)

1. **触发条件**:阈值触发 —— 只压超标的大图,小图原样发(零重编码开销)
2. **压缩参数**:最长边降到 1536px,JPEG quality 0.85(8MP 照片 → ~400-700KB,视觉近乎无损)
3. **原图保留**:只压"发送副本",瞬态;store/db/历史仍存用户原图
4. **实现位置**:方案 A —— 在 `chatCompletionsImageApi.ts::callImagesApiViaChat` 组装 content 之前压
5. **蒙版特判**:蒙版走 PNG 路径保 alpha,只按尺寸触发,不跟主图联动

## §1 架构与新组件

**新增纯函数** `compressImageForUpload(dataUrl, opts?): Promise<string>`,放在 `src/lib/canvasImage.ts`(已有 `loadImage` / `getImageDimensions` / `canvasToBlob` 全部原语,职责同源)。

```
compressImageForUpload(dataUrl, { isMask = false } = {}):
  1. getImageDimensions(dataUrl) 拿原始宽高 + dataUrl.length 估算 base64 体积
  2. 不超阈值 → 原样返回(短路,小图零开销)
  3. 超阈值 → loadImage → 等比缩放最长边 ≤ 1536 画到 canvas
              → canvasToBlob(mime, quality) → blob 转回 dataURL
  4. min(原图, 压缩图):谁小返回谁(防重编码反而变大)
  5. 任何步骤抛错 → catch 返回原 dataUrl(压缩是优化,绝不阻断生图)
```

阈值常量(`canvasImage.ts` 内):
- `COMPRESS_MAX_DIMENSION = 1536`
- `COMPRESS_TRIGGER_BYTES = 1_500_000`(触发判断比较的是 `dataUrl.length`,即 base64 字符串长度,≈ 编码后字节数;1.5M base64 ≈ 原始 ~1.1MB)
- `COMPRESS_JPEG_QUALITY = 0.85`(仅非蒙版的 JPEG 路径用;蒙版走 PNG 无 quality 参数)

**接入点**在 `chatCompletionsImageApi.ts::callImagesApiViaChat`,组装 content 之前:

```
const compressedInputs = await Promise.all(
  opts.inputImageDataUrls.map((u) => compressImageForUpload(u)))
const compressedMask = opts.maskDataUrl
  ? await compressImageForUpload(opts.maskDataUrl, { isMask: true })
  : undefined
... buildChatMessageContent(opts.prompt, compressedInputs, compressedMask) ...
```

**完全瞬态**:压缩只发生在发送那一刻,`opts` 原始 dataUrl 不动,store/db/历史存的仍是用户原图。**只影响 chat 路径**(出问题的路径),旧 images/multipart 路径不碰。

## §2 阈值触发逻辑与压缩细节

**触发判断**(小图必须零开销短路):

```
const approxBytes = dataUrl.length            // base64 长度 ≈ 编码后字节
const { width, height } = await getImageDimensions(dataUrl)
const overSize = Math.max(width, height) > COMPRESS_MAX_DIMENSION
const overBytes = approxBytes > COMPRESS_TRIGGER_BYTES
if (!overSize && !overBytes) return dataUrl    // 短路
```

**边界决策:**

1. **"体积 OR 尺寸"任一超标即压**:尺寸小但体积大的图(截图/插画 PNG)也压;尺寸大但已是高压 JPEG 的也降采样。取或覆盖全。
2. **min(原图, 压缩图) 防变大**:JPEG 重编码极少见但理论上可能比原图大(纯色小图)。比较两者 `dataUrl.length`,返回更小的。保证只会变小。
3. **失败降级**:`loadImage` / canvas / `toBlob` 任一步抛错 → catch 返回原 dataUrl。压缩是优化,不是关键路径。
4. **JPEG 丢 alpha**:JPEG 不支持透明,普通参考图照片无所谓,但蒙版的透明区是语义核心 → 蒙版特判,见 §3。

缩放实现:
```
const scale = Math.min(1, COMPRESS_MAX_DIMENSION / Math.max(width, height))
canvas.width = Math.round(width * scale)
canvas.height = Math.round(height * scale)
ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
const blob = await canvasToBlob(canvas, mime, quality)
```

## §3 蒙版特殊处理

JPEG 不支持透明,而蒙版的**透明区是语义核心**(标记"在哪里编辑")。蒙版被压成 JPEG → 透明区填黑 → 语义全毁。所以蒙版用独立规则:

```
compressImageForUpload(dataUrl, { isMask: true }):
  // 只按尺寸触发(不看体积);重编码必须保 PNG(留 alpha)
  const { width, height } = await getImageDimensions(dataUrl)
  if (Math.max(width, height) <= COMPRESS_MAX_DIMENSION) return dataUrl
  ... 等比缩放画到 canvas → canvasToBlob('image/png') ...   // 绝不 jpeg
```

**关键考量:**
1. **蒙版几乎总是小的** —— 单色 + 透明的形状图,PNG 压得极好,体积通常本就不大,很少触发。
2. **不跟主图联动缩放** —— 上游按多模态语义理解蒙版(非像素级 alpha 叠加),实测蒙版与主图尺寸不必严格相等也能工作。蒙版独立按自己的 1536 上限降采样即可,保持简单。
3. **PNG 重编码保 alpha** —— 降采样可能让透明边缘轻微羽化,但蒙版是粗粒度区域标记,无影响。

实现上 `isMask` 决定两件事:触发只看尺寸(`overBytes` 不参与)、输出 mime 为 `image/png`(无 quality 参数);非蒙版走 §2 的 `image/jpeg` + 0.85。

## §4 测试策略

新增 `canvasImage.test.ts`(若无)或在现有测试文件加 `compressImageForUpload` 用例。jsdom 无真实 canvas/Image 渲染,需 mock `loadImage`、`getImageDimensions`、`canvasToBlob`(或在测试里注入可替换的依赖)。核心断言**逻辑分支**而非真实像素:

- **短路**:小图(尺寸 + 体积都不超阈值)→ 原样返回,`canvasToBlob` 不被调用
- **尺寸超标触发**:宽 3000px 的图 → 调用缩放,最长边算到 1536(scale 数学正确)
- **体积超标触发**:尺寸不大但 `dataUrl.length` > 阈值 → 触发压缩
- **min(原图,压缩图)**:mock 压缩结果比原图大 → 返回原图
- **失败降级**:mock `loadImage` 抛错 → 返回原 dataUrl,不抛
- **蒙版**:`isMask:true` 时输出 `image/png`(断言传给 canvasToBlob 的 mime),且只按尺寸触发
- **非蒙版**:输出 `image/jpeg` + quality 0.85

接入点测试(`chatCompletionsImageApi.test.ts` 补充):
- `callImagesApiViaChat` 对超阈值输入图调用了 `compressImageForUpload`(mock 它,断言传入 content 的是压缩后的 dataUrl)
- 蒙版以 `{isMask:true}` 调用

### 真 key 冒烟(实现后手动)
- 用实测那张 2448×3264 / 7.5MB 大图跑参考图编辑 → 确认请求体降到几百 KB、心跳密、正常出图(不再 180s 超时)
- 小图(<1.5MB)→ 确认未被重编码(原样发,行为不变)

## §5 改动文件清单

**修改:**
- `src/lib/canvasImage.ts` — 新增 `compressImageForUpload` + 三个阈值常量
- `src/lib/chatCompletionsImageApi.ts` — `callImagesApiViaChat` 组装 content 前压缩 inputs + mask
- `src/lib/canvasImage.test.ts`(新增或扩充)— `compressImageForUpload` 单测
- `src/lib/chatCompletionsImageApi.test.ts` — 接入点测试补充
- `package.json` version + `public/sw.js` CACHE_NAME

**不改:**
- store / db / 历史持久化层(原图保留,压缩瞬态)
- 旧 images/multipart 路径(非故障点)
- 空闲超时逻辑(对正常图是对的)

## §6 已知风险

1. **JPEG 对带文字/线条的参考图**:照片压 JPEG 近乎无损,但若用户拿截图/文档当参考图,JPEG 在文字边缘可能有轻微振铃。0.85 质量基本可忽略;真要极致可后续按"图像内容类型"切 WebP,但 YAGNI,先不做。
2. **蒙版降采样边缘羽化**:理论上影响极精细蒙版边界,但上游是语义级理解 + 蒙版极少超 1536,实际几乎不触发。
3. **压缩 CPU 开销**:大图 canvas 重编码在主线程约几十 ms~一两百 ms,一次性、可接受;不引入 worker(YAGNI)。
4. **阈值 1.5MB 的选取**:base64 1.5MB ≈ 原始 ~1.1MB。实测 1.2MB 图能正常工作、9.5MB 失败,阈值取中性偏保守。上线后可据反馈微调常量。
