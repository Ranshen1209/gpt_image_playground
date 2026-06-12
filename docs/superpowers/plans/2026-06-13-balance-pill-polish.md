# 余额/充值胶囊视觉打磨 + tooltip 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复余额 tooltip 的悬空分隔符，并把桌面+移动版的余额/充值胶囊统一到单一玻璃表面，消除中间硬接缝。

**Architecture:** 纯展示层改动，全部集中在 `src/components/Header.tsx`。一处 JSX 表达式（tooltip join）+ 两组 className 调整（桌面胶囊 285–322、移动胶囊 426–443）。用项目既有 `.glass-button` 玻璃 class 做统一表面，按钮透明叠加 + 细分隔线区隔。

**Tech Stack:** React 19 + TypeScript + Tailwind 3 + 项目自定义 `glass-*` utility（`src/index.css`）。

参考设计文档：`docs/superpowers/specs/2026-06-13-balance-pill-polish-design.md`

---

### Task 1: 修复 tooltip 悬空分隔符

**Files:**
- Modify: `src/components/Header.tsx:300`

- [ ] **Step 1: 改 tooltip 内容为非空 join**

把第 300 行：

```tsx
                    {balance.username} · {balance.groupName}
```

改为：

```tsx
                    {[balance.username, balance.groupName].filter(Boolean).join(' · ')}
```

说明：`filter(Boolean)` 去掉空字符串，`join(' · ')` 仅在两段都存在时插入分隔符。username 为空时只显示 `GPT-Image`，无悬空圆点。

- [ ] **Step 2: 类型检查**

Run: `npm run build`
Expected: 构建成功，无 TypeScript 错误（`tsc -b && vite build` 全过）。

- [ ] **Step 3: Commit**

```bash
git add src/components/Header.tsx
git commit -m "fix: 余额 tooltip 用户名为空时去掉悬空分隔符"
```

---

### Task 2: 桌面版胶囊统一玻璃表面

**Files:**
- Modify: `src/components/Header.tsx:285`（容器）、`:293`（余额按钮）、`:313`（充值按钮）

- [ ] **Step 1: 容器加 glass-button，移除冗余 ring/shadow**

把第 285 行：

```tsx
              <div className="hidden h-9 items-stretch gap-0 overflow-hidden rounded-full ring-1 ring-white/50 shadow-[0_4px_14px_rgba(145,129,189,0.18)] dark:ring-white/10 lg:inline-flex">
```

改为：

```tsx
              <div className="glass-button hidden h-9 items-stretch gap-0 overflow-hidden rounded-full lg:inline-flex">
```

- [ ] **Step 2: 余额按钮背景改透明**

把第 293 行（余额按钮 className）：

```tsx
                    className="inline-flex items-center gap-1.5 px-3 text-xs font-semibold text-[#5b4d8e] dark:text-[#c4b8e0] bg-white/65 dark:bg-white/[0.06] hover:bg-white/85 dark:hover:bg-white/[0.10] transition-colors backdrop-blur"
```

改为：

```tsx
                    className="inline-flex items-center gap-1.5 px-3 text-xs font-semibold text-[#5b4d8e] dark:text-[#c4b8e0] bg-transparent hover:bg-white/20 dark:hover:bg-white/[0.06] transition-colors"
```

- [ ] **Step 3: 充值按钮背景改透明 + 加左分隔线**

把第 313 行（充值按钮 className）：

```tsx
                    className="inline-flex items-center gap-1 px-3 text-xs font-semibold glass-button border-0 rounded-full text-[#5b4d8e] dark:text-[#c4b8e0]"
```

改为：

```tsx
                    className="inline-flex items-center gap-1 px-3 text-xs font-semibold bg-transparent hover:bg-white/20 dark:hover:bg-white/[0.06] transition-colors border-l border-white/40 dark:border-white/10 text-[#5b4d8e] dark:text-[#c4b8e0]"
```

- [ ] **Step 4: 类型检查**

Run: `npm run build`
Expected: 构建成功，无 TypeScript 错误。

- [ ] **Step 5: Commit**

```bash
git add src/components/Header.tsx
git commit -m "style: 桌面余额/充值胶囊统一玻璃表面，细分隔线替代硬接缝"
```

---

### Task 3: 移动版胶囊统一玻璃表面

**Files:**
- Modify: `src/components/Header.tsx:426`（容器）、`:430`（余额按钮）、`:438`（充值按钮）

- [ ] **Step 1: 容器加 glass-button，移除 ring**

把第 426 行：

```tsx
            <div className="mx-2 mb-2 flex items-stretch rounded-full overflow-hidden ring-1 ring-white/50 dark:ring-white/10">
```

改为：

```tsx
            <div className="glass-button mx-2 mb-2 flex items-stretch rounded-full overflow-hidden">
```

- [ ] **Step 2: 余额按钮背景改透明**

把第 430 行（移动余额按钮 className）：

```tsx
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#5b4d8e] dark:text-[#c4b8e0] bg-white/65 dark:bg-white/[0.06] backdrop-blur"
```

改为：

```tsx
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#5b4d8e] dark:text-[#c4b8e0] bg-transparent hover:bg-white/20 dark:hover:bg-white/[0.06] transition-colors"
```

- [ ] **Step 3: 充值按钮从实心紫改玻璃透明 + 左分隔线**

把第 438 行（移动充值按钮 className）：

```tsx
                className="flex-1 inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-semibold text-white glass-button-primary border-0 rounded-none"
```

改为：

```tsx
                className="flex-1 inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-semibold text-[#5b4d8e] dark:text-[#c4b8e0] bg-transparent hover:bg-white/20 dark:hover:bg-white/[0.06] transition-colors border-l border-white/40 dark:border-white/10"
```

说明：去掉 `text-white` 和 `glass-button-primary`（实心紫），改为与桌面一致的玻璃透明 + 莫奈紫文字。`rounded-none` 不再需要（容器 `overflow-hidden` 已裁圆角）。

- [ ] **Step 4: 类型检查**

Run: `npm run build`
Expected: 构建成功，无 TypeScript 错误。

- [ ] **Step 5: Commit**

```bash
git add src/components/Header.tsx
git commit -m "style: 移动余额/充值胶囊统一玻璃表面，充值按钮从实心紫改玻璃"
```

---

### Task 4: 视觉验证

**Files:** 无（手动验证）

- [ ] **Step 1: 启动 dev server**

Run: `npm run dev`
Expected: Vite 在 `http://localhost:5173` 启动。

- [ ] **Step 2: 肉眼检查四种组合**

在浏览器中（需登录态以显示余额胶囊），检查桌面（≥lg 宽度）+ 移动（窄屏）× light + dark 四种组合：

1. **tooltip**：悬停余额，username 为空时只显示 `GPT-Image`，无前导悬空圆点。
2. **胶囊表面**：余额与充值按钮坐在同一块连续玻璃表面上，两者之间是一条细分隔线，而非两块异色背景的硬接缝。
3. **hover**：分别悬停余额按钮、充值按钮，背景有轻微高亮反馈。
4. **移动充值按钮**：不再是实心紫，而是与余额一致的玻璃透明 + 莫奈紫文字。

Expected: 全部符合；若某组合下分隔线太弱/太重或对比不足，回到对应 Task 微调 `border-white/40 dark:border-white/10` 或 hover 透明度。

- [ ] **Step 3: 停止 dev server**

按 Ctrl+C 结束。无需 commit（本任务无代码改动）。
