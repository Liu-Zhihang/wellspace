/**
 * TUM长期缓存管理器组件
 * 基于TUM数据4个月更新频率的缓存管理界面
 */

import React, { useState, useEffect, useCallback } from 'react';

// 缓存统计接口
interface CacheStats {
  totalGrids: number;
  tumDataGrids: number;
  osmDataGrids: number;
  hybridDataGrids: number;
  cacheHitRate: number;
  averageAge: number;
  storageSize: number;
}

// 缓存配置接口
interface CacheConfig {
  longTermTTL: number;
  mediumTermTTL: number;
  shortTermTTL: number;
  gridSize: number;
  maxGridCache: number;
  preloadRadius: number;
  preloadBatchSize: number;
  tumDataUpdateFrequency: string;
  description: string;
}

interface TUMCacheManagerProps {
  className?: string;
  isVisible: boolean;
  onClose: () => void;
}

export const TUMCacheManager: React.FC<TUMCacheManagerProps> = ({ 
  className = '', 
  isVisible, 
  onClose 
}) => {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [config, setConfig] = useState<CacheConfig | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [activeTab, setActiveTab] = useState<'stats' | 'preload' | 'config'>('stats');

  // 预加载表单状态
  const [preloadLat, setPreloadLat] = useState('39.9042');
  const [preloadLng, setPreloadLng] = useState('116.4074');
  const [preloadZoom, setPreloadZoom] = useState('15');

  // API调用基础URL
  const API_BASE = 'http://localhost:3500/api/tum-cache';

  // 获取缓存统计
  const fetchStats = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`${API_BASE}/stats`);
      const data = await response.json();
      
      if (data.success) {
        setStats(data.stats);
        setStatusMessage('统计信息已更新');
      } else {
        setStatusMessage(`获取统计失败: ${data.message}`);
      }
    } catch (error) {
      console.error('获取缓存统计失败:', error);
      setStatusMessage('获取统计信息失败，请检查后端连接');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 获取缓存配置
  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/config`);
      const data = await response.json();
      
      if (data.success) {
        setConfig(data.config);
      }
    } catch (error) {
      console.error('获取缓存配置失败:', error);
    }
  }, []);

  // 预加载指定位置
  const preloadLocation = async () => {
    try {
      setIsLoading(true);
      const lat = parseFloat(preloadLat);
      const lng = parseFloat(preloadLng);
      const zoom = parseInt(preloadZoom);

      if (isNaN(lat) || isNaN(lng) || isNaN(zoom)) {
        setStatusMessage('请输入有效的坐标和缩放级别');
        return;
      }

      const response = await fetch(`${API_BASE}/preload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng, zoom })
      });

      const data = await response.json();
      
      if (data.success) {
        setStatusMessage(`预加载已启动: (${lat}, ${lng})`);
        // 延迟刷新统计
        setTimeout(fetchStats, 2000);
      } else {
        setStatusMessage(`预加载失败: ${data.message}`);
      }
    } catch (error) {
      console.error('预加载失败:', error);
      setStatusMessage('预加载请求失败');
    } finally {
      setIsLoading(false);
    }
  };

  // 预加载热门位置
  const preloadPopularLocations = async () => {
    try {
      setIsLoading(true);
      const popularLocations = [
        { lat: 39.9042, lng: 116.4074 }, // 北京
        { lat: 31.2304, lng: 121.4737 }, // 上海
        { lat: 23.1291, lng: 113.3240 }, // 广州
        { lat: 22.5431, lng: 114.0579 }  // 深圳
      ];

      const response = await fetch(`${API_BASE}/batch-preload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: popularLocations, zoom: 15 })
      });

      const data = await response.json();
      
      if (data.success) {
        setStatusMessage('热门城市预加载已启动');
        setTimeout(fetchStats, 3000);
      } else {
        setStatusMessage(`批量预加载失败: ${data.message}`);
      }
    } catch (error) {
      console.error('批量预加载失败:', error);
      setStatusMessage('批量预加载请求失败');
    } finally {
      setIsLoading(false);
    }
  };

  // 清理过期缓存
  const cleanupExpiredCache = async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`${API_BASE}/cleanup`, {
        method: 'DELETE'
      });

      const data = await response.json();
      
      if (data.success) {
        setStatusMessage(`清理完成: 删除${data.cleanup.deletedCount}项，释放${data.cleanup.freedSize}MB`);
        fetchStats(); // 刷新统计
      } else {
        setStatusMessage(`清理失败: ${data.message}`);
      }
    } catch (error) {
      console.error('清理缓存失败:', error);
      setStatusMessage('清理操作失败');
    } finally {
      setIsLoading(false);
    }
  };

  // 初始化数据
  useEffect(() => {
    if (isVisible) {
      fetchStats();
      fetchConfig();
    }
  }, [isVisible, fetchStats, fetchConfig]);

  if (!isVisible) return null;

  return (
    <div className={`fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center ${className}`}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden">
        {/* 标题栏 */}
        <div className="bg-gradient-to-r from-blue-600 to-cyan-600 text-white px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold flex items-center">
                🗺️ TUM长期缓存管理器
              </h2>
              <p className="text-blue-100 text-sm mt-1">
                基于TUM数据4个月更新频率的智能缓存系统
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-white/80 hover:text-white text-2xl font-bold"
            >
              ×
            </button>
          </div>
        </div>

        {/* 标签页导航 */}
        <div className="bg-gray-50 px-6 py-3 border-b">
          <div className="flex space-x-1">
            {[
              { id: 'stats', label: '📊 缓存统计', icon: '📊' },
              { id: 'preload', label: '🔄 预加载管理', icon: '🔄' },
              { id: 'config', label: '⚙️ 配置信息', icon: '⚙️' }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-blue-100 text-blue-700'
                    : 'text-gray-600 hover:text-gray-800 hover:bg-gray-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* 内容区域 */}
        <div className="p-6 max-h-[60vh] overflow-y-auto">
          {/* 缓存统计标签页 */}
          {activeTab === 'stats' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-gray-800">缓存统计概览</h3>
                <button
                  onClick={fetchStats}
                  disabled={isLoading}
                  className="bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white px-4 py-2 rounded-lg text-sm"
                >
                  {isLoading ? '刷新中...' : '🔄 刷新'}
                </button>
              </div>

              {stats ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-gradient-to-br from-blue-50 to-blue-100 p-4 rounded-lg">
                    <div className="text-blue-600 text-sm font-medium">总网格数</div>
                    <div className="text-2xl font-bold text-blue-800">{stats.totalGrids}</div>
                  </div>
                  <div className="bg-gradient-to-br from-green-50 to-green-100 p-4 rounded-lg">
                    <div className="text-green-600 text-sm font-medium">TUM数据</div>
                    <div className="text-2xl font-bold text-green-800">{stats.tumDataGrids}</div>
                  </div>
                  <div className="bg-gradient-to-br from-yellow-50 to-yellow-100 p-4 rounded-lg">
                    <div className="text-yellow-600 text-sm font-medium">OSM数据</div>
                    <div className="text-2xl font-bold text-yellow-800">{stats.osmDataGrids}</div>
                  </div>
                  <div className="bg-gradient-to-br from-purple-50 to-purple-100 p-4 rounded-lg">
                    <div className="text-purple-600 text-sm font-medium">混合数据</div>
                    <div className="text-2xl font-bold text-purple-800">{stats.hybridDataGrids}</div>
                  </div>
                  <div className="bg-gradient-to-br from-cyan-50 to-cyan-100 p-4 rounded-lg">
                    <div className="text-cyan-600 text-sm font-medium">缓存命中率</div>
                    <div className="text-2xl font-bold text-cyan-800">{stats.cacheHitRate.toFixed(1)}%</div>
                  </div>
                  <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 p-4 rounded-lg">
                    <div className="text-indigo-600 text-sm font-medium">平均年龄</div>
                    <div className="text-2xl font-bold text-indigo-800">{stats.averageAge.toFixed(1)}天</div>
                  </div>
                  <div className="bg-gradient-to-br from-pink-50 to-pink-100 p-4 rounded-lg">
                    <div className="text-pink-600 text-sm font-medium">存储大小</div>
                    <div className="text-2xl font-bold text-pink-800">{stats.storageSize}MB</div>
                  </div>
                  <div className="bg-gradient-to-br from-red-50 to-red-100 p-4 rounded-lg">
                    <button
                      onClick={cleanupExpiredCache}
                      disabled={isLoading}
                      className="w-full h-full text-red-600 hover:text-red-800 font-medium"
                    >
                      🗑️ 清理过期
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  {isLoading ? '加载统计信息中...' : '点击刷新获取统计信息'}
                </div>
              )}
            </div>
          )}

          {/* 预加载管理标签页 */}
          {activeTab === 'preload' && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold text-gray-800">预加载管理</h3>
              
              {/* 指定位置预加载 */}
              <div className="bg-gray-50 p-4 rounded-lg">
                <h4 className="font-medium text-gray-800 mb-3">🎯 指定位置预加载</h4>
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">纬度</label>
                    <input
                      type="number"
                      value={preloadLat}
                      onChange={(e) => setPreloadLat(e.target.value)}
                      step="0.0001"
                      className="w-full px-3 py-2 border rounded-lg text-sm"
                      placeholder="39.9042"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">经度</label>
                    <input
                      type="number"
                      value={preloadLng}
                      onChange={(e) => setPreloadLng(e.target.value)}
                      step="0.0001"
                      className="w-full px-3 py-2 border rounded-lg text-sm"
                      placeholder="116.4074"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">缩放级别</label>
                    <input
                      type="number"
                      value={preloadZoom}
                      onChange={(e) => setPreloadZoom(e.target.value)}
                      min="1"
                      max="18"
                      className="w-full px-3 py-2 border rounded-lg text-sm"
                      placeholder="15"
                    />
                  </div>
                </div>
                <button
                  onClick={preloadLocation}
                  disabled={isLoading}
                  className="bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white px-4 py-2 rounded-lg text-sm"
                >
                  {isLoading ? '预加载中...' : '🔄 开始预加载'}
                </button>
              </div>

              {/* 热门位置批量预加载 */}
              <div className="bg-gray-50 p-4 rounded-lg">
                <h4 className="font-medium text-gray-800 mb-3">🏙️ 热门城市批量预加载</h4>
                <p className="text-sm text-gray-600 mb-3">
                  将预加载北京、上海、广州、深圳等热门城市的建筑数据
                </p>
                <button
                  onClick={preloadPopularLocations}
                  disabled={isLoading}
                  className="bg-green-500 hover:bg-green-600 disabled:bg-gray-400 text-white px-4 py-2 rounded-lg text-sm"
                >
                  {isLoading ? '批量预加载中...' : '🚀 批量预加载'}
                </button>
              </div>
            </div>
          )}

          {/* 配置信息标签页 */}
          {activeTab === 'config' && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold text-gray-800">缓存配置信息</h3>
              
              {config ? (
                <div className="space-y-4">
                  <div className="bg-blue-50 p-4 rounded-lg">
                    <h4 className="font-medium text-blue-800 mb-2">🕐 缓存时间配置</h4>
                    <div className="grid grid-cols-3 gap-4 text-sm">
                      <div>
                        <span className="text-blue-600">长期缓存:</span>
                        <span className="font-medium ml-2">{config.longTermTTL}天</span>
                      </div>
                      <div>
                        <span className="text-blue-600">中期缓存:</span>
                        <span className="font-medium ml-2">{config.mediumTermTTL}天</span>
                      </div>
                      <div>
                        <span className="text-blue-600">短期缓存:</span>
                        <span className="font-medium ml-2">{config.shortTermTTL}天</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-green-50 p-4 rounded-lg">
                    <h4 className="font-medium text-green-800 mb-2">📏 网格配置</h4>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-green-600">网格大小:</span>
                        <span className="font-medium ml-2">{config.gridSize}度</span>
                      </div>
                      <div>
                        <span className="text-green-600">最大缓存:</span>
                        <span className="font-medium ml-2">{config.maxGridCache}网格</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-purple-50 p-4 rounded-lg">
                    <h4 className="font-medium text-purple-800 mb-2">🔄 预加载配置</h4>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-purple-600">预加载半径:</span>
                        <span className="font-medium ml-2">{config.preloadRadius}网格</span>
                      </div>
                      <div>
                        <span className="text-purple-600">批次大小:</span>
                        <span className="font-medium ml-2">{config.preloadBatchSize}</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-yellow-50 p-4 rounded-lg">
                    <h4 className="font-medium text-yellow-800 mb-2">📅 TUM数据特性</h4>
                    <p className="text-sm text-yellow-700">
                      <span className="font-medium">更新频率:</span> {config.tumDataUpdateFrequency}
                    </p>
                    <p className="text-sm text-yellow-700 mt-2">
                      {config.description}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  加载配置信息中...
                </div>
              )}
            </div>
          )}
        </div>

        {/* 状态栏 */}
        {statusMessage && (
          <div className="bg-gray-100 px-6 py-3 border-t">
            <div className="flex items-center text-sm">
              <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
              <span className="text-gray-700">{statusMessage}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TUMCacheManager;



