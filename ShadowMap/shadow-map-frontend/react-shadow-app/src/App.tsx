import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { useState } from 'react';
import { MapComponent } from './components/Map/MapComponent';
import { TimeController } from './components/Controls/TimeController';
import { ShadowControls } from './components/Controls/ShadowControls';
import { CacheControls } from './components/Controls/CacheControls';
import { BaseMapSelector } from './components/Controls/BaseMapSelector';
import { DataLayerSelector } from './components/Controls/DataLayerSelector';
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
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(256); // 默认256px
  const [rightPanelWidth, setRightPanelWidth] = useState(256); // 默认256px
  const [isDragging, setIsDragging] = useState<'left' | 'right' | null>(null);

  // 处理拖拽开始
  const handleMouseDown = (panel: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(panel);
  };

  // 处理拖拽移动
  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;

    const containerWidth = window.innerWidth;
    
    if (isDragging === 'left') {
      const newWidth = Math.max(200, Math.min(400, e.clientX));
      setLeftPanelWidth(newWidth);
    } else if (isDragging === 'right') {
      const newWidth = Math.max(200, Math.min(400, containerWidth - e.clientX));
      setRightPanelWidth(newWidth);
    }
  };

  // 处理拖拽结束
  const handleMouseUp = () => {
    setIsDragging(null);
  };

  // 添加全局鼠标事件监听
  React.useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging]);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="h-screen flex flex-col bg-gray-100">
        {/* 头部 - 更紧凑 */}
        <header className="bg-white shadow-sm border-b border-gray-200 px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <h1 className="text-xl font-bold text-gray-800">
                🌅 阴影地图分析
              </h1>
              <div className="flex items-center text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded">
                <div className="w-1.5 h-1.5 bg-green-500 rounded-full mr-1"></div>
                运行中
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <span className="text-xs text-gray-500">
                {new Date().toLocaleTimeString('zh-CN')}
              </span>
              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
                💡 点击分析
              </span>
            </div>
          </div>
        </header>

        {/* 主内容区域 */}
        <main className="flex-1 flex overflow-hidden bg-gray-50">
          {/* 左侧控制面板 - 可折叠可拖拽 */}
          <aside 
            className="bg-gradient-to-b from-white to-gray-50 transition-all duration-300 ease-in-out overflow-hidden relative"
            style={{ width: leftPanelCollapsed ? '48px' : `${leftPanelWidth}px` }}
          >
            {/* 折叠按钮 */}
            <div className="p-2 border-b border-gray-200">
              <button
                onClick={() => setLeftPanelCollapsed(!leftPanelCollapsed)}
                className="w-full p-2 text-gray-600 hover:bg-gray-100 rounded transition-colors"
                title={leftPanelCollapsed ? "展开控制面板" : "折叠控制面板"}
              >
                {leftPanelCollapsed ? '⏵' : '⏴'} {!leftPanelCollapsed && '控制'}
              </button>
            </div>
            
            {!leftPanelCollapsed && (
              <div className="p-3 space-y-3 overflow-y-auto">
                <TimeController />
                <DataLayerSelector />
                <BaseMapSelector />
                <CacheControls />
              </div>
            )}

            {/* 右侧拖拽手柄 */}
            {!leftPanelCollapsed && (
              <div
                className="absolute top-0 right-0 w-1 h-full bg-gray-300 hover:bg-blue-400 cursor-col-resize transition-colors"
                onMouseDown={handleMouseDown('left')}
                title="拖拽调整面板宽度"
              />
            )}
          </aside>

          {/* 中间地图区域 - 最大化 */}
          <section className="flex-1 relative">
            <MapComponent className="absolute inset-0" />
          </section>

          {/* 右侧分析面板 - 可折叠可拖拽 */}
          <aside 
            className="bg-gradient-to-b from-white to-gray-50 transition-all duration-300 ease-in-out overflow-hidden relative"
            style={{ width: rightPanelCollapsed ? '48px' : `${rightPanelWidth}px` }}
          >
            {/* 左侧拖拽手柄 */}
            {!rightPanelCollapsed && (
              <div
                className="absolute top-0 left-0 w-1 h-full bg-gray-300 hover:bg-blue-400 cursor-col-resize transition-colors"
                onMouseDown={handleMouseDown('right')}
                title="拖拽调整面板宽度"
              />
            )}

            {/* 折叠按钮 */}
            <div className="p-2 border-b border-gray-200">
              <button
                onClick={() => setRightPanelCollapsed(!rightPanelCollapsed)}
                className="w-full p-2 text-gray-600 hover:bg-gray-100 rounded transition-colors"
                title={rightPanelCollapsed ? "展开分析面板" : "折叠分析面板"}
              >
                {rightPanelCollapsed ? '⏴' : '⏵'} {!rightPanelCollapsed && '分析'}
              </button>
            </div>
            
            {!rightPanelCollapsed && (
              <div className="p-3 overflow-y-auto">
                <AnalysisPanel />
              </div>
            )}
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
