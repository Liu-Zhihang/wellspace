#!/bin/bash
# === 服务器 B 最终极速脚本 (112核专用版) ===
# 特性: 并发50 + 12G内存/线程 + PM2集群联动 + 自动隔离

# === 配置区 ===
BUCKET_DIR="${BUCKET_DIR:-}"
QUARANTINE_DIR="${QUARANTINE_DIR:-}"

# INPUT_ROOT/OUTPUT_ROOT should be provided via env/profile (see ShadowMap/.shadowmap.env.example).
INPUT_ROOT="${INPUT_ROOT:-}"
OUTPUT_ROOT="${OUTPUT_ROOT:-}"

# 日志存当前目录
LOG_FILE="${LOG_FILE:-./migration_problems.log}"

# === 内存设置 (关键) ===
# 你的服务器有 768GB 内存。
# 并发 50 * 12GB = 600GB，预留 168GB 给系统和后端，非常安全且高效。
export NODE_OPTIONS="--max-old-space-size=12288"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENGINE_WRAPPER="${ENGINE_WRAPPER:-${SCRIPT_DIR}/batch-mobility-shadow.sh}"

# Optional: load a machine profile to avoid hardcoded paths in scripts.
# Priority:
# 1) $SHADOWMAP_ENV_FILE (explicit)
# 2) ShadowMap/.shadowmap.env (local, gitignored)
if [ "${SHADOWMAP_ENV_FILE:-}" = "/dev/null" ]; then
    : # explicitly skip loading any profile
elif [ -n "${SHADOWMAP_ENV_FILE:-}" ] && [ -f "${SHADOWMAP_ENV_FILE}" ]; then
    # shellcheck disable=SC1090
    source "${SHADOWMAP_ENV_FILE}"
elif [ -f "${REPO_ROOT}/.shadowmap.env" ]; then
    # shellcheck disable=SC1091
    source "${REPO_ROOT}/.shadowmap.env"
fi

INPUT_ROOT="${INPUT_ROOT:-}"
OUTPUT_ROOT="${OUTPUT_ROOT:-}"
CANOPY_PATH="${CANOPY_PATH:-${SHADOW_ENGINE_CANOPY_RASTER_PATH:-${CANOPY_RASTER_PATH:-}}}"
BACKEND_URL="${BACKEND_URL:-${BACKEND:-http://localhost:3001/api/analysis/shadow}}"
WEATHER_URL="${WEATHER_URL:-${WEATHER:-http://localhost:3001/api/weather/current}}"
CONC="${CONC:-50}"

if [ -z "${INPUT_ROOT}" ]; then
    echo "[Fatal] Missing INPUT_ROOT. Set it in env or source ShadowMap/.shadowmap.env" | tee -a "$LOG_FILE"
    exit 1
fi
if [ -z "${OUTPUT_ROOT}" ]; then
    echo "[Fatal] Missing OUTPUT_ROOT. Set it in env or source ShadowMap/.shadowmap.env" | tee -a "$LOG_FILE"
    exit 1
fi

TASK_ROOT="${SHADOWMAP_TASK_ROOT:-${OUTPUT_ROOT}/_shadowmap_tasks}"
if [ -z "${BUCKET_DIR}" ]; then
    BUCKET_DIR="${TASK_ROOT}/buckets_part1_migrated"
fi
if [ -z "${QUARANTINE_DIR}" ]; then
    QUARANTINE_DIR="${BUCKET_DIR}/quarantine"
fi

# Prepare directories after resolving profile settings.
mkdir -p "$BUCKET_DIR"
mkdir -p "$QUARANTINE_DIR"
touch "$LOG_FILE"

engine_wrapper_cmd=("${ENGINE_WRAPPER}")
if [ ! -x "${ENGINE_WRAPPER}" ]; then
    engine_wrapper_cmd=(bash "${ENGINE_WRAPPER}")
fi

# === 函数: 检查后端健康 (并发极高时，健康检查很重要) ===
wait_for_backend() {
    local fail_count=0
    while true; do
        # 3秒超时，检查后端
        if curl -s --max-time 3 "${WEATHER_URL}" > /dev/null; then
            return 0
        else
            echo "⚠️ [后端拥堵] 等待 2秒..."
            sleep 2
            fail_count=$((fail_count+1))
            
            # 如果连续 10 次没反应 (20秒)，尝试重启后端
            if [ $fail_count -ge 10 ]; then
                echo "🔄 [自动维护] 后端响应过慢，触发 PM2 重载..."
                pm2 reload shadow-backend
                sleep 5
                fail_count=0
            fi
        fi
    done
}

# 读取任务
mapfile -t files < <(ls "$BUCKET_DIR"/*_retry.txt 2>/dev/null)
total=${#files[@]}
count=0

echo "=== 🚀 核动力模式启动: 处理 $total 个任务 (并发=50, 内存=12G) ==="

for bf in "${files[@]}"; do
    count=$((count+1))
    if [ ! -f "$bf" ]; then continue; fi

    # 1. 跑之前测一下后端心跳
    wait_for_backend

    stem=$(basename "$bf" "_retry.txt")
    pure_stem=${stem%-sunlight}
    
    # 找源文件
    input_csv=$(find "$INPUT_ROOT" -name "${pure_stem}.csv" -print -quit)
    
    if [ -z "$input_csv" ]; then
        msg="[$count/$total] ❌ 找不到源文件 $pure_stem -> 移入隔离区"
        echo "$msg"
        echo "$msg" >> "$LOG_FILE"
        mv "$bf" "$QUARANTINE_DIR/"
        continue
    fi
    
    rel_path=${input_csv#$INPUT_ROOT}
    target_dir=$(dirname "$OUTPUT_ROOT$rel_path")
    mkdir -p "$target_dir"

    echo "------------------------------------------------------"
    echo "⚡ [$count/$total] 处理: $pure_stem"

    # 2. 执行计算
    # 使用 $(pwd) 确保找到脚本
    # --concurrency 50: 既然后端有 112 个核，前端并发 50 是很安全的
    cmd=(timeout 1800s "${engine_wrapper_cmd[@]}" --engine node)
    cmd+=(--input "$(dirname "$input_csv")")
    cmd+=(--output "$target_dir")
    cmd+=(--backend "$BACKEND_URL")
    cmd+=(--weather "$WEATHER_URL")
    if [ -n "${CANOPY_PATH}" ]; then
        cmd+=(--canopy "${CANOPY_PATH}")
    fi
    cmd+=(--concurrency "$CONC")
    cmd+=(--buckets-file "$bf")
    cmd+=(--target-file "$(basename "$input_csv")")

    "${cmd[@]}"

    EXIT_CODE=$?

    # 3. 结果处理
    if [ $EXIT_CODE -eq 0 ]; then
        rm "$bf"
        echo "✅ [完成] $pure_stem"
    else
        echo "❌ [失败] $pure_stem (Code: $EXIT_CODE) -> 移入隔离区"
        echo "$pure_stem (Code: $EXIT_CODE)" >> "$LOG_FILE"
        mv "$bf" "$QUARANTINE_DIR/"
        
        # 如果超时(124)，说明后端可能有部分实例死锁，轻轻重启一下
        if [ $EXIT_CODE -eq 124 ]; then
            echo "🔄 [超时重置] 刷新后端集群状态..."
            pm2 reload shadow-backend
            sleep 5
        fi
    fi
done

echo "=== 所有任务处理完毕 ==="
