#!/bin/bash

# 测试香港数据和本地TUM服务

echo "🇭🇰 香港数据测试工具"
echo "=================="
echo ""

BACKEND_URL="http://localhost:3001"
DATA_DIR="./data/tum-buildings"

# 检查香港数据文件是否存在
echo "📂 检查本地香港数据文件..."
hk_file="${DATA_DIR}/hongkong/LoD1/e110_n25_e115_n20.geojson"

if [[ -f "$hk_file" ]]; then
    file_size=$(ls -lh "$hk_file" | awk '{print $5}')
    building_count=$(grep -o '"type":"Feature"' "$hk_file" | wc -l 2>/dev/null || echo "0")
    echo "✅ 香港数据文件存在"
    echo "   文件: $hk_file"
    echo "   大小: $file_size"
    echo "   建筑数量: $building_count"
    echo ""
    
    # 分析坐标范围
    echo "📍 数据范围分析..."
    echo "   瓦片范围: 110°E-115°E, 20°N-25°N"
    echo "   覆盖区域: 香港及周边区域"
    echo "   香港中心: ~114.2°E, 22.3°N"
    echo ""
else
    echo "❌ 香港数据文件不存在: $hk_file"
    echo "💡 请先运行: bash download-hongkong-quick.sh"
    exit 1
fi

# 检查后端服务是否运行
echo "🔍 检查后端服务状态..."
if curl -s "$BACKEND_URL" > /dev/null; then
    echo "✅ 后端服务运行中"
else
    echo "❌ 后端服务未运行"
    echo "💡 请先启动后端: npm start"
    exit 1
fi

# 更新本地TUM数据服务配置（临时）
echo ""
echo "🔧 更新本地TUM数据服务配置..."
# 这里需要确保本地服务指向香港数据

# 测试本地TUM数据API
echo ""
echo "🧪 测试本地TUM数据API..."

echo "1. 检查数据状态..."
status_response=$(curl -s "$BACKEND_URL/api/local-tum/status" | head -c 500)
echo "响应: $status_response"

echo ""
echo "2. 加载香港数据到内存..."
load_response=$(curl -s -X POST "$BACKEND_URL/api/local-tum/load" | head -c 500)
echo "响应: $load_response"

echo ""
echo "3. 查询香港区域建筑数据..."
# 香港中心区域坐标
query_data='{
  "north": 22.4,
  "south": 22.2,
  "east": 114.3,
  "west": 114.1,
  "maxFeatures": 100
}'

query_response=$(curl -s -X POST "$BACKEND_URL/api/local-tum/query" \
  -H "Content-Type: application/json" \
  -d "$query_data")

# 解析响应
if echo "$query_response" | grep -q '"success":true'; then
    feature_count=$(echo "$query_response" | grep -o '"numberReturned":[0-9]*' | cut -d':' -f2)
    echo "✅ 查询成功！"
    echo "   返回建筑数量: ${feature_count:-0}"
    
    # 检查是否有建筑数据
    if [[ ${feature_count:-0} -gt 0 ]]; then
        echo "   🏢 香港中心区域有建筑数据"
    else
        echo "   ⚠️  香港中心区域无建筑数据，可能需要调整坐标范围"
    fi
else
    echo "❌ 查询失败"
    echo "   响应: $(echo "$query_response" | head -c 300)"
fi

echo ""
echo "4. 测试混合建筑服务API..."
# 使用香港附近的瓦片坐标进行测试
hybrid_response=$(curl -s "$BACKEND_URL/api/buildings/hybrid/12/3413/1673" | head -c 500)
if echo "$hybrid_response" | grep -q '"features"'; then
    echo "✅ 混合服务API正常"
else
    echo "❌ 混合服务API异常"
    echo "   响应: $hybrid_response"
fi

echo ""
echo "🎯 测试总结:"
echo "============"
echo "如果上述测试都通过，说明:"
echo "1. ✅ 香港数据可以正常加载"
echo "2. ✅ 本地TUM数据服务正常工作"  
echo "3. ✅ 可以在前端React应用中测试阴影计算"
echo ""
echo "💡 前端测试建议:"
echo "1. 在React应用中切换到香港坐标:"
echo "   - 经度: 114.2°E"
echo "   - 纬度: 22.3°N"
echo "   - 缩放级别: 12-15"
echo "2. 测试3D阴影计算功能"
echo "3. 验证建筑物显示和阴影效果"
echo ""
echo "🌐 推荐测试位置:"
echo "   - 香港中环: 114.158°E, 22.287°N"
echo "   - 尖沙咀: 114.172°E, 22.297°N"  
echo "   - 铜锣湾: 114.184°E, 22.281°N"


