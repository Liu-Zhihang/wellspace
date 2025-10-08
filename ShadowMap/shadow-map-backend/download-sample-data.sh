#!/bin/bash

# 基于8GB样本数据集的下载脚本
# 由于完整数据集访问有问题，我们先用样本数据测试功能

RSYNC_USER="m1782307.rep"
RSYNC_HOST="dataserv.ub.tum.de"
RSYNC_MODULE="m1782307.rep"
DEST_DIR="./data/tum-buildings"

echo "📦 TUM样本数据下载器"
echo "==================="
echo "由于完整数据集访问问题，先下载样本数据进行测试"
echo ""

# 设置密码
export RSYNC_PASSWORD="m1782307.rep"

# 创建目录
mkdir -p "${DEST_DIR}/sample"

echo "🔍 检查样本数据集内容..."
rsync --list-only "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/"

echo ""
echo "📥 下载全球索引文件..."

# 下载索引文件
rsync -avz --progress \
    "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/lod1.geojson" \
    "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/height_zip.geojson" \
    "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/height_tif.geojson" \
    "${DEST_DIR}/sample/"

echo ""
echo "📥 下载示例数据..."

# 下载整个examples目录
rsync -avz --progress \
    "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/examples/" \
    "${DEST_DIR}/sample/examples/"

echo ""
echo "📥 下载其他文件..."

# 下载其他有用的文件
rsync -avz --progress \
    "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/README.txt" \
    "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/LICENSE" \
    "rsync://${RSYNC_USER}@${RSYNC_HOST}/${RSYNC_MODULE}/checksums.sha512" \
    "${DEST_DIR}/sample/"

# 清理
unset RSYNC_PASSWORD

echo ""
echo "🎯 样本数据下载完成！"

if [[ -d "${DEST_DIR}/sample" ]]; then
    echo ""
    echo "📁 数据位置: ${DEST_DIR}/sample/"
    echo "📊 下载的文件:"
    find "${DEST_DIR}/sample" -type f -exec ls -lh {} \;
    
    echo ""
    echo "🔍 分析慕尼黑示例数据..."
    munich_file="${DEST_DIR}/sample/examples/LoD1/europe/e010_n50_e015_n45.geojson"
    if [[ -f "$munich_file" ]]; then
        file_size=$(ls -lh "$munich_file" | awk '{print $5}')
        building_count=$(grep -o '"type":"Feature"' "$munich_file" | wc -l 2>/dev/null || echo "0")
        echo "   慕尼黑建筑数据: ${file_size}, ${building_count} 建筑物"
        
        # 分析坐标范围
        echo "   📍 坐标范围: 10°E-15°E, 45°N-50°N"
        echo "   🏢 可用于测试阴影计算功能"
    fi
    
    echo ""
    echo "💡 下一步:"
    echo "1. 使用慕尼黑数据测试本地TUM数据服务"
    echo "2. 验证阴影计算功能"
    echo "3. 如果功能正常，再考虑获取香港数据的其他方法"
    echo ""
    echo "🔧 完整数据集访问问题:"
    echo "- @ERROR: chroot failed 表明服务器配置问题"
    echo "- 可能需要联系TUM获取正确的访问方法"
    echo "- 或者使用Web界面手动下载特定区域数据"
else
    echo "⚠️ 样本数据下载失败"
fi
