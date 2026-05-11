
# S-FocusTTS

> 全局语音收录，按下即说，松手成字。  
> 跨平台（macOS + Windows）桌面工具，完全离线，基于 whisper.cpp。

---

## 当前进度

- ✅ **M1 骨架**：工程初始化 + 全局快捷键 + 呼吸球显隐
- ⏳ M2 录音链路
- ⏳ M3 ASR 接入
- ⏳ M4 文本注入
- ⏳ M5 历史 / 设置 / 托盘 / 版本检查 / 首次引导
- ⏳ M6 权限 & 打包

详见 [docs/project-map.md](./docs/project-map.md)。

---

## 快速开始（M1）

### 环境要求
- Node.js ≥ 20
- pnpm（推荐）或 npm

### 安装与启动

```bash
pnpm install
pnpm dev
```

启动后：
1. 应用在后台常驻（macOS 不显示 Dock 图标）
2. 按下 `Cmd+Shift+Space`（Windows 为 `Ctrl+Shift+Space`）
3. 屏幕中央出现呼吸光球
4. 再按一次，光球消失

### 类型检查 / 打包

```bash
pnpm typecheck
pnpm build
```

---

## 目录结构

```
S-FocusTTS/
├── docs/                # 项目文档（PRD / 架构 / 地图 / 决策归档）
├── src/
│   ├── main/            # Electron 主进程
│   ├── preload/         # 预加载脚本
│   ├── renderer/        # 渲染进程（呼吸球等 UI）
│   └── shared/          # 主/渲染共享常量与类型
├── resources/           # whisper 二进制与模型（后续里程碑）
└── electron.vite.config.ts
```

---

## 架构文档

- [产品需求 PRD](./docs/01-requirements.md)
- [架构设计](./docs/02-architecture.md)
- [项目地图](./docs/project-map.md)（文件级）
- [架构决策归档](./docs/decisions-log.md)

---

## 团队协作模式

采用四角色虚拟团队：  
👔 Dex（决策者） · 🛠️ Ethan（开发） · 🔍 Critic（审查） · 🎨 Polly（体验）  
流程：Dex 拍板 → Ethan 编码 → Critic 审查 → Polly 体验 → 签字关闭

