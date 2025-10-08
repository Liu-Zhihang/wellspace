#!/bin/bash

# 基于实际TUM数据结构的香港数据下载脚本
# 根据用户提供的目录截图优化

RSYNC_USER="m1782307.rep"
RSYNC_HOST="dataserv.ub.tum.de"
RSYNC_MODULE="m1782307.rep"
DEST_DIR="./data/tum-buildings"

# 并行配置
MAX_PARALLEL=20
RSYNC_OPTS="-avz --progress --timeout=300 --contimeout=60"

echo "🇭🇰 TUM香港数据下载器 (基于实际数据结构)"
echo "========================================="
echo ""

# 设置密码
export RSYNC_PASSWORD="m1782307.rep"

echo "📍 香港坐标范围: 113.8°E-114.5°E, 22.1°N-22.6°N"
echo "🎯 基于5°×5°瓦片系统，香港应在以下瓦片中:"
echo "   - e110_n25_e115_n20 (主要瓦片: 110-115°E, 20-25°N)"
echo "   - e115_n25_e120_n20 (东侧瓦片: 115-120°E, 20-25°N)"
echo ""

# 基于全球索引分析，确认的香港数据瓦片
HK_CANDIDATE_TILES=(
    "e110_n25_e115_n20"  # 主要瓦片: 7,667,766 建筑物 (包含香港)
    "e115_n25_e120_n20"  # 东侧瓦片: 2,351,272 建筑物 (香港东部)
    "e105_n25_e110_n20"  # 西侧瓦片: 21,444,609 建筑物 (广州深圳区域)
)

echo "🔍 第一步: 检查数据可用性..."

# 创建目录
mkdir -p "${DEST_DIR}/hongkong"/{LoD1,Height}

# 检查和下载函数
check_and_download() {
    local tile="$1"
    local data_type="$2"  # "lod1" 或 "height"
    
    if [[ "$data_type" == "lod1" ]]; then
        # 基于索引文件，检查确认的LoD1路径
        local paths=(
            "LoD1/asiaeast/${tile}.geojson"  # 确认存在于索引中
            "LoD1/asiawest/${tile}.geojson"  # 西侧瓦片可能在asiawest
            "${tile}.geojson"                # 可能直接在根目录
            "LoD1/${tile}.geojson"          # 可能直接在LoD1目录
        )
        local dest_dir="${DEST_DIR}/hongkong/LoD1"
    else
        # 检查高度数据路径 (zip格式)
        local paths=(
            "Height/asiaeast/${tile}.zip"
            "Height/asia/${tile}.zip"
            "Height/${tile}.zip"
        )
        local dest_dir="${DEST_DIR}/hongkong/Height"
    fi
    
    mkdir -p "$dest_dir"
    
    for path in "${paths[@]}"; do
        echo "🔍 [$$] 检查: $path"
        
        if timeout 30 rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/$path" &>/dev/null; then
            echo "✅ [$$] 找到数据: $path"
            
            # 下载数据
            echo "📥 [$$] 下载: $path"
            if rsync ${RSYNC_OPTS} \
                "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/$path" \
                "$dest_dir/"; then
                
                local filename=$(basename "$path")
                local downloaded_file="$dest_dir/$filename"
                
                if [[ -f "$downloaded_file" ]]; then
                    local file_size=$(ls -lh "$downloaded_file" | awk '{print $5}')
                    echo "✅ [$$] 下载成功: $filename ($file_size)"
                    
                    # 如果是建筑数据，分析建筑数量
                    if [[ "$filename" == *.geojson ]]; then
                        local building_count=$(grep -o '"type":"Feature"' "$downloaded_file" | wc -l 2>/dev/null || echo "0")
                        echo "   📊 建筑物数量: ~$building_count"
                    fi
                    
                    # 如果是zip文件，显示压缩信息
                    if [[ "$filename" == *.zip ]]; then
                        if command -v unzip &> /dev/null; then
                            local zip_files=$(unzip -l "$downloaded_file" 2>/dev/null | grep -c '\.tif\|\.png' || echo "未知")
                            echo "   📦 压缩包内文件数: $zip_files"
                        fi
                    fi
                    
                    echo "${tile}:${data_type}:SUCCESS:$path" >> "/tmp/hk_download_log.txt"
                    return 0
                fi
            else
                echo "❌ [$$] 下载失败: $path"
            fi
        else
            echo "❌ [$$] 不存在: $path"
        fi
    done
    
    echo "${tile}:${data_type}:FAILED" >> "/tmp/hk_download_log.txt"
    return 1
}

