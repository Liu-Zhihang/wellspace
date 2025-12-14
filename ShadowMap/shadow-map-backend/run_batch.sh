#!/bin/bash



# =======================================================

# 批处理配置 (全英文路径版)

# =======================================================

# 强制 UTF-8 环境 (防止其他潜在乱码)

export LANG=C.UTF-8

export LC_ALL=C.UTF-8



# 1. Inputs/outputs (set via env or ShadowMap/.shadowmap.env)

BUCKET_DIR="${BUCKET_DIR:-}"
OUTPUT_ROOT="${OUTPUT_ROOT:-}"
INPUT_ROOT_BASE="${INPUT_ROOT_BASE:-${INPUT_ROOT:-}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENGINE_WRAPPER="${ENGINE_WRAPPER:-${SCRIPT_DIR}/../scripts/batch-mobility-shadow.sh}"

# Optional: load a machine profile (see ShadowMap/.shadowmap.env.example)
if [ "${SHADOWMAP_ENV_FILE:-}" = "/dev/null" ]; then
    : # explicitly skip loading any profile
elif [ -n "${SHADOWMAP_ENV_FILE:-}" ] && [ -f "${SHADOWMAP_ENV_FILE}" ]; then
    # shellcheck disable=SC1090
    source "${SHADOWMAP_ENV_FILE}"
elif [ -f "${REPO_ROOT}/.shadowmap.env" ]; then
    # shellcheck disable=SC1091
    source "${REPO_ROOT}/.shadowmap.env"
fi

OUTPUT_ROOT="${OUTPUT_ROOT:-}"
INPUT_ROOT_BASE="${INPUT_ROOT_BASE:-${INPUT_ROOT:-}}"
CANOPY="${CANOPY:-${SHADOW_ENGINE_CANOPY_RASTER_PATH:-${CANOPY_RASTER_PATH:-}}}"

# 2. Backend URLs (HTTP pipeline only)
BACKEND="${BACKEND:-${BACKEND_URL:-http://localhost:3001/api/analysis/shadow}}"
WEATHER="${WEATHER:-${WEATHER_URL:-http://localhost:3001/api/weather/current}}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3001/api/health}"
CONC="${CONC:-4}"

if [ -z "${OUTPUT_ROOT}" ]; then
    echo "[Fatal] Missing OUTPUT_ROOT. Set it in env or source ShadowMap/.shadowmap.env"
    exit 1
fi
if [ -z "${INPUT_ROOT_BASE}" ]; then
    echo "[Fatal] Missing INPUT_ROOT_BASE/INPUT_ROOT. Set it in env or source ShadowMap/.shadowmap.env"
    exit 1
fi

TASK_ROOT="${SHADOWMAP_TASK_ROOT:-${OUTPUT_ROOT}/_shadowmap_tasks}"
if [ -z "${BUCKET_DIR}" ]; then
    BUCKET_DIR="${TASK_ROOT}/buckets_part2"
fi
mkdir -p "$BUCKET_DIR"



# =======================================================

# 检查部分

# =======================================================

echo "[Check] Backend health:"

curl -s "${HEALTH_URL}" | head -c 200 && echo ""



if [ ! -f "$ENGINE_WRAPPER" ]; then
    echo "[错误] 找不到脚本: $ENGINE_WRAPPER"
    exit 1
fi

engine_wrapper_cmd=("${ENGINE_WRAPPER}")
if [ ! -x "${ENGINE_WRAPPER}" ]; then
    engine_wrapper_cmd=(bash "${ENGINE_WRAPPER}")
fi



# =======================================================

# 任务循环

# =======================================================

shopt -s nullglob

files=("$BUCKET_DIR"/*_retry.txt)

shopt -u nullglob

total=${#files[@]}



if [ $total -eq 0 ]; then

  echo "目录 $BUCKET_DIR 下没有 _retry.txt 文件。"

  exit 0

fi



echo "=== 开始处理 (共 $total 个任务) OUTPUT_ROOT=${OUTPUT_ROOT} ==="



count=0

for bf in "${files[@]}"; do

  count=$((count+1))

  [ -f "$bf" ] || continue



  stem=$(basename "$bf" "_retry.txt")

  

  # 查找 CSV

  target_csv=$(find "$OUTPUT_ROOT" -name "${stem}.csv" -print -quit)

  if [ -z "$target_csv" ]; then

    target_csv=$(find "$OUTPUT_ROOT" -name "${stem}-sunlight.csv" -print -quit)

  fi

  

  if [ -z "$target_csv" ]; then

    echo "[$count/$total] [跳过] 找不到CSV: ${stem}"

    continue

  fi



  target_dir=$(dirname "$target_csv")

  input_dir="${target_dir/$OUTPUT_ROOT/$INPUT_ROOT_BASE}"

  pure_stem=${stem%-sunlight}



  # 确定源文件

  if [ -f "$input_dir/${pure_stem}.csv" ]; then

    source_name="${pure_stem}.csv"

  elif [ -f "$input_dir/${stem}.csv" ]; then

    source_name="${stem}.csv"

  else

    echo "[$count/$total] [错误] 源文件缺失: $input_dir/${pure_stem}.csv"

    continue

  fi



  echo "[$count/$total] 处理: $source_name"



  # =======================================================

  # 核心修复: 命令写在一行，彻底杜绝换行符报错

  # =======================================================

  cmd=(timeout 1200s "${engine_wrapper_cmd[@]}" --engine node)
  cmd+=(--input "$input_dir")
  cmd+=(--output "$target_dir")
  cmd+=(--backend "$BACKEND")
  cmd+=(--weather "$WEATHER")
  if [ -n "${CANOPY}" ]; then
      cmd+=(--canopy "$CANOPY")
  fi
  cmd+=(--concurrency "$CONC")
  cmd+=(--buckets-file "$bf")
  cmd+=(--target-file "$source_name")

  "${cmd[@]}"



  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then

    echo "  [成功] 删除任务 $stem"

    rm "$bf"

  elif [ $EXIT_CODE -eq 124 ]; then

    echo "  [超时] $stem"

  else

    echo "  [失败] Code: $EXIT_CODE"

  fi

done
