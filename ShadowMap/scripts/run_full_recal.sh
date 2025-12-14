#!/bin/bash
# === 服务器 B 全量重算脚本 (无视错误行，直接覆盖) ===
# 适合：112核服务器，暴力重算整个文件

# === 配置区 ===
# 任务清单目录 (刚才 scp 回来的地方)
BUCKET_DIR="${BUCKET_DIR:-/tmp/buckets_part1_migrated}"

# 结果移走/备份目录 (防止重算失败把旧的覆盖了，先移走旧的)
BACKUP_DIR="${BACKUP_DIR:-/media/liuzhihang/repo/projects/wellspace/GLAN_processed_backup}"

# 输入/输出
INPUT_ROOT="${INPUT_ROOT:-/media/liuzhihang/repo/projects/wellspace/GLAN/PHASE1/spatial_temporal_merge}"
OUTPUT_ROOT="${OUTPUT_ROOT:-/media/liuzhihang/repo/projects/wellspace/GLAN_processed}"
LOG_FILE="${LOG_FILE:-./full_recalc.log}"

# ⚡️ 性能配置 (根据你 112 核调整) ⚡️
# By default, run the pure Python engine (local compute) with a higher worker count.
CONCURRENCY="${CONCURRENCY:-64}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-2400}"
PROGRESS_INTERVAL_S="${PROGRESS_INTERVAL_S:-10}"
PROGRESS_STYLE="${PROGRESS_STYLE:-single}" # log|single
BUILDINGS_PATH="${BUILDINGS_PATH:-${BUILDING_LOCAL_GEOJSON:-/media/liuzhihang/repo/projects/wellspace/buildings/hong_kong_cleaned.gpkg}}"
BUILDINGS_LAYER="${BUILDINGS_LAYER:-${BUILDING_GPKG_LAYER:-}}"
CANOPY_PATH="${CANOPY_PATH:-${SHADOW_ENGINE_CANOPY_RASTER_PATH:-/media/liuzhihang/repo/projects/wellspace/Tree/HKtree_small.tif}}"
ERA5_TEMPLATE_PATH="${ERA5_TEMPLATE_PATH:-${ERA5_FILE_TEMPLATE:-}}"
BUILDINGS_MODE="${BUILDINGS_MODE:-preload}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_WRAPPER="${ENGINE_WRAPPER:-${SCRIPT_DIR}/batch-mobility-shadow.sh}"

mkdir -p "$BACKUP_DIR"
touch "$LOG_FILE"

if [ ! -f "$BUILDINGS_PATH" ]; then
    echo "[Fatal] Buildings file not found: $BUILDINGS_PATH" | tee -a "$LOG_FILE"
    exit 1
fi
if [ ! -x "$ENGINE_WRAPPER" ]; then
    echo "[Fatal] Engine wrapper not executable: $ENGINE_WRAPPER" | tee -a "$LOG_FILE"
    exit 1
fi

# 读取任务列表
mapfile -t files < <(ls "$BUCKET_DIR"/*_retry.txt 2>/dev/null)
total=${#files[@]}
count=0

echo "=== 🚀 Full recompute (Python): ${total} files (workers=${CONCURRENCY}, timeout=${TIMEOUT_SECONDS}s) ==="
echo "=== Info: FILE-level recompute; *_retry.txt is treated as a file list (bucket contents ignored) ==="

for bf in "${files[@]}"; do
    count=$((count+1))
    
    stem=$(basename "$bf" "_retry.txt") # 得到 1069-sunlight
    pure_stem=${stem%-sunlight}         # 得到 1069
    
    # 1. 找源文件
    mapfile -t matches < <(find "$INPUT_ROOT" -name "${pure_stem}.csv" -print)
    if [ "${#matches[@]}" -eq 0 ]; then
        echo "[$count/$total] ❌ 找不到源文件 $pure_stem" >> "$LOG_FILE"
        continue
    fi
    if [ "${#matches[@]}" -gt 1 ]; then
        echo "[$count/$total] [Warn] Multiple inputs matched ${pure_stem}.csv; picking the first after sort:" >> "$LOG_FILE"
        printf '  - %s\n' "${matches[@]}" >> "$LOG_FILE"
        mapfile -t matches < <(printf '%s\n' "${matches[@]}" | sort)
    fi
    input_csv="${matches[0]}"
    
    # 2. 准备输出路径
    rel_path=${input_csv#$INPUT_ROOT}
    target_dir=$(dirname "$OUTPUT_ROOT$rel_path")
    mkdir -p "$target_dir"
    
    target_file="$target_dir/${pure_stem}.csv"
    # 有些输出可能是带 -sunlight 的，检查一下
    if [ -f "$target_dir/${stem}.csv" ]; then target_file="$target_dir/${stem}.csv"; fi

    echo "------------------------------------------------------"
    echo "🔄 [$count/$total] 重算: $pure_stem (旧结果将移至备份)"

    # === 3. 关键动作：移走旧结果，强制重算 ===
    # 如果目标文件存在，把它移到备份目录，确保本次计算从头开始
    if [ -f "$target_file" ]; then
        backup_path="$BACKUP_DIR/$(basename "$target_file")_$(date +%s)"
        mv "$target_file" "$backup_path"
        echo "   -> 旧文件已备份"
    fi

    # 4. Execute pure Python pipeline (no backend required)
    # Note: no --buckets-file => process the whole CSV.
    cmd=(timeout "${TIMEOUT_SECONDS}s" "$ENGINE_WRAPPER" --engine python)
    cmd+=(--input "$(dirname "$input_csv")")
    cmd+=(--output "$target_dir")
    cmd+=(--buildings "$BUILDINGS_PATH")
    if [ -n "$BUILDINGS_LAYER" ]; then
        cmd+=(--buildings-layer "$BUILDINGS_LAYER")
    fi
    cmd+=(--buildings-mode "$BUILDINGS_MODE")
    if [ -n "$CANOPY_PATH" ]; then
        cmd+=(--canopy "$CANOPY_PATH")
    fi
    if [ -n "$ERA5_TEMPLATE_PATH" ]; then
        cmd+=(--era5-template "$ERA5_TEMPLATE_PATH")
    fi
    cmd+=(--concurrency "$CONCURRENCY")
    cmd+=(--progress-interval "$PROGRESS_INTERVAL_S")
    cmd+=(--progress-style "$PROGRESS_STYLE")
    cmd+=(--force)
    cmd+=(--target-file "$(basename "$input_csv")")

    "${cmd[@]}" 2>>"$LOG_FILE"

    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        # 成功：删除任务单
        rm "$bf"
        echo "✅ [完成] $pure_stem 全量重算成功"
    else
        echo "❌ [失败] $pure_stem (Code: $EXIT_CODE)"
        echo "$pure_stem" >> "$LOG_FILE"
    fi
done

echo "=== 所有重算任务结束 ==="
