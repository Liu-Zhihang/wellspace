# WSL 配置 Codex CLI 与 chrome-devtools-mcp / context7 MCP 常见坑位

## 1. Node / nvm 安装
- **不要直接复用 Windows Node**：在 WSL 里运行 `codex` 会提示 `node: not found`。务必在 WSL 内用 `nvm` 安装 Node（建议 20.x）。
- **`nvm install 20` 拉取失败**：默认访问 `nodejs.org`，可提前写入镜像：
  ```bash
  export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
  export NVM_IOJS_ORG_MIRROR=https://npmmirror.com/mirrors/iojs
  ```
  写进 `~/.bashrc` 后再执行 `nvm install 20 && nvm use 20`。
- **`nvm use` 提示 prefix/globalconfig 冲突**：`~/.npmrc` 中的 `prefix`、`globalconfig` 多来自 Windows 配置，删除这些行或运行 `nvm use --delete-prefix v20.19.5 --silent`。

## 2. Codex CLI 登录与网络代理
- **WSL 里不能直接用 `127.0.0.1`**：WSL 的 localhost 指向子系统自身，要访问 Windows 的代理需使用 `vEthernet (WSL)` 网卡 IP（例如 `192.168.80.1`）。
- **v2rayN 一定要勾选“允许来自局域网连接”**：否则即使端口显示监听在 `0.0.0.0:10809`，WSL 连接也会被拒绝。
- **测试代理是否通畅**：
  ```bash
  curl -v --noproxy '*' http://192.168.80.1:10809     # 预期返回 400/404
  curl -v --socks5 192.168.80.1:10808 https://www.google.com
  ```
- **在 `~/.bashrc` 中持久化代理变量**：
  ```bash
  export WSL_HOST_IP="192.168.80.1"
  export http_proxy="http://${WSL_HOST_IP}:10809"
  export https_proxy="http://${WSL_HOST_IP}:10809"
  export ALL_PROXY="socks5://${WSL_HOST_IP}:10808"
  export no_proxy="localhost,127.0.0.1,::1"
  ```
  `source ~/.bashrc` 或新开终端后用 `env | grep proxy` 验证。
- **APT 走不了代理**：`sudo` 默认清空环境变量，可用 `sudo -E apt update`，或在 `/etc/apt/apt.conf.d/90proxy` 中写 `Acquire::http::Proxy`、`Acquire::https::Proxy`。

## 3. 在 Codex 里注册 chrome-devtools-mcp
- **全局安装 MCP server**：`npm install -g chrome-devtools-mcp`（需确保当前 shell 已 `nvm use 20`）。
- **添加到 Codex**：
  ```bash
  codex mcp add chrome-devtools-mcp chrome-devtools-mcp
  ```
  `~/.codex/config.toml` 会生成：
  ```toml
  [mcp_servers.chrome-devtools-mcp]
  command = "chrome-devtools-mcp"
  ```
- **命令名写错会导致 `command not found`**：若误写成 `chrome-devtools`，请 `codex mcp remove ...` 后用正确命令重加。
- **验证**：`codex mcp list` 应显示该条目 `enabled`，在 CLI 内 `/mcp` 也能看到。

## 4. Chrome 可执行文件与网络
- **默认路径 `/opt/google/chrome/chrome` 不存在**：需要在 WSL 安装 Chrome：
  ```bash
  sudo -E apt update
  sudo -E apt install google-chrome-stable
  google-chrome --version
  ```
- **可选方案**：也可以在 Windows 用 `--remote-debugging-port=9222` 启动 Chrome，然后在 Codex 配置中改用 `--browserUrl http://<宿主IP>:9222`。
- **显式传递 Chrome 可执行路径**：
  ```toml
  [mcp_servers.chrome-devtools-mcp]
  command = "chrome-devtools-mcp"
  args = ["--executablePath", "/usr/bin/google-chrome", "--headless"]
  ```
- **headless Chrome 无网络（`DNS_PROBE_FINISHED_BAD_CONFIG`）**：Chrome 不继承 shell 代理，需在 `args` 中加入代理参数：
  ```toml
  args = [
    "--executablePath", "/usr/bin/google-chrome",
    "--headless",
    "--proxy-server=http://192.168.80.1:10809"
  ]
  ```
  如果用 Socks，可改成 `--proxy-server=socks5://192.168.80.1:10808`。确认后 `navigate_page` / `take_snapshot` 才能看到真实页面。

## 5. Context7 MCP
- **不要寻找 `context7-mcp` 或 `@context7/mcp` 包**：npm registry 没有这两个名字。
- **正确配置方式**：Context7 提供的 server 通过 `npx @upstash/context7-mcp` 启动，配置示例：
  ```toml
  [mcp_servers.context7]
  command = "npx"
  args = ["-y", "@upstash/context7-mcp", "--api-key", "<Context7_API_Key>"]
  ```
  将 `<Context7_API_Key>` 替换为实际密钥，并确保代理允许访问 `registry.npmjs.org`。

## 6. 调试与验证清单
- `which google-chrome` / `google-chrome --version`：确认浏览器可执行文件。
- `codex mcp list`：确认每个 MCP `enabled`。
- 在 Codex CLI 中提示 “请调用 mcp_chrome-devtools_list_pages” 或 “请调用 mcp_chrome-devtools_take_snapshot” 观察工具输出。
- 登录时不再出现 `Token exchange failed`、`error sending request for url`，表示代理设置已生效。

> **总结**：确保 WSL 内部拥有独立的 Node 环境、稳定的代理、正确的 MCP 配置，以及可用的 Chrome executable，就能顺利让 Codex CLI 调用 chrome-devtools-mcp、context7 等工具完成前端相关任务。
