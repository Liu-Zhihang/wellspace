#!/bin/bash

# 测试慕尼黑数据和本地TUM服务

echo "🏰 慕尼黑数据测试工具"
echo "=================="
echo ""

BACKEND_URL="http://localhost:3001"
DATA_DIR="./data/tum-buildings"

# 检查数据文件是否存在
echo "📂 检查本地数据文件..."
munich_file="${DATA_DIR}/sample/examples/LoD1/europe/e010_n50_e015_n45.geojson"

if [[ -f "$munich_file" ]]; then
    file_size=$(ls -lh "$munich_file" | awk '{print $5}')
    building_count=$(grep -o '"type":"Feature"' "$munich_file" | wc -l 2>/dev/null || echo "0")
    echo "✅ 慕尼黑数据文件存在"
    echo "   文件: $munich_file"
    echo "   大小: $file_size"
    echo "   建筑数量: $building_count"
    echo ""
    
    # 分析坐标范围
    echo "📍 数据范围分析..."
    echo "   瓦片范围: 10°E-15°E, 45°N-50°N"
    echo "   覆盖区域: 德国慕尼黑及周边"
    echo ""
else
    echo "❌ 慕尼黑数据文件不存在: $munich_file"
    echo "💡 请先运行: bash download-sample-data.sh"
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

# 测试本地TUM数据API
echo ""
echo "🧪 测试本地TUM数据API..."

echo "1. 检查数据状态..."
status_response=$(curl -s "$BACKEND_URL/api/local-tum/status" | head -c 500)
echo "响应: $status_response"

echo ""
echo "2. 加载数据到内存..."
load_response=$(curl -s -X POST "$BACKEND_URL/api/local-tum/load" | head -c 500)
echo "响应: $load_response"

echo ""
echo "3. 查询慕尼黑区域建筑数据..."
# 慕尼黑市中心大致坐标
query_data='{
  "north": 48.2,
  "south": 48.0,
  "east": 11.8,
  "west": 11.4,
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
else
    echo "❌ 查询失败"
    echo "   响应: $(echo "$query_response" | head -c 300)"
fi

echo ""
echo "4. 测试混合建筑服务API..."
hybrid_response=$(curl -s "$BACKEND_URL/api/buildings/hybrid/12/2200/1343" | head -c 500)
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
echo "1. ✅ 慕尼黑数据可以正常加载"
echo "2. ✅ 本地TUM数据服务正常工作"  
echo "3. ✅ 可以在前端React应用中测试阴影计算"
echo ""
echo "💡 下一步:"
echo "1. 在React应用中切换到慕尼黑坐标 (11.5°E, 48.1°N)"
echo "2. 测试3D阴影计算功能"
echo "3. 验证整个系统工作正常后，再解决香港数据获取问题"


