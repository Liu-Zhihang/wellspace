import { useCallback, useRef, useEffect } from 'react';

interface ShadowUpdateOptions {
  moveDelay?: number;      // 地图移动延迟
  zoomDelay?: number;      // 缩放延迟
  timeDelay?: number;      // 时间变化延迟
  minZoom?: number;        // 最小缩放级别
}

/**
 * 智能阴影更新Hook - 解决计算频率过高问题
 */
export function useSmartShadowUpdate(
  updateFunction: () => void,
  options: ShadowUpdateOptions = {}
) {
  const {
    moveDelay = 300,
    zoomDelay = 500,
    timeDelay = 100,
    minZoom = 15
  } = options;

  const updateTimeoutRef = useRef<number | null>(null);
  const isInteractingRef = useRef(false);
  const lastUpdateRef = useRef({ center: '', zoom: 0, time: 0 });

  // 清理定时器
  const clearUpdateTimeout = useCallback(() => {
    if (updateTimeoutRef.current !== null) {
      window.clearTimeout(updateTimeoutRef.current);
      updateTimeoutRef.current = null;
    }
  }, []);

  // 智能更新函数
  const smartUpdate = useCallback((
    type: 'move' | 'zoom' | 'time',
    currentZoom: number,
    center?: { lat: number; lng: number },
    currentTime?: number
  ) => {
    // 检查缩放级别
    if (currentZoom < minZoom) {
      console.log(`⏸️ 缩放级别 ${currentZoom.toFixed(1)} 过低，跳过阴影计算`);
      return;
    }

    // 生成缓存键
    const cacheKey = center ? `${center.lat.toFixed(3)},${center.lng.toFixed(3)}` : '';
    const timeKey = currentTime || Date.now();
    
    // 检查是否需要更新
    const lastUpdate = lastUpdateRef.current;
    if (type === 'move' && 
        lastUpdate.center === cacheKey && 
        Math.abs(lastUpdate.zoom - currentZoom) < 0.5) {
      console.log('📍 相同区域，跳过更新');
      return;
    }

    if (type === 'time' && 
        Math.abs(timeKey - lastUpdate.time) < 30000) { // 30秒内
      console.log('⏰ 时间变化较小，跳过更新');
      return;
    }

    // 清理之前的定时器
    clearUpdateTimeout();

    // 根据交互类型设置延迟
    let delay = moveDelay;
    if (type === 'zoom') delay = zoomDelay;
    if (type === 'time') delay = timeDelay;

    console.log(`🔄 安排阴影更新 (${type}, 延迟: ${delay}ms)`);

    updateTimeoutRef.current = window.setTimeout(() => {
      updateTimeoutRef.current = null;
      console.log(`✅ 执行阴影更新 (${type})`);
      
      // 更新缓存
      lastUpdateRef.current = {
        center: cacheKey,
        zoom: currentZoom,
        time: timeKey
      };
      
      updateFunction();
      isInteractingRef.current = false;
    }, delay);

    isInteractingRef.current = true;
  }, [updateFunction, moveDelay, zoomDelay, timeDelay, minZoom, clearUpdateTimeout]);

  // 地图移动更新
  const onMapMove = useCallback((zoom: number, center: { lat: number; lng: number }) => {
    smartUpdate('move', zoom, center);
  }, [smartUpdate]);

  // 缩放更新
  const onMapZoom = useCallback((zoom: number, center: { lat: number; lng: number }) => {
    smartUpdate('zoom', zoom, center);
  }, [smartUpdate]);

  // 时间更新
  const onTimeChange = useCallback((zoom: number, time: number) => {
    smartUpdate('time', zoom, undefined, time);
  }, [smartUpdate]);

  // 立即更新（用于手动触发）
  const immediateUpdate = useCallback(() => {
    clearUpdateTimeout();
    console.log('⚡ 立即执行阴影更新');
    updateFunction();
    isInteractingRef.current = false;
  }, [updateFunction, clearUpdateTimeout]);

  // 清理
  useEffect(() => {
    return () => {
      clearUpdateTimeout();
    };
  }, [clearUpdateTimeout]);

  return {
    onMapMove,
    onMapZoom,
    onTimeChange,
    immediateUpdate,
    isInteracting: () => isInteractingRef.current
  };
}
