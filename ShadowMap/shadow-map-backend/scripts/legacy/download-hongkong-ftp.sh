#!/bin/bash

# 基于FTP的香港数据自动下载脚本
# 使用TUM提供的FTP服务下载香港建筑和高度数据

FTP_HOST="dataserv.ub.tum.de"
FTP_USER="m1782307"
FTP_PASS="m1782307"
DEST_DIR="./data/tum-buildings/hongkong"

echo "🇭🇰 TUM香港数据FTP下载器"
echo "========================="
echo "🌐 FTP服务器: ${FTP_HOST}"
echo "👤 用户: ${FTP_USER}"
echo "📁 下载目录: ${DEST_DIR}"
echo ""

# 创建目录结构
mkdir -p "${DEST_DIR}"/{LoD1,Height}

# 香港数据文件列表
declare -A HK_FILES=(
    # 建筑数据 (LoD1) - 优先下载，文件较小
    ["LoD1/e110_n25_e115_n20.geojson"]="/LoD1/asiaeast/e110_n25_e115_n20.geojson"
    ["LoD1/e115_n25_e120_n20.geojson"]="/LoD1/asiaeast/e115_n25_e120_n20.geojson"
    
    # 高度数据 (Height) - 文件很大，可选下载
    ["Height/e110_n25_e115_n20.zip"]="/Height/asiaeast/e110_n25_e115_n20.zip"
    ["Height/e115_n25_e120_n20.zip"]="/Height/asiaeast/e115_n25_e120_n20.zip"
)

# FTP下载函数
download_ftp_file() {
    local local_path="$1"
    local remote_path="$2"
    local full_local_path="${DEST_DIR}/${local_path}"
    
    echo "📥 下载: $(basename "$remote_path")"
    echo "   远程: ftp://${FTP_HOST}${remote_path}"
    echo "   本地: ${full_local_path}"
    
    # 创建本地目录
    mkdir -p "$(dirname "$full_local_path")"
    
    # 使用wget进行FTP下载
    if command -v wget &> /dev/null; then
        echo "   🔧 使用wget下载..."
        if wget --ftp-user="$FTP_USER" --ftp-password="$FTP_PASS" \
               --progress=bar:force \
               "ftp://${FTP_HOST}${remote_path}" \
               -O "$full_local_path"; then
            
            if [[ -f "$full_local_path" ]]; then
                local file_size=$(ls -lh "$full_local_path" | awk '{print $5}')
                echo "   ✅ 下载成功: ${file_size}"
                
                # 如果是建筑数据，分析建筑数量
                if [[ "$local_path" == *".geojson" ]]; then
                    local building_count=$(grep -o '"type":"Feature"' "$full_local_path" | wc -l 2>/dev/null || echo "0")
                    echo "   📊 建筑数量: ${building_count}"
                fi
                
                return 0
            else
                echo "   ❌ 文件未生成"
                return 1
            fi
        else
            echo "   ❌ wget下载失败"
            return 1
        fi
    
    # 备选：使用curl进行FTP下载
    elif command -v curl &> /dev/null; then
        echo "   🔧 使用curl下载..."
        if curl --ftp-user "$FTP_USER:$FTP_PASS" \
               --progress-bar \
               "ftp://${FTP_HOST}${remote_path}" \
               -o "$full_local_path"; then
            
            if [[ -f "$full_local_path" ]]; then
                local file_size=$(ls -lh "$full_local_path" | awk '{print $5}')
                echo "   ✅ 下载成功: ${file_size}"
                return 0
            else
                echo "   ❌ 文件未生成"
                return 1
            fi
        else
            echo "   ❌ curl下载失败"
            return 1
        fi
    
    # 备选：使用ftp命令
    else
        echo "   🔧 使用ftp命令下载..."
        ftp -n << EOF
open ${FTP_HOST}
user ${FTP_USER} ${FTP_PASS}
binary
get ${remote_path} ${full_local_path}
quit
EOF
        
        if [[ -f "$full_local_path" ]]; then
            local file_size=$(ls -lh "$full_local_path" | awk '{print $5}')
            echo "   ✅ 下载成功: ${file_size}"
            return 0
        else
            echo "   ❌ ftp命令下载失败"
            return 1
        fi
    fi
}

