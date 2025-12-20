# WSL Docker + EasyConnect + v2rayN 分流配置指南

完整记录：解决 WSL 代理冲突、安装 Docker、容器化运行 EasyConnect，并配合 v2rayN + SwitchyOmega 实现「内网走 EasyConnect 容器，外网走 v2rayN」的分流方案。

> 本文为长文参考；快速要点已收敛到 `DOCS_INDEX.md` 的「7) WSL / Docker / 代理」。

## 1. 核心目标
- 在 WSL2 中运行 Docker。
- 使用容器运行 EasyConnect，隔离对 Windows 路由表的影响。
- Windows 端运行 v2rayN + SwitchyOmega，学校内网走容器代理，外网走 v2rayN，互不干扰。

---

## 2. 前置准备：打通 WSL 与 Windows 的代理

WSL2 本质是虚拟机，需要通过宿主机网关访问 v2rayN。为避免 IP 变动导致失效，建议在 Windows 使用固定局域网 IP。

### 2.1 Windows 端设置
1) **v2rayN**：开启「允许来自局域网的连接 (Allow LAN)」，记下 HTTP 端口 (默认 10809) 和 SOCKS 端口 (默认 10808)。  
2) **防火墙放行端口**（管理员 PowerShell）：
   ```powershell
   # 放行 10808 (v2rayN)
   New-NetFirewallRule -DisplayName "WSL-v2rayN-10808" -Direction Inbound -LocalPort 10808 -Protocol TCP -Action Allow -Profile Any
   ```
3) **获取局域网 IP**：`ipconfig` 查询 IPv4 地址，例如 `192.168.1.6`。

### 2.2 WSL 端配置代理 (.bashrc)
```bash
# 1) 替换为你的真实 IP
export hostip="192.168.1.6"

# 2) 追加到 .bashrc（不覆盖原配置）
cat >> ~/.bashrc << EOF
export hostip="$hostip"
export https_proxy="http://${hostip}:10808"
export http_proxy="http://${hostip}:10808"
export all_proxy="socks5://${hostip}:10808"
EOF

# 3) 立即生效
source ~/.bashrc
```

**验证**：`curl -I https://www.google.com` 返回 `200 OK` 视为成功。

---

## 3. 安装 Docker (Ubuntu)

代理已通，可直接安装。

### 3.1 一键安装
```bash
sudo -E apt-get install -y ca-certificates curl gnupg lsb-release && \
sudo install -m 0755 -d /etc/apt/keyrings && \
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo -E gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg && \
sudo chmod a+r /etc/apt/keyrings/docker.gpg && \
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null && \
sudo -E apt-get update && \
sudo -E apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### 3.2 配置 Docker 守护进程代理
Docker 拉取镜像不读 `.bashrc`，需在 systemd 服务层设置。
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d

sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf > /dev/null <<EOF
[Service]
Environment="HTTP_PROXY=http://192.168.1.6:10808"
Environment="HTTPS_PROXY=http://192.168.1.6:10808"
Environment="NO_PROXY=localhost,127.0.0.1"
EOF

sudo systemctl daemon-reload
sudo systemctl restart docker

# 让当前用户免 sudo 使用 Docker
sudo usermod -aG docker $USER
# 重启 WSL 终端生效
```

---

## 4. 部署 EasyConnect 容器

镜像：`hagb/docker-easyconnect`（含图形界面登录）。若有 2FA/验证码，首次需映射 5901 端口用 VNC 登录。

### 4.1 启动容器
```bash
# === 配置变量 ===
EC_SERVER="remote.hkust-gz.edu.cn"   # 学校 VPN 地址
EC_USER="jwu923"                     # 用户名
EC_PASS="你的密码"                    # 密码
VNC_PASS="password"                  # VNC 密码

# === 启动 ===
docker run -d \
  --name easyconnect \
  --restart unless-stopped \
  --device /dev/net/tun --cap-add NET_ADMIN \
  -e EC_VER=7.6.7 \
  -e EASYCONNECT_SERVER="$EC_SERVER" \
  -e EASYCONNECT_USERNAME="$EC_USER" \
  -e EASYCONNECT_PASSWORD="$EC_PASS" \
  -e PASSWORD="$VNC_PASS" \
  -p 127.0.0.1:1080:1080 \
  -p 127.0.0.1:8080:8080 \
  -p 127.0.0.1:5901:5901 \
  hagb/docker-easyconnect:7.6.7
```

### 4.2 首次登录 (VNC)
1) Windows 安装并打开 VNC Viewer。  
2) 连接 `127.0.0.1:5901`，密码 `password`。  
3) 在图形界面完成登录（验证码/短信）。  
4) 出现 EasyConnect “Intranet” 图标即连通。  
5) 关闭 VNC Viewer（容器会继续运行）。

**验证**（WSL 内）：
```bash
curl -I -x socks5h://127.0.0.1:1080 https://cms.hkust-gz.edu.cn
# 期望 HTTP 200 或 302
```

---

## 5. 浏览器分流配置 (SwitchyOmega)

