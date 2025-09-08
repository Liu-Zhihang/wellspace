# Shadow Map Frontend Test

## 📋 项目说明

这是Shadow Map项目的前端测试页面，用于验证后端API的功能和进行前端开发调试。

## 🚀 快速开始

### 1. 确保后端服务运行
```bash
cd ../shadow-map-backend
npm run dev
```

### 2. 打开测试页面
在浏览器中打开 `index.html` 文件，或通过Live Server扩展运行。

## 🧪 测试功能

### ✅ 已实现功能
- **地图基础显示** - 使用Leaflet显示OpenStreetMap
- **DEM瓦片集成** - 加载自定义DEM瓦片服务
- **后端状态检查** - 实时检测API服务状态
- **交互控件** - 时间选择、透明度调节等
- **API测试** - 一键测试后端接口

### 🔄 开发中功能
- **阴影模拟** - 集成leaflet-shadow-simulator
- **实时阴影更新** - 基于时间变化的阴影计算
- **建筑物数据** - 3D建筑物显示
- **用户交互优化** - 更丰富的地图交互

## 🌐 API端点

- **后端地址**: http://localhost:3001
- **健康检查**: `/api/health`
- **DEM瓦片**: `/api/dem/{z}/{x}/{y}.png`
- **DEM信息**: `/api/dem/info`

## 🎯 测试步骤

1. **后端连接测试**
   - 查看状态指示器是否为绿色
   - 点击"测试API"按钮

2. **地图功能测试**
   - 地图是否正常显示
   - 可以拖拽和缩放
   - DEM瓦片是否加载

3. **交互控件测试**
   - 时间选择器
   - 透明度滑块
   - 重置视图按钮

4. **DEM数据测试**
   - 点击地图查看位置信息
   - 调整DEM层透明度
   - 检查瓦片加载状态

## 🔧 开发注意事项

### CORS设置
后端已配置CORS允许前端访问：
```javascript
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));
```

### 浏览器安全限制
如果直接打开HTML文件，可能遇到CORS限制。建议：
1. 使用VS Code Live Server扩展
2. 或使用简单的HTTP服务器：
   ```bash
   python -m http.server 8000
   # 然后访问 http://localhost:8000
   ```

## 📝 下一步开发计划

1. **集成leaflet-shadow-simulator**
   ```bash
   npm install leaflet-shadow-simulator
   ```

2. **添加React组件化**
   ```bash
   npm create react-app shadow-map-react
   ```

3. **实现阴影计算**
   - 配置terrainSource指向自己的API
   - 添加时间控制功能
   - 实现实时阴影更新

4. **优化用户体验**
   - 加载状态提示
   - 错误处理
   - 响应式设计

## 🐛 故障排除

### DEM瓦片不显示
1. 检查后端服务是否运行 (npm run dev)
2. 检查控制台是否有CORS错误
3. 验证API端点是否正确响应

### 地图加载缓慢
1. 检查网络连接
2. 尝试更换地图瓦片源
3. 减少同时加载的图层数量

### API测试失败
1. 确认后端端口3001正确
2. 检查防火墙设置
3. 查看后端日志输出