# 询问用户下载选项
echo "📋 可下载的香港数据文件:"
echo "🏢 建筑数据 (LoD1):"
echo "   1. e110_n25_e115_n20.geojson (主要香港区域)"
echo "   2. e115_n25_e120_n20.geojson (东侧区域)"
echo ""
echo "📏 高度数据 (Height):"
echo "   3. e110_n25_e115_n20.zip (~91GB, 主要香港区域)"
echo "   4. e115_n25_e120_n20.zip (~675MB, 东侧区域)"
echo ""

read -p "选择下载选项 [1=仅主要建筑, 2=所有建筑, 3=建筑+小高度, 4=全部]: " choice

case $choice in
    1)
        echo "📥 下载主要建筑数据..."
        download_ftp_file "LoD1/e110_n25_e115_n20.geojson" "/LoD1/asiaeast/e110_n25_e115_n20.geojson"
        ;;
    2)
        echo "📥 下载所有建筑数据..."
        download_ftp_file "LoD1/e110_n25_e115_n20.geojson" "/LoD1/asiaeast/e110_n25_e115_n20.geojson"
        download_ftp_file "LoD1/e115_n25_e120_n20.geojson" "/LoD1/asiaeast/e115_n25_e120_n20.geojson"
        ;;
    3)
        echo "📥 下载建筑数据 + 小高度数据..."
        download_ftp_file "LoD1/e110_n25_e115_n20.geojson" "/LoD1/asiaeast/e110_n25_e115_n20.geojson"
        download_ftp_file "LoD1/e115_n25_e120_n20.geojson" "/LoD1/asiaeast/e115_n25_e120_n20.geojson"
        download_ftp_file "Height/e115_n25_e120_n20.zip" "/Height/asiaeast/e115_n25_e120_n20.zip"
        ;;
    4)
        echo "📥 下载全部数据（警告：包含91GB大文件）..."
        echo "⚠️  确认下载91GB文件？[y/N]: "
        read -n 1 -r
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            for local_path in "${!HK_FILES[@]}"; do
                download_ftp_file "$local_path" "${HK_FILES[$local_path]}"
            done
        else
            echo "取消下载大文件"
        fi
        ;;
    *)
        echo "❌ 无效选择，退出"
        exit 1
        ;;
esac

echo ""
echo "🎯 下载完成！"

# 统计结果
if [[ -d "${DEST_DIR}" ]]; then
    echo ""
    echo "📁 数据位置: ${DEST_DIR}/"
    
    lod1_files=$(find "${DEST_DIR}/LoD1" -name "*.geojson" 2>/dev/null | wc -l)
    height_files=$(find "${DEST_DIR}/Height" -name "*.zip" 2>/dev/null | wc -l)
    total_size=$(du -sh "${DEST_DIR}" 2>/dev/null | cut -f1)
    
    echo "📊 下载统计:"
    echo "   建筑数据文件: ${lod1_files}"
    echo "   高度数据文件: ${height_files}"
    echo "   总大小: ${total_size}"
    
    if [[ $lod1_files -gt 0 ]]; then
        echo ""
        echo "🏢 建筑数据详情:"
        find "${DEST_DIR}/LoD1" -name "*.geojson" -exec sh -c '
            file="$1"
            size=$(ls -lh "$file" | awk "{print \$5}")
            count=$(grep -o "\"type\":\"Feature\"" "$file" | wc -l 2>/dev/null || echo "0")
            echo "   $(basename "$file"): $size, $count 建筑物"
        ' _ {} \;
    fi
    
    echo ""
    echo "💡 下一步:"
    echo "1. 更新本地TUM数据服务配置"
    echo "2. 在React应用中测试香港阴影计算"
    echo "3. 如需解压高度数据: unzip ${DEST_DIR}/Height/*.zip"
fi
