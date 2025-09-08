import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapComponent } from './components/Map/MapComponent';
import { TimeController } from './components/Controls/TimeController';
import { ShadowControls } from './components/Controls/ShadowControls';
import { CacheControls } from './components/Controls/CacheControls';
import { BaseMapSelector } from './components/Controls/BaseMapSelector';
import { AnalysisPanel } from './components/Analysis/AnalysisPanel';
import './App.css';

// 创建查询客户端
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5分钟
      gcTime: 10 * 60 * 1000, // 10分钟
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="h-screen flex flex-col bg-gray-100">
        {/* 头部 */}
        <header className="bg-white shadow-sm border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <h1 className="text-2xl font-bold text-gray-800">
                🌅 阴影地图分析系统
              </h1>
              <div className="flex items-center text-sm text-gray-600 bg-gray-100 px-3 py-1 rounded-full">
                <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
                系统正常运行
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-600">
                当前时间: {new Date().toLocaleString('zh-CN')}
              </span>
              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
                💡 点击地图分析阴影
              </span>
            </div>
          </div>
        </header>

        {/* 主内容区域 */}
        <main className="flex-1 flex overflow-hidden bg-gray-50">
          {/* 左侧控制面板 - 更窄更精简 */}
          <aside className="w-72 bg-gradient-to-b from-white to-gray-50 overflow-y-auto">
            <div className="p-4 space-y-4">
              <TimeController />
              <ShadowControls />
              <BaseMapSelector />
              <CacheControls />
            </div>
          </aside>

          {/* 中间地图区域 */}
          <section className="flex-1 relative">
            <MapComponent className="absolute inset-0" />
          </section>

          {/* 右侧分析面板 - 更窄更精简 */}
          <aside className="w-72 bg-gradient-to-b from-white to-gray-50 overflow-y-auto">
            <div className="p-4">
              <AnalysisPanel />
            </div>
          </aside>
        </main>

        {/* 底部状态栏 */}
        <footer className="bg-white border-t border-gray-200 px-6 py-2">
          <div className="flex items-center justify-between text-sm text-gray-600">
            <div className="flex items-center space-x-6">
              <span>🗺️ 基于 Leaflet 和 OpenStreetMap</span>
              <span>🏢 建筑数据来源: OSM Overpass API</span>
              <span>🌄 地形数据: AWS Terrarium Tiles</span>
              <span>☀️ 阴影模拟: leaflet-shadow-simulator</span>
            </div>
            <div>
              React 应用 v1.0.0 - 优先级1功能
            </div>
          </div>
        </footer>
      </div>
    </QueryClientProvider>
  );
}

export default App;
