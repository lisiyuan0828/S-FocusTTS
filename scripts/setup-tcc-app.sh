#!/usr/bin/env bash
# S-FocusTTS · macOS TCC 稳定路径配置脚本
#
# 为什么需要这个脚本？
#   pnpm 安装的 Electron.app 位于 node_modules/.pnpm/electron@<hash>/... 路径，
#   每次 pnpm install / Electron 升级都可能变 hash，导致 macOS "辅助功能"
#   里之前勾选的授权路径对不上，isTrusted 仍返回 false。
#
# 解决：在 ~/Library/Application Support/S-FocusTTS-dev/ 下建一个固定名的
#   软链指向当前真实 Electron.app。用这个稳定路径去"辅助功能"授权，
#   后续无论 pnpm 怎么换 hash，软链重建即可，授权永久有效。
#
# 使用：
#   bash scripts/setup-tcc-app.sh
# 之后 dev 启动走 `pnpm dev:tcc`（见 package.json scripts）即可。

set -e

# 仅 macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo "[setup-tcc-app] 非 macOS 环境，跳过"
  exit 0
fi

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# require('electron') 输出可执行文件路径，例如
# .../Electron.app/Contents/MacOS/Electron
ELECTRON_EXEC="$(cd "$PROJECT_ROOT" && node -e "console.log(require('electron'))")"

if [[ -z "$ELECTRON_EXEC" ]] || [[ ! -x "$ELECTRON_EXEC" ]]; then
  echo "❌ 无法定位 Electron 可执行文件：$ELECTRON_EXEC"
  echo "   请先 pnpm install 完成并确认 electron 依赖已装好"
  exit 1
fi

# 截到 .app Bundle
ELECTRON_APP="${ELECTRON_EXEC%/Contents/MacOS/*}"
if [[ "$ELECTRON_APP" == "$ELECTRON_EXEC" ]] || [[ ! -d "$ELECTRON_APP" ]]; then
  echo "❌ 从 execPath 推导 .app Bundle 失败：$ELECTRON_APP"
  exit 1
fi

# 稳定目标路径
STABLE_DIR="$HOME/Library/Application Support/S-FocusTTS-dev"
STABLE_APP="$STABLE_DIR/Electron.app"
STABLE_EXEC="$STABLE_APP/Contents/MacOS/Electron"

mkdir -p "$STABLE_DIR"

# 如果已是软链且指向正确位置，跳过
if [[ -L "$STABLE_APP" ]] && [[ "$(readlink "$STABLE_APP")" == "$ELECTRON_APP" ]]; then
  echo "✅ 软链已就位：$STABLE_APP  →  $ELECTRON_APP"
else
  # 旧软链或旧目录都清掉，重建
  if [[ -e "$STABLE_APP" ]] || [[ -L "$STABLE_APP" ]]; then
    rm -rf "$STABLE_APP"
  fi
  ln -s "$ELECTRON_APP" "$STABLE_APP"
  echo "✅ 已创建稳定软链："
  echo "    $STABLE_APP"
  echo "    → $ELECTRON_APP"
fi

echo ""
echo "────────────────────────────────────────────────────────────────"
echo "📋 下一步（一次性，授权后永久有效）："
echo ""
echo "  1) 打开「系统设置 → 隐私与安全 → 辅助功能」"
echo "  2) 删除列表里所有旧的 Electron / FocusTTS / S-FocusTTS 条目（点 − 号）"
echo "  3) 点 + 号，按 ⌘⇧G，粘贴下面这个**稳定路径**："
echo ""
echo "      $STABLE_APP"
echo ""
echo "  4) 选中 Electron.app 后点「打开」→ 勾选开关"
echo "  5) 用以下命令启动 dev（走稳定路径）："
echo ""
echo "      pnpm dev:tcc"
echo ""
echo "────────────────────────────────────────────────────────────────"

# 自动在 Finder 中定位稳定软链，方便用户直接拖拽
open -R "$STABLE_APP" 2>/dev/null || true

# 把稳定路径的可执行文件路径导出到 .env.tcc，便于 dev 脚本使用
echo "ELECTRON_EXEC_PATH=\"$STABLE_EXEC\"" > "$PROJECT_ROOT/.env.tcc"
echo ""
echo "（已写入 $PROJECT_ROOT/.env.tcc）"
