#!/bin/bash

# TUM GlobalBuildingAtlas 香港数据并行下载脚本
# 香港坐标范围: 113.8°E - 114.5°E, 22.1°N - 22.6°N
# 利用多进程并行下载，最大化利用112核心CPU

RSYNC_USER="m1782307"
RSYNC_HOST="dataserv.ub.tum.de"
RSYNC_MODULE="m1782307"
DEST_DIR="./data/tum-buildings"

# 并行配置 - 针对您的112核心CPU优化
MAX_PARALLEL=50  # 建议值，可根据网络情况调整
RSYNC_OPTS="-avz --progress --timeout=300 --contimeout=60"
CHUNK_SIZE=50    # 高度数据分块大小（文件数）

echo "🇭🇰 TUM GlobalBuildingAtlas 香港数据并行下载器"
echo "=============================================="
echo "🔧 最大并发数: ${MAX_PARALLEL}"
echo "💾 下载目录: ${DEST_DIR}"
echo "📍 目标区域: 香港 (113.8°E-114.5°E, 22.1°N-22.6°N)"
echo ""

# 设置密码
export RSYNC_PASSWORD="m1782307"

# 香港可能的数据瓦片（扩大搜索范围）
declare -a HK_TILES=(
    "e110_n25_e115_n20"  # 主要瓦片
    "e105_n25_e110_n20"  # 西侧相邻
    "e115_n25_e120_n20"  # 东侧相邻
    "e110_n20_e115_n15"  # 南侧相邻
)

# 并行检查函数
check_tile_data() {
    local tile="$1"
    local data_type="$2"  # "LoD1" 或 "Height"
    
    echo "🔍 [$$] 检查 ${data_type} 数据: ${tile}"
    
    if [[ "$data_type" == "LoD1" ]]; then
        local remote_path="LoD1/asia/${tile}.geojson"
    else
        local remote_path="Height/asia/${tile}/"
    fi
    
    if rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/${remote_path}" 2>/dev/null | head -1 | grep -q .; then
        echo "✅ [$$] 找到 ${data_type} 数据: ${tile}"
        echo "${tile}:${data_type}:EXISTS" >> "/tmp/hk_data_check.txt"
    else
        echo "❌ [$$] 未找到 ${data_type} 数据: ${tile}"
        echo "${tile}:${data_type}:NOT_FOUND" >> "/tmp/hk_data_check.txt"
    fi
}

# 并行下载函数
download_building_data() {
    local tile="$1"
    local dest_path="${DEST_DIR}/hongkong/LoD1/"
    
    echo "📥 [$$] 下载建筑数据: ${tile}.geojson"
    mkdir -p "${dest_path}"
    
    if rsync ${RSYNC_OPTS} \
        "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/LoD1/asia/${tile}.geojson" \
        "${dest_path}"; then
        
        # 分析下载的建筑数据
        local file_path="${dest_path}${tile}.geojson"
        if [[ -f "$file_path" ]]; then
            local building_count=$(grep -o '"type":"Feature"' "$file_path" | wc -l)
            local file_size=$(ls -lh "$file_path" | awk '{print $5}')
            echo "✅ [$$] 建筑数据下载成功: ${tile} (${building_count} 建筑物, ${file_size})"
            echo "${tile}:BUILDING:SUCCESS:${building_count}:${file_size}" >> "/tmp/hk_download_results.txt"
        fi
    else
        echo "❌ [$$] 建筑数据下载失败: ${tile}"
        echo "${tile}:BUILDING:FAILED" >> "/tmp/hk_download_results.txt"
    fi
}

# 并行下载高度数据（分块处理）
download_height_data() {
    local tile="$1"
    local dest_path="${DEST_DIR}/hongkong/Height/${tile}/"
    
    echo "📥 [$$] 下载高度数据: ${tile}/"
    mkdir -p "${dest_path}"
    
    # 先获取高度数据文件列表
    local temp_list="/tmp/height_files_${tile}_$$.txt"
    rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/Height/asia/${tile}/" > "${temp_list}" 2>/dev/null
    
    if [[ -s "${temp_list}" ]]; then
        local file_count=$(wc -l < "${temp_list}")
        echo "📊 [$$] 高度数据包含 ${file_count} 个文件: ${tile}"
        
        # 如果文件数量较多，使用并行下载单个文件
        if [[ $file_count -gt $CHUNK_SIZE ]]; then
            echo "🚀 [$$] 使用分块并行下载高度数据: ${tile}"
            
            # 提取文件名并并行下载
            grep -E '\.(tif|png)$' "${temp_list}" | awk '{print $NF}' | \
            xargs -n 1 -P $((MAX_PARALLEL/4)) -I {} bash -c "
                rsync ${RSYNC_OPTS} \
                    'rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/Height/asia/${tile}/{}' \
                    '${dest_path}' && echo '✅ [$$] 高度文件: {}'
            "
        else
            # 文件较少，直接下载整个目录
            rsync ${RSYNC_OPTS} -r \
                "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/Height/asia/${tile}/" \
                "${dest_path}"
        fi
        
        echo "✅ [$$] 高度数据下载完成: ${tile}"
        echo "${tile}:HEIGHT:SUCCESS:${file_count}" >> "/tmp/hk_download_results.txt"
    else
        echo "❌ [$$] 高度数据为空或下载失败: ${tile}"
        echo "${tile}:HEIGHT:FAILED" >> "/tmp/hk_download_results.txt"
    fi
    
    rm -f "${temp_list}"
}

