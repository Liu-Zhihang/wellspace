#!/bin/bash

# ================= 配置区 =================
# 远程工作站 A 的配置
REMOTE_HOST="${REMOTE_HOST:-campus}"                 # ssh config 中的名字
REMOTE_USER="${REMOTE_USER:-jinlin}"
REMOTE_BUCKET_DIR="${REMOTE_BUCKET_DIR:-}"
REMOTE_OUTPUT_ROOT="${REMOTE_OUTPUT_ROOT:-}"
REMOTE_INPUT_ROOT="${REMOTE_INPUT_ROOT:-}"

# 本地服务器 B 的配置
# Prefer BUCKET_DIR/SHADOWMAP_TASK_ROOT; fall back to a persistent per-user directory.
DEFAULT_TASK_ROOT="${SHADOWMAP_TASK_ROOT:-${HOME}/.local/share/shadowmap/tasks}"
LOCAL_BUCKET_DIR="${LOCAL_BUCKET_DIR:-${BUCKET_DIR:-${DEFAULT_TASK_ROOT}/buckets_part1_migrated}}"
# Prefer INPUT_ROOT as the local GLAN root.
LOCAL_INPUT_ROOT="${LOCAL_INPUT_ROOT:-${INPUT_ROOT:-}}"
# ===========================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Optional: load a machine profile to avoid hardcoded paths in scripts.
# Priority:
# 1) $SHADOWMAP_ENV_FILE (explicit)
# 2) ShadowMap/.shadowmap.env (local, gitignored)
if [ -n "${SHADOWMAP_ENV_FILE:-}" ] && [ -f "${SHADOWMAP_ENV_FILE}" ]; then
    # shellcheck disable=SC1090
    source "${SHADOWMAP_ENV_FILE}"
elif [ -f "${REPO_ROOT}/.shadowmap.env" ]; then
    # shellcheck disable=SC1091
    source "${REPO_ROOT}/.shadowmap.env"
fi

DEFAULT_TASK_ROOT="${SHADOWMAP_TASK_ROOT:-${HOME}/.local/share/shadowmap/tasks}"
LOCAL_BUCKET_DIR="${LOCAL_BUCKET_DIR:-${BUCKET_DIR:-${DEFAULT_TASK_ROOT}/buckets_part1_migrated}}"
LOCAL_INPUT_ROOT="${LOCAL_INPUT_ROOT:-${INPUT_ROOT:-}}"

if [ -z "${REMOTE_INPUT_ROOT}" ]; then
    echo "[Fatal] Missing REMOTE_INPUT_ROOT (workstation A GLAN root)."
    exit 1
fi
if [ -z "${LOCAL_INPUT_ROOT}" ]; then
    echo "[Fatal] Missing LOCAL_INPUT_ROOT/INPUT_ROOT (server B GLAN root)."
    exit 1
fi

# 检查目录是否存在
mkdir -p "$LOCAL_BUCKET_DIR"
mkdir -p "$LOCAL_INPUT_ROOT"

if [ -z "${REMOTE_BUCKET_DIR}" ]; then
    # Prefer a persistent task dir on the remote host; fall back to /tmp for backward compatibility.
    remote_candidates=()
    if [ -n "${REMOTE_OUTPUT_ROOT}" ]; then
        remote_candidates+=("${REMOTE_OUTPUT_ROOT}/_shadowmap_tasks/buckets_part1")
        remote_candidates+=("${REMOTE_OUTPUT_ROOT}/_shadowmap_tasks/buckets_part1_migrated")
    fi
    remote_candidates+=("~/.local/share/shadowmap/tasks/buckets_part1")
    remote_candidates+=("/tmp/buckets_part1")

    for cand in "${remote_candidates[@]}"; do
        if ssh "${REMOTE_HOST}" "ls ${cand}/*_retry.txt >/dev/null 2>&1"; then
            REMOTE_BUCKET_DIR="${cand}"
            break
        fi
    done
fi

