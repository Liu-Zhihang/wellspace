#!/bin/bash

# 测试TUM WFS服务当前状态
# 检查之前遇到的502错误是否已经修复

echo "🌐 TUM WFS服务状态测试"
echo "===================="
echo ""

# TUM WFS端点
WFS_BASE_URL="https://tubvsig-so2sat-vm1.srv.mwn.de/geoserver/ows"

echo "🔍 测试TUM WFS服务连接..."
echo "端点: $WFS_BASE_URL"
echo ""

# 测试1: 基础连接测试
echo "📡 测试1: 基础连接测试"
echo "请求: GET $WFS_BASE_URL"

if curl -s --max-time 30 "$WFS_BASE_URL" > /dev/null 2>&1; then
    echo "✅ 基础连接成功"
else
    echo "❌ 基础连接失败"
    echo "详细错误信息:"
    curl -s --max-time 30 "$WFS_BASE_URL" 2>&1 | head -5
fi

echo ""

# 测试2: WFS GetCapabilities请求
echo "📡 测试2: WFS GetCapabilities请求"
capabilities_url="${WFS_BASE_URL}?service=WFS&version=2.0.0&request=GetCapabilities"
echo "请求: $capabilities_url"

capabilities_response=$(curl -s --max-time 30 "$capabilities_url" 2>/dev/null)
if [[ $? -eq 0 ]] && [[ -n "$capabilities_response" ]]; then
    if echo "$capabilities_response" | grep -q "WFS_Capabilities\|ServiceException"; then
        if echo "$capabilities_response" | grep -q "WFS_Capabilities"; then
            echo "✅ GetCapabilities请求成功"
            
            # 提取服务信息
            echo "📋 WFS服务信息:"
            if echo "$capabilities_response" | grep -q "FeatureType"; then
                feature_count=$(echo "$capabilities_response" | grep -o "FeatureType" | wc -l)
                echo "   可用要素类型数量: $feature_count"
            fi
            
            # 检查是否包含建筑物相关的图层
            if echo "$capabilities_response" | grep -qi "building\|gba\|atlas"; then
                echo "   ✅ 包含建筑物相关图层"
            else
                echo "   ⚠️  未找到明显的建筑物图层"
            fi
            
        else
            echo "❌ 服务返回错误"
            echo "错误信息: $(echo "$capabilities_response" | grep -o "ServiceException.*" | head -1)"
        fi
    else
        echo "❌ 响应格式异常"
        echo "响应内容 (前200字符): $(echo "$capabilities_response" | head -c 200)"
    fi
else
    echo "❌ GetCapabilities请求失败"
    echo "错误码: $?"
fi

echo ""

# 测试3: 具体的建筑数据查询
echo "📡 测试3: 建筑数据查询测试"
# 尝试查询香港区域的建筑数据
query_url="${WFS_BASE_URL}?service=WFS&version=2.0.0&request=GetFeature&typeName=gba:buildings&bbox=113.8,22.1,114.5,22.6,EPSG:4326&maxFeatures=10&outputFormat=application/json"
echo "请求: 香港区域建筑数据查询"
echo "BBOX: 113.8,22.1,114.5,22.6 (香港)"

query_response=$(curl -s --max-time 30 "$query_url" 2>/dev/null)
if [[ $? -eq 0 ]] && [[ -n "$query_response" ]]; then
    if echo "$query_response" | grep -q "FeatureCollection\|features"; then
        echo "✅ 建筑数据查询成功"
        
        # 分析响应
        if echo "$query_response" | grep -q '"features"'; then
            feature_count=$(echo "$query_response" | grep -o '"type":"Feature"' | wc -l)
            echo "   返回要素数量: $feature_count"
        fi
    else
        echo "❌ 建筑数据查询失败"
        echo "响应 (前300字符): $(echo "$query_response" | head -c 300)"
    fi
else
    echo "❌ 建筑数据查询请求失败"
fi

echo ""

# 测试4: 使用不同的图层名称
echo "📡 测试4: 尝试不同的图层名称"

possible_layers=(
    "gba:buildings"
    "gba:building"
    "buildings"
    "building"
    "GlobalBuildingAtlas"
    "atlas:buildings"
)

for layer in "${possible_layers[@]}"; do
    echo "尝试图层: $layer"
    test_url="${WFS_BASE_URL}?service=WFS&version=2.0.0&request=GetFeature&typeName=${layer}&maxFeatures=1&outputFormat=application/json"
    
    test_response=$(curl -s --max-time 10 "$test_url" 2>/dev/null)
    if [[ $? -eq 0 ]] && echo "$test_response" | grep -q "FeatureCollection"; then
        echo "   ✅ 图层 $layer 可用"
        break
    else
        echo "   ❌ 图层 $layer 不可用"
    fi
done

echo ""

# 测试5: HTTP状态码检查
echo "📡 测试5: HTTP状态码详细检查"
echo "检查是否还是502 Bad Gateway错误..."

status_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 "$WFS_BASE_URL")
echo "HTTP状态码: $status_code"

case $status_code in
    200)
        echo "✅ 服务正常 (HTTP 200)"
        ;;
    502)
        echo "❌ 服务器网关错误 (HTTP 502) - 与之前相同的问题"
        ;;
    503)
        echo "⚠️  服务不可用 (HTTP 503) - 临时问题"
        ;;
    404)
        echo "❌ 服务未找到 (HTTP 404) - 端点可能已更改"
        ;;
    000)
        echo "❌ 连接失败 (HTTP 000) - 网络或DNS问题"
        ;;
    *)
        echo "⚠️  异常状态码: $status_code"
        ;;
esac

echo ""
echo "🎯 测试总结:"
echo "==========="

if [[ "$status_code" == "200" ]]; then
    echo "✅ TUM WFS服务已恢复正常"
    echo "💡 建议: 可以重新启用混合建筑服务中的TUM数据源"
    echo ""
    echo "🔧 要启用TUM数据源，请修改:"
    echo "   shadow-map-backend/src/services/hybridBuildingService.ts"
    echo "   将 enableTUM: false 改为 enableTUM: true"
elif [[ "$status_code" == "502" ]]; then
    echo "❌ TUM WFS服务仍然返回502错误"
    echo "💡 建议: 继续使用本地下载的数据和OSM数据"
else
    echo "⚠️  TUM WFS服务状态不明确"
    echo "💡 建议: 暂时继续使用备选数据源"
fi

echo ""
echo "📊 当前可用的数据源:"
echo "1. ✅ 本地TUM数据 (通过FTP下载)"
echo "2. ✅ OSM数据 (通过Overpass API)"
echo "3. ✅ MongoDB缓存数据"
echo "4. $(if [[ "$status_code" == "200" ]]; then echo "✅"; else echo "❌"; fi) TUM WFS在线数据"



