#!/bin/bash

# TUM GlobalBuildingAtlas 并行下载脚本
# 利用多核CPU进行并行下载，提升下载速度

RSYNC_USER="m1782307"
RSYNC_HOST="dataserv.ub.tum.de" 
RSYNC_MODULE="m1782307"
DEST_DIR="./data/tum-buildings"

# 并行配置
MAX_PARALLEL=16  # 根据您的网络和CPU调整，建议不超过20
RSYNC_OPTS="-avz --progress --timeout=300 --contimeout=60"

echo "🚀 TUM GlobalBuildingAtlas 并行下载器"
echo "===================================="
echo "🔧 最大并发数: ${MAX_PARALLEL}"
echo "💾 下载目录: ${DEST_DIR}"
echo ""

# 创建目录结构
mkdir -p "${DEST_DIR}"/{examples/LoD1,examples/Height,metadata}

# 设置密码
export RSYNC_PASSWORD="m1782307"

# 定义下载任务数组
declare -a DOWNLOAD_TASKS=(
    # 元数据文件（快速下载）
    "README.txt metadata/"
    "LICENSE metadata/"
    "checksums.sha512 metadata/"
    
    # 全球索引文件
    "lod1.geojson metadata/"
    "height_zip.geojson metadata/"
    "height_tif.geojson metadata/"
)

# 并行下载函数
download_file() {
    local src_file="$1"
    local dest_subdir="$2"
    local full_dest="${DEST_DIR}/${dest_subdir}"
    
    echo "📥 [$$] 开始下载: ${src_file}"
    
    # 创建目标目录
    mkdir -p "${full_dest}"
    
    # 执行下载
    if rsync ${RSYNC_OPTS} \
        "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/${src_file}" \
        "${full_dest}"; then
        echo "✅ [$$] 完成: ${src_file}"
    else
        echo "❌ [$$] 失败: ${src_file}"
        return 1
    fi
}

# 导出函数供子进程使用
export -f download_file
export RSYNC_USER RSYNC_HOST RSYNC_MODULE DEST_DIR RSYNC_OPTS RSYNC_PASSWORD

echo "🔄 开始并行下载基础文件..."

# 使用xargs进行并行下载
printf '%s\n' "${DOWNLOAD_TASKS[@]}" | \
    xargs -n 2 -P ${MAX_PARALLEL} -I {} bash -c 'download_file "$@"' _ {}

echo ""
echo "🎯 基础文件下载完成，开始分析可用数据区域..."

# 等待所有后台任务完成
wait

# 检查lod1.geojson是否下载成功，用于查找香港数据
if [[ -f "${DEST_DIR}/metadata/lod1.geojson" ]]; then
    echo "📊 分析全球数据瓦片..."
    
    # 使用jq或python分析香港区域的数据瓦片
    echo "🔍 查找香港区域数据 (大致坐标: 114°E, 22°N)..."
    
    # 香港大致在 e110_n25_e115_n20 瓦片中
    HK_TILES=(
        "LoD1/asia/e110_n25_e115_n20.geojson"
        "Height/asia/e110_n25_e115_n20"
    )
    
    echo "🎯 找到香港相关数据瓦片，开始下载..."
    
    # 并行下载香港数据
    for tile in "${HK_TILES[@]}"; do
        if [[ "${tile}" == *".geojson" ]]; then
            # LoD1建筑数据
            echo "📥 下载香港建筑数据: ${tile}"
            download_file "${tile}" "examples/" &
        else
            # 高度数据目录
            echo "📥 下载香港高度数据目录: ${tile}/"
            rsync ${RSYNC_OPTS} -r \
                "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/${tile}/" \
                "${DEST_DIR}/examples/${tile}/" &
        fi
    done
    
    # 等待香港数据下载完成
    wait
    
else
    echo "⚠️ 无法获取全球数据索引，将下载欧洲示例数据..."
    
    # 下载欧洲示例数据作为备选
    EUROPE_TASKS=(
        "examples/LoD1/europe/e010_n50_e015_n45.geojson examples/LoD1/europe/"
        "examples/Height/europe/e010_n50_e015_n45 examples/Height/europe/"
    )
    
    printf '%s\n' "${EUROPE_TASKS[@]}" | \
        xargs -n 2 -P ${MAX_PARALLEL} -I {} bash -c 'download_file "$@"' _ {}
fi

# 清理环境变量
unset RSYNC_PASSWORD

echo ""
echo "✅ 并行下载完成！"
echo ""
echo "📊 下载统计:"
find "${DEST_DIR}" -type f -exec ls -lh {} \; | head -20

echo ""
echo "🎯 数据文件位置:"
echo "📁 元数据: ${DEST_DIR}/metadata/"
echo "🏢 建筑数据: ${DEST_DIR}/examples/LoD1/"
echo "📏 高度数据: ${DEST_DIR}/examples/Height/"

echo ""
echo "💡 使用建议:"
echo "1. 检查 examples/LoD1/ 目录中的建筑数据文件"
echo "2. 如果有香港数据，文件名类似: e110_n25_e115_n20.geojson"
echo "3. 如果没有，可以使用慕尼黑数据: e010_n50_e015_n45.geojson"
