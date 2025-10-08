#!/bin/bash

# 测试不同的TUM访问凭据组合

echo "🔐 TUM访问凭据测试工具"
echo "===================="
echo ""

# 测试不同的凭据组合
declare -a CREDENTIALS=(
    "m1782307:m1782307"
    "m1782307:m1782307.rep" 
    "m1782307.rep:m1782307"
    "m1782307.rep:m1782307.rep"
)

for cred in "${CREDENTIALS[@]}"; do
    IFS=':' read -r user pass <<< "$cred"
    
    echo "🔍 测试凭据: 用户=${user}, 密码=${pass}"
    
    export RSYNC_PASSWORD="$pass"
    
    if timeout 15 rsync --list-only "rsync://${user}@dataserv.ub.tum.de/${user}/" &>/dev/null; then
        echo "✅ 成功! 用户=${user}, 密码=${pass}"
        echo "📂 目录内容:"
        rsync --list-only "rsync://${user}@dataserv.ub.tum.de/${user}/" 2>/dev/null | head -10
        echo ""
        
        # 如果成功，检查是否有LoD1目录
        echo "🔍 检查LoD1目录..."
        if timeout 10 rsync --list-only "rsync://${user}@dataserv.ub.tum.de/${user}/LoD1/" &>/dev/null; then
            echo "✅ LoD1目录存在!"
            rsync --list-only "rsync://${user}@dataserv.ub.tum.de/${user}/LoD1/" 2>/dev/null | head -5
        else
            echo "❌ LoD1目录不存在"
        fi
        
        echo ""
        echo "🔍 检查Height目录..."
        if timeout 10 rsync --list-only "rsync://${user}@dataserv.ub.tum.de/${user}/Height/" &>/dev/null; then
            echo "✅ Height目录存在!"
            rsync --list-only "rsync://${user}@dataserv.ub.tum.de/${user}/Height/" 2>/dev/null | head -5
        else
            echo "❌ Height目录不存在"
        fi
        
    else
        echo "❌ 失败: 用户=${user}, 密码=${pass}"
    fi
    
    echo "----------------------------------------"
    echo ""
done

# 清理
unset RSYNC_PASSWORD

echo "💡 总结:"
echo "请查看上述输出中标记为 ✅ 的成功组合"
echo "如果都失败了，可能需要联系TUM获取正确的访问权限"


