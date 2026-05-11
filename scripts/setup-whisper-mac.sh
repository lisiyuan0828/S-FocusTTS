#!/usr/bin/env bash
# ==============================================================================
#  S-FocusTTS · M3 · whisper.cpp 资产一键下载（macOS）
# ------------------------------------------------------------------------------
#  下载内容：
#    1. whisper.cpp 官方 release 二进制（`whisper-cli`）  →  resources/bin/darwin-{arm64|x64}/
#    2. ggml 模型 `ggml-small-q5_0.bin`（~181 MB）        →  resources/models/
#
#  使用：
#    bash scripts/setup-whisper-mac.sh
#
#  要求：系统已安装 curl / tar / unzip / shasum（macOS 默认都有）。
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="$ROOT/resources"
BIN_DIR="$RES/bin"
MODEL_DIR="$RES/models"

# ---- 版本与下载地址（如需升级仅改此处） -------------------------------------
WHISPER_VERSION="v1.7.2"                  # whisper.cpp release tag
MODEL_FILE="ggml-small-q5_1.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}"

# whisper.cpp release 下的 macOS 预编译包命名示例（若版本变化请到
#   https://github.com/ggerganov/whisper.cpp/releases
# 找对应 asset 名称替换）
WHISPER_MAC_ARCHIVE="whisper-bin-x64.zip"          # 仅作占位示意
# --------------------------------------------------------------------------- #

echo "==> 准备目录"
mkdir -p "$BIN_DIR/darwin-arm64" "$BIN_DIR/darwin-x64" "$MODEL_DIR"

download() {
  local url="$1" out="$2"
  if [[ -f "$out" ]]; then
    echo "    [跳过] 已存在：$out"
    return
  fi
  echo "    curl → $out"
  curl -L --fail --progress-bar "$url" -o "$out"
}

echo ""
echo "==> 下载模型 $MODEL_FILE"
download "$MODEL_URL" "$MODEL_DIR/$MODEL_FILE"
echo "    大小：$(du -h "$MODEL_DIR/$MODEL_FILE" | cut -f1)"

echo ""
echo "==> 获取 whisper-cli 二进制"
echo "    ⚠️  官方 release 目前以 iOS / Android / WASM 为主，macOS 建议从源码编译："
echo "        brew install cmake"
echo "        git clone --depth=1 --branch $WHISPER_VERSION https://github.com/ggerganov/whisper.cpp /tmp/whisper.cpp"
echo "        cd /tmp/whisper.cpp && cmake -B build -DWHISPER_METAL=ON && cmake --build build -j --config Release"
echo "        cp build/bin/whisper-cli $BIN_DIR/darwin-arm64/whisper-cli"
echo ""
echo "    或使用 Homebrew：brew install whisper-cpp"
echo "        然后：cp \$(brew --prefix)/bin/whisper-cli $BIN_DIR/darwin-arm64/whisper-cli"
echo ""
echo "    完成后运行：chmod +x $BIN_DIR/darwin-arm64/whisper-cli"

echo ""
echo "==> 完成。验证："
echo "    ls -lh $BIN_DIR/darwin-arm64/whisper-cli"
echo "    ls -lh $MODEL_DIR/$MODEL_FILE"
