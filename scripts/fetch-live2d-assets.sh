#!/usr/bin/env bash
# 拉取受限第三方资产（不能入库，见 .gitignore / NOTICE）。
#
# 用法：
#   ./scripts/fetch-live2d-assets.sh            # 用本机 DSH 缓存 + 已编译的 vendor
#   ./scripts/fetch-live2d-assets.sh --vendor /path/to/live2d-vendor.js
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/desktop/live2d-web"
VENDOR_SRC=""
MODEL_SRC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vendor) VENDOR_SRC="$2"; shift 2 ;;
    --model)  MODEL_SRC="$2";  shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

mkdir -p "$DEST/vendor" "$DEST/model"

# 1) Cubism Core：官方 CDN，许可为 Live2D 专有，只能本地缓存
CORE="$HOME/.dsh/pets/.runtime/live2dcubismcore.min.js"
if [[ -f "$CORE" ]]; then
  cp "$CORE" "$DEST/vendor/live2dcubismcore.min.js"
  echo "✓ Cubism Core ← $CORE"
else
  curl -fsSL "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js" \
    -o "$DEST/vendor/live2dcubismcore.min.js"
  echo "✓ Cubism Core ← 官方 CDN"
fi

# 2) 引擎（pixi + live2d engine 的打包产物）
if [[ -n "$VENDOR_SRC" ]]; then
  cp "$VENDOR_SRC" "$DEST/vendor/live2d-vendor.js"
  echo "✓ vendor ← $VENDOR_SRC"
elif [[ -f "$DEST/vendor/live2d-vendor.js" ]]; then
  echo "· vendor 已存在，跳过"
else
  echo "✗ 缺少 live2d-vendor.js：请用 --vendor 指定（来源见 docs/nanobot-assessment.md 或 NOTICE）"
  exit 1
fi

# 3) 模型（CC BY-NC-SA 4.0，仅个人使用）
if [[ -n "$MODEL_SRC" ]]; then
  cp -R "$MODEL_SRC"/. "$DEST/model/"
  echo "✓ 模型 ← $MODEL_SRC"
elif [[ -f "$DEST/model/c_0120.model3.json" ]]; then
  echo "· 模型已存在，跳过"
else
  echo "✗ 缺少模型：请用 --model 指定 ds-whale-girl 目录"
  echo "  来源：https://github.com/A8Chann/dsh-pet-live2d (pets/ds-whale-girl)"
  exit 1
fi

echo "完成。构建：cd desktop && ./build.sh --install"
