/**
 * Shadow Calculation Optimization Strategy
 * 
 * 问题分析：
 * 1. mapbox-gl-shadow-simulator库每次都会重新计算阴影
 * 2. 当地图移动回之前的位置时，会重复计算
 * 3. 无法直接缓存库的内部渲染结果
 * 
 * 解决方案：
 * 1. 缓存策略：基于位置+时间的智能缓存键
 * 2. 避免重复初始化：检测相似区域和时间
 * 3. 优化计算触发：添加防抖和节流
 */

import { shadowCache } from '../utils/shadowCache';
import type mapboxgl from 'mapbox-gl';

interface ViewState {
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  zoom: number;
  center: {
    lng: number;
    lat: number;
  };
}

interface ShadowCalculationContext {
  viewState: ViewState;
  date: Date;
  buildingCount: number;
  timestamp: number;
}

/**
 * 阴影计算优化管理器
 */
export class ShadowCalculationOptimizer {
  private lastCalculation: ShadowCalculationContext | null = null;
  private calculationHistory: ShadowCalculationContext[] = [];
  private maxHistorySize = 20;
  private debounceTimer: number | null = null;
  private isCalculating = false;

  /**
   * 检查是否需要重新计算阴影
   * @returns true - 需要计算, false - 可以跳过
   */
  shouldRecalculate(
    map: mapboxgl.Map,
    date: Date,
    buildingCount: number
  ): {
    shouldCalculate: boolean;
    reason?: string;
    cachedContext?: ShadowCalculationContext;
  } {
    const currentView = this.extractViewState(map);

    // 首次计算
    if (!this.lastCalculation) {
      return {
        shouldCalculate: true,
        reason: '首次计算'
      };
    }

    // 检查缓存
    const cachedContext = this.findSimilarCalculation(currentView, date, buildingCount);
    if (cachedContext) {
      console.log('🎯 找到相似的阴影计算', {
        cached: {
          center: cachedContext.viewState.center,
          zoom: cachedContext.viewState.zoom,
          time: cachedContext.date.toLocaleTimeString()
        },
        current: {
          center: currentView.center,
          zoom: currentView.zoom,
          time: date.toLocaleTimeString()
        }
      });

      return {
        shouldCalculate: false,
        reason: '使用缓存的计算结果',
        cachedContext
      };
    }

    // 检查视图变化
    const viewChanged = this.hasSignificantViewChange(
      this.lastCalculation.viewState,
      currentView
    );

    if (!viewChanged) {
      // 检查时间变化
      const timeChanged = this.hasSignificantTimeChange(
        this.lastCalculation.date,
        date
      );

      if (!timeChanged) {
        return {
          shouldCalculate: false,
          reason: '视图和时间都没有显著变化'
        };
      }

      return {
        shouldCalculate: true,
        reason: '时间发生显著变化'
      };
    }

    return {
      shouldCalculate: true,
      reason: '视图发生显著变化'
    };
  }

  /**
   * 提取当前视图状态
   */
  private extractViewState(map: mapboxgl.Map): ViewState {
    const bounds = map.getBounds();
    const center = map.getCenter();
    const zoom = map.getZoom();

    return {
      bounds: {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest()
      },
      zoom,
      center: {
        lng: center.lng,
        lat: center.lat
      }
    };
  }

  /**
   * 检查视图是否有显著变化
   */
  private hasSignificantViewChange(
    oldView: ViewState,
    newView: ViewState
  ): boolean {
    // 缩放级别变化超过0.5
    if (Math.abs(oldView.zoom - newView.zoom) > 0.5) {
      return true;
    }

    // 中心点移动距离（简化计算）
    const centerMovement = Math.sqrt(
      Math.pow(newView.center.lng - oldView.center.lng, 2) +
      Math.pow(newView.center.lat - oldView.center.lat, 2)
    );

    // 根据缩放级别确定阈值
    const threshold = this.getMovementThreshold(newView.zoom);
    
    if (centerMovement > threshold) {
      console.log('📍 视图移动距离:', {
        movement: centerMovement.toFixed(6),
        threshold: threshold.toFixed(6),
        zoom: newView.zoom
      });
      return true;
    }

    return false;
  }

