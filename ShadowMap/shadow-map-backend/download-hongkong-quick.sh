#!/bin/bash

# 香港建筑数据快速下载脚本
# 只下载最重要的建筑几何数据，用于立即测试

FTP_HOST="dataserv.ub.tum.de"
FTP_USER="m1782307"
FTP_PASS="m1782307"
DEST_DIR="./data/tum-buildings/hongkong"

echo "🚀 香港建筑数据快速下载"
echo "======================"
echo ""

# 创建目录
mkdir -p "${DEST_DIR}/LoD1"

# 主要香港建筑数据文件
MAIN_FILE="e110_n25_e115_n20.geojson"
REMOTE_PATH="/LoD1/asiaeast/${MAIN_FILE}"
LOCAL_PATH="${DEST_DIR}/LoD1/${MAIN_FILE}"

echo "📥 下载香港主要建筑数据..."
echo "   文件: ${MAIN_FILE}"
echo "   覆盖: 110°E-115°E, 20°N-25°N (包含完整香港)"
echo ""

# 使用wget下载（最可靠）
if command -v wget &> /dev/null; then
    echo "🔧 使用wget下载..."
    wget --ftp-user="$FTP_USER" --ftp-password="$FTP_PASS" \
         --progress=bar:force \
         --timeout=300 \
         --tries=3 \
         "ftp://${FTP_HOST}${REMOTE_PATH}" \
         -O "$LOCAL_PATH"

# 备选：使用curl
elif command -v curl &> /dev/null; then
    echo "🔧 使用curl下载..."
    curl --ftp-user "$FTP_USER:$FTP_PASS" \
         --progress-bar \
         --max-time 1800 \
         --retry 3 \
         "ftp://${FTP_HOST}${REMOTE_PATH}" \
         -o "$LOCAL_PATH"
else
    echo "❌ 需要wget或curl命令"
    exit 1
fi

# 验证下载结果
if [[ -f "$LOCAL_PATH" ]]; then
    file_size=$(ls -lh "$LOCAL_PATH" | awk '{print $5}')
    echo ""
    echo "✅ 下载成功！"
    echo "   文件大小: ${file_size}"
    
    # 分析建筑数据
    echo "📊 分析建筑数据..."
    building_count=$(grep -o '"type":"Feature"' "$LOCAL_PATH" | wc -l 2>/dev/null || echo "0")
    echo "   建筑数量: ${building_count}"
    
    # 检查数据完整性
    if [[ $building_count -gt 1000000 ]]; then
        echo "   ✅ 数据看起来完整 (>100万建筑)"
    elif [[ $building_count -gt 100000 ]]; then
        echo "   ⚠️  数据可能不完整 (${building_count} 建筑)"
    else
        echo "   ❌ 数据可能有问题 (仅${building_count} 建筑)"
    fi
    
    echo ""
    echo "🎯 香港建筑数据准备就绪！"
    echo ""
    echo "📁 文件位置: ${LOCAL_PATH}"
    echo "💡 下一步:"
    echo "1. 启动后端服务: npm start"
    echo "2. 运行测试: bash test-hongkong-data.sh"
    echo "3. 在React应用中切换到香港坐标测试阴影"
    
else
    echo ""
    echo "❌ 下载失败！"
    echo "💡 可能的解决方案:"
    echo "1. 检查网络连接"
    echo "2. 验证FTP凭据"
    echo "3. 尝试手动浏览器下载: ftp://${FTP_USER}:${FTP_PASS}@${FTP_HOST}${REMOTE_PATH}"
    exit 1
fi


