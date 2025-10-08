#!/bin/bash

# 探索TUM数据的实际目录结构

RSYNC_USER="m1782307"
RSYNC_HOST="dataserv.ub.tum.de"
RSYNC_MODULE="m1782307"

echo "🔍 TUM数据结构探索工具"
echo "======================"
echo ""

# 设置密码
export RSYNC_PASSWORD="m1782307"

echo "📂 探索根目录结构..."
echo "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/"

if rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/" 2>/dev/null; then
    echo ""
    echo "✅ 根目录访问成功"
else
    echo "❌ 根目录访问失败"
    exit 1
fi

echo ""
echo "📂 探索LoD1目录..."

if rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/LoD1/" 2>/dev/null; then
    echo ""
    echo "✅ LoD1目录存在，内容如上"
else
    echo "❌ LoD1目录不存在或无法访问"
fi

echo ""
echo "📂 探索Height目录..."

if rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/Height/" 2>/dev/null | head -20; then
    echo ""
    echo "✅ Height目录存在，显示前20行"
else
    echo "❌ Height目录不存在或无法访问"
fi

# 检查是否有其他可能的结构
echo ""
echo "🔍 检查可能的替代结构..."

POSSIBLE_PATHS=(
    "lod1/"
    "height/"
    "data/"
    "building/"
    "buildings/"
    "asia/"
    "asiaeast/"
    "asiawest/"
)

for path in "${POSSIBLE_PATHS[@]}"; do
    echo "检查: $path"
    if timeout 10 rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/$path" &>/dev/null; then
        echo "✅ $path 存在"
        rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/$path" 2>/dev/null | head -5
    else
        echo "❌ $path 不存在"
    fi
    echo ""
done

# 尝试直接访问已知的文件
echo "🎯 尝试直接访问已知文件..."

KNOWN_FILES=(
    "lod1.geojson"
    "height_tif.geojson"  
    "height_zip.geojson"
    "checksums.sha512"
    "LICENSE"
    "README.txt"
)

for file in "${KNOWN_FILES[@]}"; do
    echo "检查文件: $file"
    if timeout 10 rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/$file" &>/dev/null; then
        echo "✅ $file 存在"
    else
        echo "❌ $file 不存在"
    fi
done

echo ""
echo "🤔 分析总结:"
echo "1. 检查根目录是否包含预期的 LoD1/ 和 Height/ 目录"
echo "2. 如果不存在，可能需要不同的访问方式"
echo "3. 索引文件中的路径可能是相对于不同的基础目录"

# 清理
unset RSYNC_PASSWORD
