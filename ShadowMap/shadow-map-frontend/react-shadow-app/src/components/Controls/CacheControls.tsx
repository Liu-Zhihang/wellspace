import React, { useState, useEffect } from 'react';
import { advancedCacheManager } from '../../services/advancedCacheManager';
import type { CacheStats } from '../../services/advancedCacheManager';
import { ApiService } from '../../services/apiService';
import { useShadowMapStore } from '../../store/shadowMapStore';

export const CacheControls: React.FC = () => {
  const [cacheStats, setCacheStats] = useState<CacheStats>({
    memorySize: 0,
    storageSize: 0,
    maxMemorySize: 0,
    maxStorageSize: 0,
    hitRate: 0,
    totalHits: 0,
    totalMisses: 0,
    memoryUsage: '0%',
  });
  const [isClearing, setIsClearing] = useState(false);
  const { addStatusMessage } = useShadowMapStore();

  // 获取缓存统计
  const updateCacheStats = async () => {
    try {
      const stats = await advancedCacheManager.getStats();
      setCacheStats(stats);
    } catch (error) {
      console.warn('获取缓存统计失败:', error);
    }
  };

  // 清理缓存
  const clearCache = async () => {
    setIsClearing(true);
    try {
      await advancedCacheManager.clear();
      addStatusMessage('缓存已清理', 'info');
      await updateCacheStats();
    } catch (error) {
      addStatusMessage(`清理缓存失败: ${error}`, 'error');
    } finally {
      setIsClearing(false);
    }
  };

  // 测试后端连接
  const testBackendConnection = async () => {
    try {
      const isHealthy = await ApiService.checkBackendHealth();
      if (isHealthy) {
        addStatusMessage('✅ 后端服务连接正常', 'info');
      } else {
        addStatusMessage('❌ 后端服务连接失败', 'error');
      }
    } catch (error) {
      addStatusMessage(`后端连接测试失败: ${error}`, 'error');
    }
  };

  useEffect(() => {
    updateCacheStats();
    const interval = setInterval(updateCacheStats, 30000); // 每30秒更新
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4">
      <h3 className="text-lg font-medium text-gray-800">系统状态</h3>

      {/* 网络状态 */}
      <div className="bg-blue-50 rounded-xl p-4 space-y-2">
        <h4 className="font-medium text-gray-700 flex items-center gap-2">
          🌐 网络状态
        </h4>
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600">连接状态:</span>
          <span className={`font-medium ${navigator.onLine ? 'text-green-600' : 'text-red-600'}`}>
            {navigator.onLine ? '✅ 在线' : '❌ 离线'}
          </span>
        </div>
        {(navigator as any).connection && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">连接类型:</span>
            <span className="font-medium text-blue-600">
              {(navigator as any).connection.effectiveType || '未知'}
            </span>
          </div>
        )}
      </div>

      {/* 缓存统计 */}
      <div className="bg-gray-50 rounded-xl p-4 space-y-3">
        <h4 className="font-medium text-gray-700 flex items-center gap-2">
          💾 缓存状态
        </h4>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="text-center">
            <div className="text-lg font-bold text-blue-600">
              {cacheStats.memorySize + cacheStats.storageSize}
            </div>
            <div className="text-gray-600">缓存项</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-green-600">{cacheStats.hitRate.toFixed(1)}%</div>
            <div className="text-gray-600">命中率</div>
          </div>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="space-y-2">
        <button
          onClick={clearCache}
          disabled={isClearing}
          className="w-full py-2.5 px-4 bg-red-50 hover:bg-red-100 text-red-700 rounded-lg transition-colors disabled:opacity-50"
        >
          {isClearing ? '清理中...' : '🗑️ 清理缓存'}
        </button>
        
        <button
          onClick={testBackendConnection}
          className="w-full py-2.5 px-4 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg transition-colors"
        >
          🔗 测试后端连接
        </button>
        
        <button
          onClick={updateCacheStats}
          className="w-full py-2.5 px-4 bg-gray-50 hover:bg-gray-100 text-gray-700 rounded-lg transition-colors"
        >
          🔄 刷新状态
        </button>
      </div>
    </div>
  );
};
