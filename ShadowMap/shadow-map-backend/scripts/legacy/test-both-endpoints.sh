#!/bin/bash

# 测试两个TUM数据端点的访问情况

echo "🔍 TUM数据端点测试工具"
echo "===================="
echo ""

echo "📊 测试1: Representative Dataset (8GB样本数据)"
echo "用户: m1782307.rep"
echo "密码: m1782307.rep"
echo "端点: rsync://m1782307.rep@dataserv.ub.tum.de/m1782307.rep/"
echo ""

export RSYNC_PASSWORD="m1782307.rep"
echo "🔍 访问样本数据集..."
if timeout 30 rsync --list-only "rsync://m1782307.rep@dataserv.ub.tum.de/m1782307.rep/" 2>/dev/null; then
    echo "✅ 样本数据集访问成功"
else
    echo "❌ 样本数据集访问失败"
fi

echo ""
echo "=========================================="
echo ""

echo "📊 测试2: Entire Dataset (36TB完整数据)"
echo "用户: m1782307"  
echo "密码: m1782307"
echo "端点: rsync://m1782307@dataserv.ub.tum.de/m1782307/"
echo ""

export RSYNC_PASSWORD="m1782307"
echo "🔍 访问完整数据集..."
if timeout 30 rsync --list-only "rsync://m1782307@dataserv.ub.tum.de/m1782307/" 2>/dev/null; then
    echo "✅ 完整数据集访问成功"
else
    echo "❌ 完整数据集访问失败"
    echo ""
    echo "🔍 尝试详细错误信息..."
    rsync --list-only "rsync://m1782307@dataserv.ub.tum.de/m1782307/" 2>&1 | head -10
fi

echo ""
echo "=========================================="
echo ""

echo "🤔 可能的原因分析:"
echo "1. 完整数据集可能需要特殊权限或不同的访问方式"
echo "2. 密码可能不正确"
echo "3. 用户名可能不正确"
echo "4. 端点可能暂时不可用"
echo ""

echo "💡 建议:"
echo "1. 如果只有样本数据集可用，我们可以从中获取慕尼黑的示例数据"
echo "2. 检查TUM网站是否有其他访问完整数据的方法"
echo "3. 联系TUM获取正确的访问凭据"

# 清理
unset RSYNC_PASSWORD



