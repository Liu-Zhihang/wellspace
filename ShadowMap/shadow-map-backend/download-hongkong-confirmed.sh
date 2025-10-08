#!/bin/bash

# 基于验证结果的香港数据精确下载脚本 (并行优化版)
# 已确认数据存在于全球索引中

RSYNC_USER="m1782307"
RSYNC_HOST="dataserv.ub.tum.de"
RSYNC_MODULE="m1782307"
DEST_DIR="./data/tum-buildings"

# 并行配置
MAX_PARALLEL=6  # 3个瓦片 × 2种数据类型 = 6个并行任务
RSYNC_OPTS="-avz --progress --timeout=300 --contimeout=60"

echo "🇭🇰 TUM香港数据精确下载器 (并行优化版)"
echo "======================================="
echo "🔧 并行进程数: ${MAX_PARALLEL}"
echo "📊 基于全球索引验证结果"
echo ""

# 设置密码
export RSYNC_PASSWORD="m1782307"

# 已确认的香港相关数据瓦片 (从索引文件获得)
declare -A HK_TILES
HK_TILES["e110_n25_e115_n20"]="asiaeast:7667766"  # 主要香港瓦片
HK_TILES["e115_n25_e120_n20"]="asiaeast:2351272"  # 东侧瓦片  
HK_TILES["e105_n25_e110_n20"]="asiawest:21444609" # 西侧瓦片(广深)

echo "📊 已确认的数据瓦片:"
for tile in "${!HK_TILES[@]}"; do
    IFS=':' read -r region buildings <<< "${HK_TILES[$tile]}"
    echo "   ${tile}: ${buildings} 建筑物 (${region})"
done
echo ""

# 创建目录
mkdir -p "${DEST_DIR}/hongkong"/{LoD1,Height}

echo "🚀 开始下载确认的数据..."

# 并行下载单个数据文件的函数
download_single_file() {
    local tile="$1"
    local region="$2"
    local building_count="$3"
    local data_type="$4"  # "lod1" 或 "height"
    
    if [[ "$data_type" == "lod1" ]]; then
        # 基于索引文件路径，去掉开头的 "./"
        local remote_path="LoD1/${region}/${tile}.geojson"
        local dest_dir="${DEST_DIR}/hongkong/LoD1"
        local local_file="${dest_dir}/${tile}.geojson"
    else
        # 高度数据可能在不同的结构中
        local remote_path="Height/${region}/${tile}.zip"
        local dest_dir="${DEST_DIR}/hongkong/Height"
        local local_file="${dest_dir}/${tile}.zip"
    fi
    
    mkdir -p "$dest_dir"
    
    echo "📥 [$$] 开始下载: ${tile} ${data_type} (${region})"
    
    if rsync ${RSYNC_OPTS} \
        "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/${remote_path}" \
        "${dest_dir}/"; then
        
        if [[ -f "$local_file" ]]; then
            local file_size=$(ls -lh "$local_file" | awk '{print $5}')
            echo "✅ [$$] 下载成功: ${tile} ${data_type} (${file_size})"
            
            # 记录下载结果
            echo "${tile}:${data_type}:SUCCESS:${file_size}" >> "/tmp/hk_confirmed_download.log"
            
            # 额外分析
            if [[ "$data_type" == "lod1" ]]; then
                local actual_count=$(grep -o '"type":"Feature"' "$local_file" | wc -l 2>/dev/null || echo "0")
                echo "   📊 [$$] 建筑数量: ${actual_count} (预期: ${building_count})"
                echo "${tile}:buildings:${actual_count}" >> "/tmp/hk_confirmed_download.log"
            elif [[ "$data_type" == "height" ]] && command -v unzip &> /dev/null; then
                local zip_files=$(unzip -l "$local_file" 2>/dev/null | grep -c '\.(tif|png)$' || echo "0")
                echo "   📦 [$$] 压缩包文件数: ${zip_files}"
                echo "${tile}:height_files:${zip_files}" >> "/tmp/hk_confirmed_download.log"
            fi
        else
            echo "❌ [$$] 文件未生成: ${tile} ${data_type}"
            echo "${tile}:${data_type}:FILE_MISSING" >> "/tmp/hk_confirmed_download.log"
        fi
    else
        echo "❌ [$$] 下载失败: ${tile} ${data_type}"
        echo "${tile}:${data_type}:FAILED" >> "/tmp/hk_confirmed_download.log"
    fi
}

# 导出函数供子进程使用
export -f download_single_file
export RSYNC_USER RSYNC_HOST RSYNC_MODULE DEST_DIR RSYNC_OPTS RSYNC_PASSWORD

# 清理日志文件
rm -f /tmp/hk_confirmed_download.log

