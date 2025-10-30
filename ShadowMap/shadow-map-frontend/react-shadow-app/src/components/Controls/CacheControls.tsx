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

  // Fetch cache statistics
  const updateCacheStats = async () => {
    try {
      const stats = await advancedCacheManager.getStats();
      setCacheStats(stats);
    } catch (error) {
      console.warn('Failed to fetch cache stats:', error);
    }
  };

  // Clear cache
  const clearCache = async () => {
    setIsClearing(true);
    try {
      await advancedCacheManager.clear();
      addStatusMessage('Cache cleared', 'info');
      await updateCacheStats();
    } catch (error) {
      addStatusMessage(`Failed to clear cache: ${error}`, 'error');
    } finally {
      setIsClearing(false);
    }
  };

  // Test backend connection
  const testBackendConnection = async () => {
    try {
      const isHealthy = await ApiService.checkBackendHealth();
      if (isHealthy) {
        addStatusMessage('✅ Backend reachable', 'info');
      } else {
        addStatusMessage('❌ Backend unreachable', 'error');
      }
    } catch (error) {
      addStatusMessage(`Backend connectivity test failed: ${error}`, 'error');
    }
  };

  useEffect(() => {
    updateCacheStats();
    const interval = setInterval(updateCacheStats, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4">
      <h3 className="text-lg font-medium text-gray-800">System status</h3>

      {/* Network status */}
      <div className="bg-blue-50 rounded-xl p-4 space-y-2">
        <h4 className="font-medium text-gray-700 flex items-center gap-2">
          🌐 Network status
        </h4>
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600">Connection status:</span>
          <span className={`font-medium ${navigator.onLine ? 'text-green-600' : 'text-red-600'}`}>
            {navigator.onLine ? '✅ Online' : '❌ Offline'}
          </span>
        </div>
        {(navigator as any).connection && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">Connection type:</span>
            <span className="font-medium text-blue-600">
              {(navigator as any).connection.effectiveType || 'unknown'}
            </span>
          </div>
        )}
      </div>

      {/* Cache stats */}
      <div className="bg-gray-50 rounded-xl p-4 space-y-3">
        <h4 className="font-medium text-gray-700 flex items-center gap-2">
          💾 Cache metrics
        </h4>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="text-center">
            <div className="text-lg font-bold text-blue-600">
              {cacheStats.memorySize + cacheStats.storageSize}
            </div>
            <div className="text-gray-600">Entries</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-green-600">{cacheStats.hitRate.toFixed(1)}%</div>
            <div className="text-gray-600">Hit rate</div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="space-y-2">
        <button
          onClick={clearCache}
          disabled={isClearing}
          className="w-full py-2.5 px-4 bg-red-50 hover:bg-red-100 text-red-700 rounded-lg transition-colors disabled:opacity-50"
        >
          {isClearing ? 'Clearing…' : '🗑️ Clear cache'}
        </button>
        
        <button
          onClick={testBackendConnection}
          className="w-full py-2.5 px-4 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg transition-colors"
        >
          🔗 Test backend connection
        </button>
        
        <button
          onClick={updateCacheStats}
          className="w-full py-2.5 px-4 bg-gray-50 hover:bg-gray-100 text-gray-700 rounded-lg transition-colors"
        >
          🔄 Refresh status
        </button>
      </div>
    </div>
  );
};
