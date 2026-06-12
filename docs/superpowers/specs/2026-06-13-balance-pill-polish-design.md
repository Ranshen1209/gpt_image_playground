# 余额/充值胶囊视觉打磨 + 余额 tooltip 修复

日期：2026-06-13
范围：`src/components/Header.tsx`（纯展示层 + 一处 JSX 表达式）

## 背景

用户在 Header 余额区发现两个问题（截图见对话）：

1. **余额 tooltip 出现悬空分隔符**：悬停余额时 tooltip 显示「· GPT-Image」，前面的用户名为空，留下一个孤零零的圆点分隔符。
2. **余额/充值胶囊中间接缝生硬**：余额按钮和充值按钮挤在同一个圆角容器里，但两者用了不同的背景处理，直接对接形成一条突兀的硬接缝。

桌面版（`Header.tsx:285–323`）和移动版（`Header.tsx:426–443`）都有同样的接缝问题。

## 修复 A — tooltip 悬空分隔符

`Header.tsx:300` 当前渲染：

```tsx
{balance.username} · {balance.groupName}
```

当 `balance.username` 为 `''`（API 不返回用户名，见 `sakrylleAccount.ts:204` 的 `me.username ?? ''`），结果塌缩成「 · GPT-Image」。

**改为**只用非空片段以 `·` 连接：

```tsx
{[balance.username, balance.groupName].filter(Boolean).join(' · ')}
```

行为：

- 两者都有 → `用户名 · GPT-Image`
- username 为空 → `GPT-Image`（无悬空圆点）
- 两者皆空 → tooltip 内容为空（胶囊仍可用，可接受的边缘情况）

不改动 API。这是优雅降级，与 username 为何为空的根因无关。username 始终为空的根因（`/v1/me` 是否本就不返回用户名）留作可选 follow-up，本次不追。

## 修复 B — 胶囊统一到单一玻璃表面

目标：整个胶囊是**一块连续的玻璃表面**，两个按钮透明叠在上面，用一条细分隔线轻柔区隔，而非两块异色背景硬接。统一采用项目既有的 `.glass-button`（莫奈紫淡染玻璃），符合 CLAUDE.md「新组件优先用 glass-* class，不要写新的 bg-white/X backdrop-blur 组合」。

### 桌面版（`Header.tsx:285–323`）

- **容器**（285）：在现有 wrapper 上加 `glass-button`，移除冗余的 `ring-1 ring-white/50 dark:ring-white/10` 与 `shadow-[...]`（`glass-button` 自带 border + shadow）。保留 `rounded-full overflow-hidden inline-flex h-9 items-stretch`。
- **余额按钮**（290–298）：移除 `bg-white/65 dark:bg-white/[0.06] hover:bg-white/85 dark:hover:bg-white/[0.10] backdrop-blur`，改为 `bg-transparent hover:bg-white/20 dark:hover:bg-white/[0.06]`（仅保留 hover 反馈）。
- **充值按钮**（307–318）：移除 `glass-button border-0 rounded-full`，改为 `bg-transparent hover:bg-white/20 dark:hover:bg-white/[0.06]`，并加左分隔线 `border-l border-white/40 dark:border-white/10`。

这条分隔线是唯一刻意的区隔——细的、品牌一致的线，取代原来的硬色块接缝。

### 移动版（`Header.tsx:426–443`）

与桌面版同样处理，统一为玻璃样式：

- **容器**（426）：加 `glass-button`，移除 `ring-1 ring-white/50 dark:ring-white/10`。保留 `mx-2 mb-2 flex items-stretch rounded-full overflow-hidden`。
- **余额按钮**（427–434）：移除 `bg-white/65 dark:bg-white/[0.06] backdrop-blur`，改为 `bg-transparent hover:bg-white/20 dark:hover:bg-white/[0.06]`。
- **充值按钮**（435–442）：当前用 `glass-button-primary`（实心紫）+ `text-white`——这是移动端接缝的强色块来源。改为 `bg-transparent hover:bg-white/20 dark:hover:bg-white/[0.06]` + `border-l border-white/40 dark:border-white/10`，文字色改为 `text-[#5b4d8e] dark:text-[#c4b8e0]`（与桌面充值按钮一致，去掉 `text-white`）。

注意：此改动让移动端充值按钮从实心紫变为玻璃样式（视觉上不再那么抢眼）。这是用户明确选择的统一方向。

## 不改动的部分

- 余额前的紫色圆点（用户确认 OK）。
- `formatBalance` 逻辑 / 货币符号。
- tooltip 触发机制（`balanceTooltip` / `rechargeTooltip` handlers）。
- 移动版的 gallery/agent 切换块、登录按钮。

## 测试

纯展示性 CSS + 一处 JSX 表达式。无适合的单测（join 表达式过于简单，无值得断言的逻辑分支）。验证方式：

1. `npm run build` — 确认无 TypeScript 类型错误。
2. `npm run dev` — 肉眼检查桌面 + 移动两个断点、light + dark 四种组合下：
   - tooltip 在 username 为空时只显示 `GPT-Image`，无悬空圆点。
   - 胶囊是一块连续玻璃表面，两按钮间是细分隔线而非硬色块接缝。
