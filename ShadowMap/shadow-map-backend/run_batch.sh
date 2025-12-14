#!/bin/bash



# =======================================================

# 批处理配置 (全英文路径版)

# =======================================================

# 强制 UTF-8 环境 (防止其他潜在乱码)

export LANG=C.UTF-8

export LC_ALL=C.UTF-8



# 1. 路径全部改成新的 /repo 链接

BUCKET_DIR="/tmp/buckets_part2"

OUTPUT_ROOT="/media/liuzhihang/repo/projects/wellspace/GLAN_processed"

INPUT_ROOT_BASE="/media/liuzhihang/repo/projects/wellspace/GLAN/PHASE1/spatial_temporal_merge"



# 2. 脚本和数据路径

NODE_SCRIPT="/media/liuzhihang/repo/projects/ShadowMap/wellspace/ShadowMap/scripts/batch-mobility-shadow.mjs"

CANOPY="/media/liuzhihang/repo/projects/wellspace/Tree/HKtree_small.tif"



# 3. 后端配置

BACKEND="http://localhost:3001/api/analysis/shadow"

WEATHER="http://localhost:3001/api/weather/current"

CONC=4



# =======================================================

# 检查部分

# =======================================================

echo "[Check] Backend health:"

curl -s http://localhost:3001/api/health | head -c 200 && echo ""



if [ ! -f "$NODE_SCRIPT" ]; then

    echo "[错误] 找不到脚本: $NODE_SCRIPT"

    echo "请检查第一步的 'repo' 软链接是否创建成功。"

    exit 1

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



echo "=== 开始处理 (共 $total 个任务) 使用路径: /media/liuzhihang/repo ==="



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

  timeout 1200s node "$NODE_SCRIPT" --input "$input_dir" --output "$target_dir" --backend "$BACKEND" --weather "$WEATHER" --canopy "$CANOPY" --concurrency "$CONC" --buckets-file "$bf" --target-file "$source_name"



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