# 导出函数供子进程使用
export -f check_tile_data download_building_data download_height_data
export RSYNC_USER RSYNC_HOST RSYNC_MODULE DEST_DIR RSYNC_OPTS RSYNC_PASSWORD MAX_PARALLEL CHUNK_SIZE

# 清理临时文件
rm -f /tmp/hk_data_check.txt /tmp/hk_download_results.txt

echo "🔄 第一阶段: 并行检查香港数据可用性..."

# 并行检查所有瓦片的建筑和高度数据
for tile in "${HK_TILES[@]}"; do
    check_tile_data "$tile" "LoD1" &
    check_tile_data "$tile" "Height" &
done

# 等待所有检查完成
wait

echo ""
echo "📊 数据检查结果:"
if [[ -f "/tmp/hk_data_check.txt" ]]; then
    cat /tmp/hk_data_check.txt | while IFS=':' read -r tile type status; do
        if [[ "$status" == "EXISTS" ]]; then
            echo "✅ ${tile} - ${type} 数据可用"
        else
            echo "❌ ${tile} - ${type} 数据不可用"
        fi
    done
else
    echo "⚠️ 无法获取数据检查结果"
fi

echo ""
echo "🔄 第二阶段: 并行下载可用的香港数据..."

# 并行下载找到的建筑数据
echo "📥 开始并行下载建筑数据..."
grep ":LoD1:EXISTS" /tmp/hk_data_check.txt 2>/dev/null | cut -d':' -f1 | \
xargs -n 1 -P ${MAX_PARALLEL} -I {} bash -c 'download_building_data "$@"' _ {}

echo ""
echo "📥 开始并行下载高度数据..."

# 询问是否下载高度数据
height_tiles=$(grep ":Height:EXISTS" /tmp/hk_data_check.txt 2>/dev/null | cut -d':' -f1)
if [[ -n "$height_tiles" ]]; then
    echo "发现以下瓦片有高度数据:"
    echo "$height_tiles"
    echo ""
    read -p "是否并行下载高度数据？(可能较大，但并行下载更快) [Y/n]: " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        echo "$height_tiles" | xargs -n 1 -P $((MAX_PARALLEL/2)) -I {} bash -c 'download_height_data "$@"' _ {}
    else
        echo "⏭️ 跳过高度数据下载"
    fi
fi

# 等待所有下载完成
wait

# 清理环境变量
unset RSYNC_PASSWORD

echo ""
echo "🎯 香港数据并行下载完成！"
echo ""

# 统计下载结果
if [[ -f "/tmp/hk_download_results.txt" ]]; then
    echo "📊 下载统计:"
    building_success=$(grep ":BUILDING:SUCCESS:" /tmp/hk_download_results.txt | wc -l)
    building_failed=$(grep ":BUILDING:FAILED" /tmp/hk_download_results.txt | wc -l)
    height_success=$(grep ":HEIGHT:SUCCESS:" /tmp/hk_download_results.txt | wc -l)
    height_failed=$(grep ":HEIGHT:FAILED" /tmp/hk_download_results.txt | wc -l)
    
    echo "   建筑数据: ${building_success} 成功, ${building_failed} 失败"
    echo "   高度数据: ${height_success} 成功, ${height_failed} 失败"
    echo ""
    
    # 显示建筑数据详情
    echo "🏢 建筑数据详情:"
    grep ":BUILDING:SUCCESS:" /tmp/hk_download_results.txt | while IFS=':' read -r tile type status count size; do
        echo "   ${tile}: ${count} 建筑物 (${size})"
    done
fi

echo ""
if [[ -d "${DEST_DIR}/hongkong" ]]; then
    echo "📁 香港数据位置: ${DEST_DIR}/hongkong/"
    echo "📊 下载的文件:"
    find "${DEST_DIR}/hongkong" -type f -exec ls -lh {} \; | head -10
    
    total_files=$(find "${DEST_DIR}/hongkong" -type f | wc -l)
    total_size=$(du -sh "${DEST_DIR}/hongkong" 2>/dev/null | cut -f1)
    echo ""
    echo "📈 总计: ${total_files} 个文件, ${total_size}"
else
    echo "⚠️ 未找到香港数据"
    echo "💡 建议: 检查其他亚洲区域或下载全球索引进行搜索"
fi

# 清理临时文件
rm -f /tmp/hk_data_check.txt /tmp/hk_download_results.txt

echo ""
echo "🚀 多进程下载完成！利用了最多 ${MAX_PARALLEL} 个并行连接"