目标：学校域名走 Docker EasyConnect (`127.0.0.1:1080`)，其他流量走 v2rayN (`127.0.0.1:10808`)。

### 5.1 情景模式
- **Proxy (默认)**：SOCKS5，`127.0.0.1`, 端口 `10808`（v2rayN）。
- **School-VPN**：SOCKS5，`127.0.0.1`, 端口 `1080`（Docker EasyConnect）。

### 5.2 Auto Switch
1) 添加规则：类型「域名通配符」，规则 `*hkust-gz.edu.cn`，情景模式 `School-VPN`。  
2) 可选：辅助条件选 `Proxy`，让其他流量走 v2rayN。  
3) 点击左下角「应用选项」，插件模式选择「Auto Switch」。

---

## 6. 常见问题排查

1) **浏览器 Access Denied**：清除与 `hkust-gz.edu.cn` 相关缓存/Cookie，或用无痕模式。  
2) **Docker 拉取卡住**：检查 `/etc/systemd/system/docker.service.d/http-proxy.conf` 中的 IP 是否当前局域网 IP，修改后 `sudo systemctl restart docker`。  
3) **内网断连**：Session 过期，重新用 VNC (`127.0.0.1:5901`) 登录点击「登录」或重新验证。  
4) **WSL 连不上 Windows 代理 (Connection Refused)**：Windows IP 变更或防火墙规则失效，更新 `.bashrc` 的 `hostip` 或重检防火墙规则。

---

## 7. 🔥 "Path selection failed" 网络错误排查 (2024-12 实战)

### 7.1 问题现象

VNC 连接正常，能看到 EasyConnect 登录界面，但点击登录后报错：

```
Path selection failed, possibly because network connection error occurs. Please try again later.
```

### 7.2 根本原因

这个错误信息具有**误导性**，实际可能是以下原因之一：

| 原因 | 说明 |
|------|------|
| **DNS 解析失败** | 容器内无法解析学校域名 |
| **DNS 污染** | 宿主机代理（如 v2rayA）干扰了容器的 DNS |
| **网络不通** | 容器无法访问外部网络（防火墙/iptables） |
| **域名被拦截** | 某些网络环境下域名被 SNI 阻断 |

### 7.3 排查步骤

```bash
# 1. 检查容器 DNS 配置
docker exec -it easyconnect cat /etc/resolv.conf

# 2. 在宿主机解析域名（指定公共 DNS）
nslookup remote.hkust-gz.edu.cn 223.5.5.5

# 3. 检查容器日志
docker logs easyconnect
```

### 7.4 解决方案

#### ✅ 方案 A：强制指定 DNS（推荐）

启动容器时添加 `--dns` 参数，绕过宿主机 DNS：

```bash
docker rm -f easyconnect 2>/dev/null

docker run --device /dev/net/tun --cap-add NET_ADMIN -ti -d \
    --name easyconnect \
    -p 1080:1080 \
    -p 5901:5901 \
    --dns 223.5.5.5 \
    --dns 8.8.8.8 \
    -e EC_VER=7.6.7 \
    -e PASSWORD=xxxx \
    hagb/docker-easyconnect:7.6.7
```

#### ✅ 方案 B：直接使用 IP 地址（终极方案）

如果 DNS 问题无法解决，**绕过域名解析**，直接填 IP：

```bash
# 先解析出 IP
nslookup remote.hkust-gz.edu.cn 223.5.5.5
# 输出: Address: 218.107.35.197
```

然后在 VNC 的 EasyConnect 界面中，服务器地址填：

```
218.107.35.197
```

而不是 `remote.hkust-gz.edu.cn`。

### 7.5 已知有效的学校 VPN IP

| 学校 | 域名 | IP |
|------|------|-----|
| HKUST(GZ) | `remote.hkust-gz.edu.cn` | `218.107.35.197` |

> ⚠️ IP 可能会变，如果连接失败，重新用 `nslookup` 解析一次。

### 7.6 完整启动命令模板（集成所有 fix）

```bash
# 清理旧容器
docker rm -f easyconnect 2>/dev/null

# 启动（DNS 修正 + TUN 设备 + 网络权限）
docker run --device /dev/net/tun --cap-add NET_ADMIN -ti -d \
    --name easyconnect \
    -p 1080:1080 \
    -p 5901:5901 \
    --dns 223.5.5.5 \
    --dns 8.8.8.8 \
    -e EC_VER=7.6.7 \
    -e PASSWORD=your_vnc_password \
    hagb/docker-easyconnect:7.6.7

# 等待启动
sleep 3

# 检查状态
docker ps | grep easyconnect
docker logs easyconnect | tail -10
```

然后 VNC 连接 `服务器IP:5901`，在 EasyConnect 里填 **IP 地址** `218.107.35.197` 登录。

### 7.7 Checklist

- [ ] 容器添加了 `--device /dev/net/tun --cap-add NET_ADMIN`
- [ ] 容器添加了 `--dns 223.5.5.5`
- [ ] VNC 能正常连接
- [ ] 服务器地址填的是 **IP** 而不是域名
- [ ] 宿主机 TUN 模块已加载 (`ls /dev/net/tun`)
