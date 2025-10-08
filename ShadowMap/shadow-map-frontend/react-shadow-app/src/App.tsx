import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { useState } from 'react';
import { MapComponent } from './components/Map/MapComponent';
import { MapboxMapComponent } from './components/Map/MapboxMapComponent';
import { TUM3DShadowMapFixed } from './components/Map/TUM3DShadowMapFixed';
import { CleanShadowMap } from './components/Map/CleanShadowMap';
import { ReferenceInspiredSearch } from './components/UI/ReferenceInspiredSearch';
import { ReferenceInspiredControls } from './components/UI/ReferenceInspiredControls';
import { ReferenceInspiredTimeline } from './components/UI/ReferenceInspiredTimeline';
import { BackendStatusChecker } from './components/UI/BackendStatusChecker';
import { SimpleControlPanel } from './components/UI/SimpleControlPanel';
import { CleanControlPanel } from './components/UI/CleanControlPanel';
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
  const [mapMode, setMapMode] = useState<'mapbox' | 'leaflet' | 'tum3d' | 'clean'>('clean'); // 切换地图引擎

  return (
    <QueryClientProvider client={queryClient}>
      <div className="h-screen w-screen relative bg-gray-900 overflow-hidden">
        {/* 顶部简洁标题栏 */}
        <header className="absolute top-4 left-4 z-40">
          <div className="bg-white/90 backdrop-blur-md rounded-xl shadow-lg border border-white/20 px-4 py-2">
            <div className="flex items-center space-x-3">
              <h1 className="text-lg font-bold text-gray-800">
                🌅 Shadow Map Analysis
              </h1>
              <div className="flex items-center text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded">
                <div className="w-1.5 h-1.5 bg-green-500 rounded-full mr-1"></div>
                {mapMode === 'clean' ? 'Clean 3D' : mapMode === 'tum3d' ? 'TUM 3D' : mapMode === 'mapbox' ? 'Mapbox GL' : 'Leaflet'}
              </div>
              {/* 地图引擎切换 */}
              <div className="flex space-x-1">
                <button
                  onClick={() => setMapMode('clean')}
                  className={`text-xs px-2 py-1 rounded transition-colors ${
                    mapMode === 'clean' 
                      ? 'bg-green-100 text-green-700' 
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Clean 3D
                </button>
                <button
                  onClick={() => setMapMode('tum3d')}
                  className={`text-xs px-2 py-1 rounded transition-colors ${
                    mapMode === 'tum3d' 
                      ? 'bg-green-100 text-green-700' 
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  TUM 3D
                </button>
                <button
                  onClick={() => setMapMode('mapbox')}
                  className={`text-xs px-2 py-1 rounded transition-colors ${
                    mapMode === 'mapbox' 
                      ? 'bg-blue-100 text-blue-700' 
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Mapbox
                </button>
                <button
                  onClick={() => setMapMode('leaflet')}
                  className={`text-xs px-2 py-1 rounded transition-colors ${
                    mapMode === 'leaflet' 
                      ? 'bg-purple-100 text-purple-700' 
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Leaflet
                </button>
              </div>
            </div>
          </div>
        </header>

        {/* 全屏地图 */}
        <main className="absolute inset-0">
          {mapMode === 'clean' ? (
            <CleanShadowMap className="w-full h-full" />
          ) : mapMode === 'tum3d' ? (
            <TUM3DShadowMapFixed className="w-full h-full" />
          ) : mapMode === 'mapbox' ? (
            <MapboxMapComponent className="w-full h-full" />
          ) : (
            <MapComponent className="w-full h-full" />
          )}
        </main>

        {/* 根据地图模式显示不同的UI组件 */}
        {mapMode === 'clean' ? (
          <CleanControlPanel />
        ) : (
          <>
            <BackendStatusChecker />
            <SimpleControlPanel />
            <ReferenceInspiredSearch />
            <ReferenceInspiredControls />
            <ReferenceInspiredTimeline />
          </>
        )}
      </div>
    </QueryClientProvider>
  );
}

export default App;
