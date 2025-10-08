#!/bin/bash

# 验证香港数据的实际位置
# 通过下载和分析全球索引来确定正确的瓦片

RSYNC_USER="m1782307"
RSYNC_HOST="dataserv.ub.tum.de"
RSYNC_MODULE="m1782307"
TEMP_DIR="./temp_verification"

echo "🔍 TUM香港数据位置验证工具"
echo "=========================="
echo ""

# 设置密码
export RSYNC_PASSWORD="m1782307"

# 创建临时目录
mkdir -p "$TEMP_DIR"

echo "📥 下载全球数据索引..."

# 下载全球索引文件
echo "正在下载 lod1.geojson (全球建筑数据索引)..."
if rsync -avz --progress \
    "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/lod1.geojson" \
    "$TEMP_DIR/"; then
    echo "✅ 全球索引下载成功"
else
    echo "❌ 全球索引下载失败"
    exit 1
fi

echo ""
echo "🔍 分析香港数据位置..."

# 香港坐标范围
HK_WEST=113.8
HK_EAST=114.5
HK_SOUTH=22.1
HK_NORTH=22.6

echo "📍 搜索包含香港坐标的瓦片..."
echo "香港范围: ${HK_WEST}°E-${HK_EAST}°E, ${HK_SOUTH}°N-${HK_NORTH}°N"
echo ""

# 分析lod1.geojson文件
if [[ -f "$TEMP_DIR/lod1.geojson" ]]; then
    echo "📊 分析全球索引文件..."
    
    # 检查文件内容格式
    echo "文件大小: $(ls -lh $TEMP_DIR/lod1.geojson | awk '{print $5}')"
    echo "前10行内容:"
    head -10 "$TEMP_DIR/lod1.geojson"
    echo ""
    
    # 搜索可能包含香港的瓦片
    echo "🔍 搜索亚洲区域的瓦片..."
    
    # 方法1: 直接搜索包含香港坐标范围的条目
    echo "方法1: 搜索坐标范围匹配的瓦片"
    grep -i "asia\|e11[0-5]\|114\|113\|22\|23" "$TEMP_DIR/lod1.geojson" | head -5
    
    echo ""
    
    # 方法2: 搜索可能的瓦片名称
    echo "方法2: 搜索可能的瓦片名称"
    CANDIDATE_TILES=(
        "e110_n25_e115_n20"
        "e115_n25_e120_n20" 
        "e110_n20_e115_n15"
        "e105_n25_e110_n20"
    )
    
    for tile in "${CANDIDATE_TILES[@]}"; do
        echo "检查瓦片: $tile"
        if grep -q "$tile" "$TEMP_DIR/lod1.geojson"; then
            echo "✅ 找到瓦片: $tile"
            grep "$tile" "$TEMP_DIR/lod1.geojson"
        else
            echo "❌ 未找到瓦片: $tile"
        fi
        echo ""
    done
    
    # 方法3: 提取所有亚洲相关的瓦片
    echo "方法3: 提取所有可能相关的瓦片"
    echo "搜索经度110-120°E, 纬度15-30°N范围的瓦片..."
    
    # 使用更宽泛的搜索
    grep -E "e1[01][0-9]_n[12][0-9]_e1[01][0-9]_n[12][0-9]" "$TEMP_DIR/lod1.geojson" | \
    grep -E "(e11[0-5]|n2[0-5])" | head -10
    
else
    echo "❌ 无法找到索引文件"
fi

echo ""
echo "🌐 直接验证数据可用性..."

# 基于截图信息，测试实际的数据路径
TEST_PATHS=(
    # LoD1建筑数据 (可能在不同区域目录)
    "LoD1/asiaeast/e110_n25_e115_n20.geojson"
    "LoD1/asiaeast/e115_n25_e120_n20.geojson"
    "LoD1/asia/e110_n25_e115_n20.geojson"
    "LoD1/e110_n25_e115_n20.geojson"
    
    # Height数据 (zip格式，根据截图)
    "Height/asiaeast/e110_n25_e115_n20.zip"
    "Height/asiaeast/e115_n25_e120_n20.zip"
    "Height/asiaeast/e110_n20_e115_n15.zip"
    
    # 检查asiaeast目录结构
    "Height/asiaeast/"
    "LoD1/asiaeast/"
)

echo "🔍 直接测试数据路径可用性..."
for path in "${TEST_PATHS[@]}"; do
    echo "测试: $path"
    if timeout 30 rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/$path" &>/dev/null; then
        echo "✅ 路径存在: $path"
        
        # 如果是建筑数据，获取文件大小
        if [[ "$path" == *".geojson" ]]; then
            size=$(rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/$path" 2>/dev/null | awk '{print $5}' | tail -1)
            echo "   文件大小: $size 字节"
        fi
        
        # 如果是目录，列出前几个文件
        if [[ "$path" == *"/" ]]; then
            echo "   目录内容 (前5个):"
            rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/$path" 2>/dev/null | head -5 | sed 's/^/   /'
        fi
    else
        echo "❌ 路径不存在: $path"
    fi
    echo ""
done

echo ""
echo "🗺️ 尝试其他可能的区域结构..."

# 检查是否有不同的区域组织方式
OTHER_REGIONS=(
    "LoD1/china/"
    "LoD1/southeast_asia/" 
    "LoD1/east_asia/"
    "LoD1/"  # 直接在根目录
)

for region in "${OTHER_REGIONS[@]}"; do
    echo "检查区域: $region"
    if timeout 20 rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/$region" &>/dev/null; then
        echo "✅ 区域存在: $region"
        echo "   内容:"
        rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/$region" 2>/dev/null | head -10 | sed 's/^/   /'
    else
        echo "❌ 区域不存在: $region"
    fi
    echo ""
done

# 清理
unset RSYNC_PASSWORD

echo "🎯 验证总结:"
echo "============"
echo "1. 检查上述输出中标记为 ✅ 的路径"
echo "2. 这些是实际可用的香港数据位置"
echo "3. 更新下载脚本使用正确的路径"
echo ""
echo "📁 临时文件位置: $TEMP_DIR"
echo "💡 如需清理: rm -rf $TEMP_DIR"