# 创建并行下载任务列表
download_tasks=()
for tile in "${!HK_TILES[@]}"; do
    IFS=':' read -r region buildings <<< "${HK_TILES[$tile]}"
    
    # 为每个瓦片创建两个任务：建筑数据和高度数据
    download_tasks+=("$tile $region $buildings lod1")
    download_tasks+=("$tile $region $buildings height")
done

echo "📋 创建的下载任务:"
for task in "${download_tasks[@]}"; do
    echo "   $task"
done
echo ""

echo "🚀 开始并行下载 (${MAX_PARALLEL} 个并行进程)..."

# 并行执行所有下载任务
printf '%s\n' "${download_tasks[@]}" | \
    xargs -n 4 -P ${MAX_PARALLEL} -I {} bash -c 'download_single_file "$@"' _ {}

# 等待所有并行任务完成
wait

# 清理
unset RSYNC_PASSWORD

echo ""
echo "🎯 并行下载完成！"

# 基于日志文件的详细统计
if [[ -f "/tmp/hk_confirmed_download.log" ]]; then
    echo ""
    echo "📊 下载统计 (基于并行日志):"
    
    lod1_success=$(grep ":lod1:SUCCESS:" /tmp/hk_confirmed_download.log | wc -l)
    height_success=$(grep ":height:SUCCESS:" /tmp/hk_confirmed_download.log | wc -l)
    lod1_failed=$(grep ":lod1:FAILED\|:lod1:FILE_MISSING" /tmp/hk_confirmed_download.log | wc -l)
    height_failed=$(grep ":height:FAILED\|:height:FILE_MISSING" /tmp/hk_confirmed_download.log | wc -l)
    
    echo "   建筑数据: ${lod1_success} 成功, ${lod1_failed} 失败"
    echo "   高度数据: ${height_success} 成功, ${height_failed} 失败"
    
    if [[ $lod1_success -gt 0 ]] || [[ $height_success -gt 0 ]]; then
        echo ""
        echo "✅ 成功下载的文件:"
        
        # 显示建筑数据详情
        if [[ $lod1_success -gt 0 ]]; then
            echo "🏢 建筑数据:"
            grep ":lod1:SUCCESS:" /tmp/hk_confirmed_download.log | while IFS=':' read -r tile type status size; do
                building_count=$(grep "^${tile}:buildings:" /tmp/hk_confirmed_download.log | cut -d':' -f3)
                echo "   ${tile}.geojson: ${size}, ${building_count:-未知} 建筑物"
            done
        fi
        
        # 显示高度数据详情  
        if [[ $height_success -gt 0 ]]; then
            echo "📏 高度数据:"
            grep ":height:SUCCESS:" /tmp/hk_confirmed_download.log | while IFS=':' read -r tile type status size; do
                file_count=$(grep "^${tile}:height_files:" /tmp/hk_confirmed_download.log | cut -d':' -f3)
                echo "   ${tile}.zip: ${size}, ${file_count:-未知} 个内部文件"
            done
        fi
    fi
    
    if [[ $lod1_failed -gt 0 ]] || [[ $height_failed -gt 0 ]]; then
        echo ""
        echo "❌ 失败的下载:"
        grep ":FAILED\|:FILE_MISSING" /tmp/hk_confirmed_download.log | while IFS=':' read -r tile type status; do
            echo "   ${tile} ${type}: ${status}"
        done
    fi
fi

# 文件系统统计
if [[ -d "${DEST_DIR}/hongkong" ]]; then
    echo ""
    echo "📁 数据位置: ${DEST_DIR}/hongkong/"
    
    lod1_files=$(find "${DEST_DIR}/hongkong/LoD1" -name "*.geojson" | wc -l)
    height_files=$(find "${DEST_DIR}/hongkong/Height" -name "*.zip" | wc -l)
    total_size=$(du -sh "${DEST_DIR}/hongkong" 2>/dev/null | cut -f1)
    
    echo "📈 最终统计:"
    echo "   实际文件数: ${lod1_files} 建筑数据, ${height_files} 高度数据"
    echo "   总大小: ${total_size}"
    
    echo ""
    echo "💡 下一步:"
    echo "1. 更新本地TUM数据服务配置"
    echo "2. 在React应用中测试香港阴影计算"
    echo "3. 如需解压高度数据: unzip ${DEST_DIR}/hongkong/Height/*.zip"
else
    echo "⚠️ 下载目录不存在，可能所有下载都失败了"
fi

# 清理临时日志
rm -f /tmp/hk_confirmed_download.log

echo ""
echo "🚀 并行下载完成！利用了最多 ${MAX_PARALLEL} 个并行连接"