if [ -z "${REMOTE_BUCKET_DIR}" ]; then
    echo "[Fatal] Missing REMOTE_BUCKET_DIR and no retry dir auto-detected on remote host."
    echo "        Set REMOTE_BUCKET_DIR explicitly, or set REMOTE_OUTPUT_ROOT to enable detection."
    exit 1
fi

echo "=== 1.正在从工作站 A (campus) 获取任务列表... ==="

# 远程获取任务列表 (这里不需要 -n，因为不在 while 循环里)
tmp_all="$(mktemp -t shadowmap_remote_tasks.XXXXXX.txt)"
tmp_half="$(mktemp -t shadowmap_tasks_to_migrate.XXXXXX.txt)"
cleanup_tmp() {
    rm -f "$tmp_all" "$tmp_half" || true
}
trap cleanup_tmp EXIT

ssh $REMOTE_HOST "ls $REMOTE_BUCKET_DIR/*_retry.txt" 2>/dev/null > "$tmp_all"

total_lines=$(wc -l < "$tmp_all")
if [ "$total_lines" -eq 0 ]; then
    echo "工作站 A 上没有剩余任务了！"
    exit 0
fi

# 计算一半的数量 (例如 100 个任务，取前 50 个)
half_lines=$((total_lines / 2))
# 如果只有一个任务，至少取1个
if [ "$half_lines" -eq 0 ]; then half_lines=1; fi

head -n "$half_lines" "$tmp_all" > "$tmp_half"

echo "工作站 A 共有 $total_lines 个任务，准备抢过来 $half_lines 个..."

# === 2. 循环处理 ===
success_count=0

while read remote_bucket_path; do
    filename=$(basename "$remote_bucket_path")
    stem=${filename%_retry.txt}      # e.g., 3080-sunlight
    pure_stem=${stem%-sunlight}      # e.g., 3080

    echo "正在迁移任务: $pure_stem ..."

    # 2.1 寻找源 CSV 文件 (核心逻辑)
    # 【修复 1】加上 -n 参数，防止 ssh 吞掉循环输入
    remote_csv_path=$(ssh -n $REMOTE_HOST "find $REMOTE_INPUT_ROOT -name '${pure_stem}.csv' -print -quit")

    # 如果纯数字名找不到，尝试带后缀的
    if [ -z "$remote_csv_path" ]; then
        # 【修复 2】加上 -n 参数
        remote_csv_path=$(ssh -n $REMOTE_HOST "find $REMOTE_INPUT_ROOT -name '${stem}.csv' -print -quit")
    fi

    if [ -n "$remote_csv_path" ]; then
        # 计算相对路径，例如 /KQ/batch2/4011.csv
        rel_path=${remote_csv_path#$REMOTE_INPUT_ROOT/}
        
        # 建立本地父目录
        local_target_dir="$LOCAL_INPUT_ROOT/$(dirname "$rel_path")"
        mkdir -p "$local_target_dir"
        
        # A. 拉取 CSV 源文件 (rsync 不需要 -n)
        rsync -aq "$REMOTE_HOST:$remote_csv_path" "$local_target_dir/"
        
        # B. 拉取 Bucket 任务文件
        rsync -aq "$REMOTE_HOST:$remote_bucket_path" "$LOCAL_BUCKET_DIR/"

        # C. 【关键】在远程 A 上移除该任务
        # 【修复 3】加上 -n 参数
        ssh -n $REMOTE_HOST "mkdir -p $REMOTE_BUCKET_DIR/migrated && mv $remote_bucket_path $REMOTE_BUCKET_DIR/migrated/"
        
        echo "  [完成] 数据已同步，A上任务已移除: $rel_path"
        success_count=$((success_count + 1))
    else
        echo "  [错误] 无法在 A 上找到源文件 ${pure_stem}.csv，跳过。"
    fi

done < "$tmp_half"

echo "=== 迁移完成！ ==="
echo "成功迁移任务数: $success_count"
echo "新的 Bucket 文件位置: $LOCAL_BUCKET_DIR"
echo "数据文件已放入: $LOCAL_INPUT_ROOT"
