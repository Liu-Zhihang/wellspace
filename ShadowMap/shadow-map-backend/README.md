# Shadow Map Backend

## 🚀 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
```bash
cp .env.example .env
# 根据需要修改 .env 文件中的配置
```

### 3. 启动开发服务器
```bash
npm run dev
```

### 4. 验证服务
打开浏览器访问：
- 健康检查: http://localhost:3001/api/health
- DEM服务信息: http://localhost:3001/api/dem/info
- 测试瓦片: http://localhost:3001/api/dem/10/512/384.png

## 📋 可用脚本

- `npm run dev` - 启动开发服务器 (带热重载)
- `npm run build` - 构建生产版本
- `npm start` - 启动生产服务器
- `npm test` - 运行测试 (暂未实现)

## 🛠️ API端点

### 健康检查
- `GET /api/health` - 基础健康检查
- `GET /api/health/detailed` - 详细系统信息 (仅开发环境)

### DEM瓦片服务
- `GET /api/dem/:z/:x/:y.png` - 获取DEM瓦片
- `GET /api/dem/info` - 获取DEM服务信息

### 使用示例
```javascript
// 在leaflet-shadow-simulator中使用
const terrainSource = {
  tileSize: 256,
  maxZoom: 15,
  getSourceUrl: ({ x, y, z }) => {
    return `http://localhost:3001/api/dem/${z}/${x}/${y}.png`;
  },
  getElevation: ({ r, g, b, a }) => {
    return (r * 256 + g + b / 256) - 32768;
  }
};
```

## 📁 项目结构

```
src/
├── app.ts              # Express应用配置
├── server.ts           # 服务器启动文件
├── routes/             # API路由
│   ├── health.ts       # 健康检查路由
│   └── dem.ts          # DEM瓦片路由
├── services/           # 业务逻辑服务
│   └── demService.ts   # DEM数据处理服务
└── utils/              # 工具函数
```

## 🔧 开发注意事项

### 当前状态 (MVP阶段)
- ✅ 基础Express服务器
- ✅ DEM瓦片服务 (模拟数据)
- ✅ 健康检查端点
- ✅ TypeScript配置
- ✅ 开发环境配置

### 下一步开发
- [ ] 集成Sharp库进行真正的PNG编码
- [ ] 实现真实DEM数据获取
- [ ] 添加Redis缓存
- [ ] 数据库集成
- [ ] 错误处理优化
- [ ] 单元测试

### 性能优化 TODO
- [ ] 实现瓦片缓存机制
- [ ] 添加压缩中间件
- [ ] 优化内存使用
- [ ] 添加请求限制

## 🐛 已知问题

1. 当前DEM服务返回的是测试数据，不是真正的PNG格式
2. 需要集成图像处理库 (Sharp) 进行真正的PNG编码
3. 缓存机制尚未实现

## 📚 相关资源

- [Leaflet Shadow Simulator](https://www.npmjs.com/package/leaflet-shadow-simulator)
- [Terrarium格式说明](https://github.com/tilezen/joerd/blob/master/docs/formats.md#terrarium)
- [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