# 导出函数
export -f check_and_download
export RSYNC_USER RSYNC_HOST RSYNC_MODULE DEST_DIR RSYNC_OPTS RSYNC_PASSWORD

# 清理日志
rm -f /tmp/hk_download_log.txt

echo "🚀 开始并行下载..."

# 创建下载任务列表
download_tasks=()
for tile in "${HK_CANDIDATE_TILES[@]}"; do
    download_tasks+=("$tile lod1")
    download_tasks+=("$tile height")
done

# 并行执行下载
printf '%s\n' "${download_tasks[@]}" | \
    xargs -n 2 -P ${MAX_PARALLEL} -I {} bash -c 'check_and_download "$@"' _ {}

# 等待完成
wait

# 清理密码
unset RSYNC_PASSWORD

echo ""
echo "🎯 下载完成！"

# 统计结果
if [[ -f "/tmp/hk_download_log.txt" ]]; then
    echo ""
    echo "📊 下载统计:"
    
    local lod1_success=$(grep ":lod1:SUCCESS:" /tmp/hk_download_log.txt | wc -l)
    local lod1_failed=$(grep ":lod1:FAILED" /tmp/hk_download_log.txt | wc -l)
    local height_success=$(grep ":height:SUCCESS:" /tmp/hk_download_log.txt | wc -l)
    local height_failed=$(grep ":height:FAILED" /tmp/hk_download_log.txt | wc -l)
    
    echo "   LoD1建筑数据: ${lod1_success} 成功, ${lod1_failed} 失败"
    echo "   高度数据: ${height_success} 成功, ${height_failed} 失败"
    
    if [[ $lod1_success -gt 0 ]] || [[ $height_success -gt 0 ]]; then
        echo ""
        echo "✅ 成功下载的数据:"
        grep ":SUCCESS:" /tmp/hk_download_log.txt | while IFS=':' read -r tile type status path; do
            echo "   ${tile} (${type}): $(basename "$path")"
        done
    fi
fi

echo ""
if [[ -d "${DEST_DIR}/hongkong" ]]; then
    echo "📁 数据位置: ${DEST_DIR}/hongkong/"
    
    local lod1_files=$(find "${DEST_DIR}/hongkong/LoD1" -name "*.geojson" | wc -l)
    local height_files=$(find "${DEST_DIR}/hongkong/Height" -name "*.zip" | wc -l)
    local total_size=$(du -sh "${DEST_DIR}/hongkong" 2>/dev/null | cut -f1)
    
    echo "📊 最终统计:"
    echo "   建筑数据文件: ${lod1_files}"
    echo "   高度数据文件: ${height_files}"
    echo "   总大小: ${total_size}"
    
    if [[ $lod1_files -gt 0 ]]; then
        echo ""
        echo "🏢 建筑数据文件:"
        find "${DEST_DIR}/hongkong/LoD1" -name "*.geojson" -exec ls -lh {} \;
    fi
    
    if [[ $height_files -gt 0 ]]; then
        echo ""
        echo "📏 高度数据文件:"
        find "${DEST_DIR}/hongkong/Height" -name "*.zip" -exec ls -lh {} \;
    fi
else
    echo "⚠️ 未找到香港数据"
    echo ""
    echo "💡 可能的原因:"
    echo "1. 香港数据在其他瓦片中"
    echo "2. 数据路径结构不同"
    echo "3. 需要检查其他区域目录"
fi

# 清理临时文件
rm -f /tmp/hk_download_log.txt

echo ""
echo "🔧 下一步建议:"
echo "1. 如果找到数据，更新本地TUM服务配置"
echo "2. 如果未找到，运行 verify-hongkong-data.sh 进行详细分析"
echo "3. 考虑下载全球索引文件进行精确定位"
