#!/bin/bash

# TUM GlobalBuildingAtlas 区域数据并行下载工具
# 支持任意区域的高效并行下载

RSYNC_USER="m1782307"
RSYNC_HOST="dataserv.ub.tum.de"
RSYNC_MODULE="m1782307"
DEST_DIR="./data/tum-buildings"

# 并行配置
MAX_PARALLEL=20
RSYNC_OPTS="-avz --progress --timeout=300 --contimeout=60 --partial"

# 使用说明
show_usage() {
    echo "🌍 TUM GlobalBuildingAtlas 区域并行下载工具"
    echo "============================================"
    echo ""
    echo "用法: $0 [选项] <区域名>"
    echo ""
    echo "支持的区域:"
    echo "  hongkong    - 香港 (113.8°E-114.5°E, 22.1°N-22.6°N)"
    echo "  beijing     - 北京 (115.7°E-117.4°E, 39.4°N-41.6°N)"
    echo "  shanghai    - 上海 (120.9°E-122.0°E, 30.7°N-31.9°N)"
    echo "  guangzhou   - 广州 (112.9°E-113.8°E, 22.7°N-23.6°N)"
    echo "  shenzhen    - 深圳 (113.8°E-114.7°E, 22.4°N-22.8°N)"
    echo "  singapore   - 新加坡 (103.6°E-104.0°E, 1.2°N-1.5°N)"
    echo "  tokyo       - 东京 (139.3°E-140.0°E, 35.5°N-35.8°N)"
    echo "  munich      - 慕尼黑 (11.0°E-12.0°E, 47.9°N-48.3°N)"
    echo "  custom      - 自定义区域（需要指定瓦片名）"
    echo ""
    echo "选项:"
    echo "  -p NUM      设置最大并行数 (默认: ${MAX_PARALLEL})"
    echo "  -d DIR      设置下载目录 (默认: ${DEST_DIR})"
    echo "  -h          显示帮助"
    echo "  --building-only  仅下载建筑数据"
    echo "  --height-only    仅下载高度数据"
    echo ""
    echo "示例:"
    echo "  $0 hongkong                    # 下载香港数据"
    echo "  $0 -p 30 beijing               # 用30个并行进程下载北京数据"
    echo "  $0 --building-only shanghai    # 仅下载上海建筑数据"
}

# 区域配置
declare -A REGION_CONFIG
REGION_CONFIG[hongkong]="e110_n25_e115_n20"
REGION_CONFIG[beijing]="e115_n45_e120_n40"
REGION_CONFIG[shanghai]="e120_n35_e125_n30"
REGION_CONFIG[guangzhou]="e110_n25_e115_n20"
REGION_CONFIG[shenzhen]="e110_n25_e115_n20"
REGION_CONFIG[singapore]="e100_n05_e105_n00"
REGION_CONFIG[tokyo]="e135_n40_e140_n35"
REGION_CONFIG[munich]="e010_n50_e015_n45"

# 解析命令行参数
DOWNLOAD_BUILDING=true
DOWNLOAD_HEIGHT=true
REGION=""

while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--parallel)
            MAX_PARALLEL="$2"
            shift 2
            ;;
        -d|--dest)
            DEST_DIR="$2"
            shift 2
            ;;
        --building-only)
            DOWNLOAD_HEIGHT=false
            shift
            ;;
        --height-only)
            DOWNLOAD_BUILDING=false
            shift
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            if [[ -z "$REGION" ]]; then
                REGION="$1"
            else
                echo "❌ 错误: 未知参数 $1"
                show_usage
                exit 1
            fi
            shift
            ;;
    esac
done

# 检查参数
if [[ -z "$REGION" ]]; then
    echo "❌ 错误: 请指定区域名"
    show_usage
    exit 1
fi

# 获取区域对应的瓦片
if [[ "$REGION" == "custom" ]]; then
    echo "🔧 自定义区域模式"
    read -p "请输入瓦片名 (如: e110_n25_e115_n20): " TILES
    TILES_ARRAY=($TILES)
elif [[ -n "${REGION_CONFIG[$REGION]}" ]]; then
    TILES_ARRAY=(${REGION_CONFIG[$REGION]})
else
    echo "❌ 错误: 不支持的区域 '$REGION'"
    echo "支持的区域: ${!REGION_CONFIG[@]} custom"
    exit 1
fi

echo "🌍 TUM GlobalBuildingAtlas 区域并行下载器"
echo "=========================================="
echo "🎯 目标区域: $REGION"
echo "📦 数据瓦片: ${TILES_ARRAY[@]}"
echo "🔧 并行进程: $MAX_PARALLEL"
echo "💾 下载目录: $DEST_DIR"
echo "🏢 下载建筑: $DOWNLOAD_BUILDING"
echo "📏 下载高度: $DOWNLOAD_HEIGHT"
echo ""