  /**
   * 根据缩放级别获取移动阈值
   */
  private getMovementThreshold(zoom: number): number {
    // 缩放级别越高，阈值越小（更敏感）
    if (zoom >= 18) return 0.0001;  // 约11米
    if (zoom >= 16) return 0.0005;  // 约55米
    if (zoom >= 14) return 0.001;   // 约111米
    if (zoom >= 12) return 0.005;   // 约555米
    return 0.01;                     // 约1.1公里
  }

  /**
   * 检查时间是否有显著变化
   */
  private hasSignificantTimeChange(oldDate: Date, newDate: Date): boolean {
    // 时间差异超过15分钟认为显著
    const timeDiff = Math.abs(newDate.getTime() - oldDate.getTime());
    const fifteenMinutes = 15 * 60 * 1000;

    return timeDiff > fifteenMinutes;
  }

  /**
   * 查找相似的计算记录
   */
  private findSimilarCalculation(
    currentView: ViewState,
    date: Date,
    buildingCount: number
  ): ShadowCalculationContext | null {
    // 按时间倒序查找（最近的优先）
    for (let i = this.calculationHistory.length - 1; i >= 0; i--) {
      const history = this.calculationHistory[i];

      // 检查建筑物数量是否相同（说明可能是同一区域）
      if (Math.abs(history.buildingCount - buildingCount) > 10) {
        continue;
      }

      // 检查视图相似性
      if (!this.hasSignificantViewChange(history.viewState, currentView)) {
        // 检查时间相似性
        if (!this.hasSignificantTimeChange(history.date, date)) {
          // 检查缓存是否过期（10分钟）
          const age = Date.now() - history.timestamp;
          if (age < 10 * 60 * 1000) {
            return history;
          }
        }
      }
    }

    return null;
  }

  /**
   * 记录计算
   */
  recordCalculation(
    map: mapboxgl.Map,
    date: Date,
    buildingCount: number
  ): void {
    const context: ShadowCalculationContext = {
      viewState: this.extractViewState(map),
      date: new Date(date),
      buildingCount,
      timestamp: Date.now()
    };

    this.lastCalculation = context;
    this.calculationHistory.push(context);

    // 限制历史记录大小
    if (this.calculationHistory.length > this.maxHistorySize) {
      this.calculationHistory.shift();
    }

    // 同时保存到shadowCache
    shadowCache.set(
      context.viewState.bounds,
      context.viewState.zoom,
      date,
      { calculated: true }
    );

    console.log('📝 记录阴影计算:', {
      historySize: this.calculationHistory.length,
      center: context.viewState.center,
      zoom: context.viewState.zoom,
      time: date.toLocaleTimeString(),
      buildings: buildingCount
    });
  }

  /**
   * 防抖执行阴影计算
   */
  debouncedCalculate(
    callback: () => void,
    delay: number = 500
  ): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      if (!this.isCalculating) {
        callback();
      }
    }, delay);
  }

  /**
   * 设置计算状态
   */
  setCalculating(isCalculating: boolean): void {
    this.isCalculating = isCalculating;
  }

  /**
   * 清空历史记录
   */
  clear(): void {
    this.lastCalculation = null;
    this.calculationHistory = [];
    console.log('🗑️ 清空阴影计算历史');
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      historySize: this.calculationHistory.length,
      lastCalculation: this.lastCalculation ? {
        time: this.lastCalculation.date.toLocaleString(),
        zoom: this.lastCalculation.viewState.zoom,
        center: this.lastCalculation.viewState.center,
        buildingCount: this.lastCalculation.buildingCount
      } : null,
      shadowCacheStats: shadowCache.getStats()
    };
  }
}

// 导出单例
export const shadowOptimizer = new ShadowCalculationOptimizer();