# 设置密码
export RSYNC_PASSWORD="m1782307"

# 并行检查函数
check_and_download() {
    local tile="$1"
    local data_type="$2"
    local region_name="$3"
    
    echo "🔍 [$$] 检查 ${data_type} 数据: ${tile}"
    
    if [[ "$data_type" == "building" ]]; then
        local remote_path="LoD1/asia/${tile}.geojson"
        local local_dir="${DEST_DIR}/${region_name}/LoD1"
        local local_file="${local_dir}/${tile}.geojson"
    else
        local remote_path="Height/asia/${tile}/"
        local local_dir="${DEST_DIR}/${region_name}/Height/${tile}"
    fi
    
    # 检查数据是否存在
    if ! rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/${remote_path}" &>/dev/null; then
        echo "❌ [$$] 未找到 ${data_type} 数据: ${tile}"
        return 1
    fi
    
    echo "✅ [$$] 找到 ${data_type} 数据: ${tile}"
    
    # 创建目录
    mkdir -p "${local_dir}"
    
    # 下载数据
    echo "📥 [$$] 下载 ${data_type} 数据: ${tile}"
    
    if [[ "$data_type" == "building" ]]; then
        # 下载建筑数据
        if rsync ${RSYNC_OPTS} \
            "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/${remote_path}" \
            "${local_dir}/"; then
            
            # 分析建筑数据
            if [[ -f "$local_file" ]]; then
                local count=$(grep -o '"type":"Feature"' "$local_file" | wc -l)
                local size=$(ls -lh "$local_file" | awk '{print $5}')
                echo "✅ [$$] 建筑数据下载成功: ${tile} (${count} 建筑物, ${size})"
            fi
        else
            echo "❌ [$$] 建筑数据下载失败: ${tile}"
            return 1
        fi
    else
        # 下载高度数据
        local file_list="/tmp/height_${tile}_$$.txt"
        rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/${remote_path}" > "${file_list}" 2>/dev/null
        
        local file_count=$(grep -c '\.(tif|png)$' "${file_list}" 2>/dev/null || echo "0")
        echo "📊 [$$] 高度数据包含 ${file_count} 个文件: ${tile}"
        
        if rsync ${RSYNC_OPTS} -r \
            "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/${remote_path}" \
            "${local_dir}/"; then
            echo "✅ [$$] 高度数据下载成功: ${tile} (${file_count} 文件)"
        else
            echo "❌ [$$] 高度数据下载失败: ${tile}"
            rm -f "${file_list}"
            return 1
        fi
        
        rm -f "${file_list}"
    fi
}

# 导出函数
export -f check_and_download
export RSYNC_USER RSYNC_HOST RSYNC_MODULE DEST_DIR RSYNC_OPTS RSYNC_PASSWORD

echo "🚀 开始并行下载..."

# 创建下载任务列表
download_tasks=()

for tile in "${TILES_ARRAY[@]}"; do
    if [[ "$DOWNLOAD_BUILDING" == true ]]; then
        download_tasks+=("$tile building $REGION")
    fi
    if [[ "$DOWNLOAD_HEIGHT" == true ]]; then
        download_tasks+=("$tile height $REGION")
    fi
done

# 并行执行下载任务
printf '%s\n' "${download_tasks[@]}" | \
    xargs -n 3 -P ${MAX_PARALLEL} -I {} bash -c 'check_and_download "$@"' _ {}

# 等待所有任务完成
wait

# 清理
unset RSYNC_PASSWORD

echo ""
echo "🎯 ${REGION} 数据并行下载完成！"

# 统计结果
if [[ -d "${DEST_DIR}/${REGION}" ]]; then
    echo "📁 数据位置: ${DEST_DIR}/${REGION}/"
    
    building_files=$(find "${DEST_DIR}/${REGION}" -name "*.geojson" | wc -l)
    height_files=$(find "${DEST_DIR}/${REGION}" -name "*.tif" -o -name "*.png" | wc -l)
    total_size=$(du -sh "${DEST_DIR}/${REGION}" 2>/dev/null | cut -f1)
    
    echo "📊 下载统计:"
    echo "   建筑文件: ${building_files}"
    echo "   高度文件: ${height_files}"
    echo "   总大小: ${total_size}"
    
    echo ""
    echo "🏢 建筑数据文件:"
    find "${DEST_DIR}/${REGION}" -name "*.geojson" -exec ls -lh {} \;
else
    echo "⚠️ 未找到 ${REGION} 数据"
fi

echo ""
echo "💡 使用建议:"
echo "1. 检查下载的数据文件"
echo "2. 更新本地TUM数据服务配置"
echo "3. 在应用中测试新区域的阴影计算"



