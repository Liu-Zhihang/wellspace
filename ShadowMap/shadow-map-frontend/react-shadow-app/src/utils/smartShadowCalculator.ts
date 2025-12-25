/**
 * 智能阴影计算管理器
 * 解决阴影计算频率过高的问题
 */

interface CalculationContext {
  bounds: { north: number; south: number; east: number; west: number };
  zoom: number;
  date: Date;
  cacheKey: string;
}

interface CalculationThrottleOptions {
  moveDelay: number;      // 地图移动防抖延迟
  zoomDelay: number;      // 缩放防抖延迟  
  dateDelay: number;      // 时间变化防抖延迟
  minMovement: number;    // 最小移动距离阈值
  minZoomChange: number;  // 最小缩放变化阈值
  maxCalculationInterval: number; // 最大计算间隔（强制刷新）
}

export class SmartShadowCalculator {
  private debounceTimers = new Map<string, number>();
  private lastCalculation: CalculationContext | null = null;
  private lastCalculationTime = 0;
  private isCalculating = false;
  private pendingCalculation: CalculationContext | null = null;
  private calculateFunction: (context: CalculationContext) => Promise<void>;
  
  private readonly options: CalculationThrottleOptions = {
    moveDelay: 800,           // 地图移动停止后800ms才计算
    zoomDelay: 500,           // 缩放停止后500ms才计算  
    dateDelay: 300,           // 时间变化后300ms才计算
    minMovement: 0.001,       // 最小移动0.001度才触发
    minZoomChange: 0.2,       // 最小缩放变化0.2级才触发
    maxCalculationInterval: 30000 // 30秒强制刷新一次
  };

  constructor(
    calculateFunction: (context: CalculationContext) => Promise<void>,
    options?: Partial<CalculationThrottleOptions>
  ) {
    this.calculateFunction = calculateFunction;
    if (options) {
      this.options = { ...this.options, ...options };
    }
  }

  /**
   * 请求阴影计算（智能节流）
   */
  requestCalculation(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number,
    date: Date,
    trigger: 'move' | 'zoom' | 'date' | 'force' = 'move'
  ): void {
    const context: CalculationContext = {
      bounds,
      zoom,
      date,
      cacheKey: this.generateCacheKey(bounds, zoom, date)
    };

    // 1. 如果正在计算，记录待处理请求
    if (this.isCalculating) {
      this.pendingCalculation = context;
      console.log('🔄 阴影计算中，记录待处理请求');
      return;
    }

    // 2. 强制计算（忽略所有限制）
    if (trigger === 'force') {
      this.performCalculation(context, '强制计算');
      return;
    }

    // 3. 检查是否需要计算
    const shouldCalculate = this.shouldPerformCalculation(context, trigger);
    if (!shouldCalculate.should) {
      console.log(`⏸️ 跳过阴影计算: ${shouldCalculate.reason}`);
      return;
    }

    // 4. 应用防抖延迟
    const delay = this.getDebounceDelay(trigger);
    const timerKey = `${trigger}_calculation`;
    
    // 清除现有定时器
    if (this.debounceTimers.has(timerKey)) {
      const existingTimer = this.debounceTimers.get(timerKey);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }
    }

    // 设置新的防抖定时器
    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(timerKey);
      this.performCalculation(context, `${trigger}触发`);
    }, delay);

    this.debounceTimers.set(timerKey, timer);
    console.log(`⏳ ${trigger}防抖计时器设置: ${delay}ms`);
  }

  /**
   * 执行阴影计算
   */
  private async performCalculation(context: CalculationContext, reason: string): Promise<void> {
    if (this.isCalculating) {
      console.log('⚠️ 阴影计算已在进行中，跳过');
      return;
    }

    this.isCalculating = true;
    const startTime = performance.now();
    
    try {
      console.log(`🌅 开始阴影计算 (${reason})`);
      
      await this.calculateFunction(context);
      
      // 更新计算历史
      this.lastCalculation = context;
      this.lastCalculationTime = Date.now();
      
      const duration = performance.now() - startTime;
      console.log(`✅ 阴影计算完成: ${duration.toFixed(0)}ms (${reason})`);
      
    } catch (error) {
      console.error('❌ 阴影计算失败:', error);
    } finally {
      this.isCalculating = false;
      
      // 处理待处理的计算请求
      if (this.pendingCalculation) {
        const pending = this.pendingCalculation;
        this.pendingCalculation = null;
        
        console.log('🔄 执行待处理的阴影计算');
        setTimeout(() => {
          this.performCalculation(pending, '待处理请求');
        }, 100);
      }
    }
  }

  /**
   * 检查是否应该执行计算
   */
  private shouldPerformCalculation(
    context: CalculationContext, 
    trigger: 'move' | 'zoom' | 'date'
  ): { should: boolean; reason: string } {
    // 1. 检查最大间隔强制刷新
    const timeSinceLastCalculation = Date.now() - this.lastCalculationTime;
    if (timeSinceLastCalculation > this.options.maxCalculationInterval) {
      return { should: true, reason: '强制刷新（超过最大间隔）' };
    }

    // 2. 首次计算
    if (!this.lastCalculation) {
      return { should: true, reason: '首次计算' };
    }

    const last = this.lastCalculation;

    // 3. 检查缓存键变化（快速判断）
    if (context.cacheKey === last.cacheKey) {
      return { should: false, reason: '缓存键相同' };
    }

    // 4. 检查具体变化类型
    switch (trigger) {
      case 'move':
        const movement = this.calculateBoundsDistance(context.bounds, last.bounds);
        if (movement < this.options.minMovement) {
          return { should: false, reason: `移动距离太小 (${movement.toFixed(6)})` };
        }
        break;

      case 'zoom':
        const zoomChange = Math.abs(context.zoom - last.zoom);
        if (zoomChange < this.options.minZoomChange) {
          return { should: false, reason: `缩放变化太小 (${zoomChange.toFixed(2)})` };
        }
        break;

      case 'date':
        const timeDiff = Math.abs(context.date.getTime() - last.date.getTime());
        if (timeDiff < 60000) { // 1分钟内的时间变化忽略
          return { should: false, reason: `时间变化太小 (${timeDiff}ms)` };
        }
        break;
    }

    return { should: true, reason: `${trigger}变化超过阈值` };
  }

  /**
   * 计算边界框距离
   */
  private calculateBoundsDistance(
    bounds1: { north: number; south: number; east: number; west: number },
    bounds2: { north: number; south: number; east: number; west: number }
  ): number {
    const centerLat1 = (bounds1.north + bounds1.south) / 2;
    const centerLng1 = (bounds1.east + bounds1.west) / 2;
    const centerLat2 = (bounds2.north + bounds2.south) / 2;
    const centerLng2 = (bounds2.east + bounds2.west) / 2;
    
    return Math.sqrt(
      Math.pow(centerLat1 - centerLat2, 2) + 
      Math.pow(centerLng1 - centerLng2, 2)
    );
  }

  /**
   * 获取防抖延迟
   */
  private getDebounceDelay(trigger: 'move' | 'zoom' | 'date'): number {
    switch (trigger) {
      case 'move': return this.options.moveDelay;
      case 'zoom': return this.options.zoomDelay;
      case 'date': return this.options.dateDelay;
      default: return this.options.moveDelay;
    }
  }

  /**
   * 生成缓存键
   */
  private generateCacheKey(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number,
    date: Date
  ): string {
    const precision = 1000;
    const datePrecision = 60 * 1000; // 1分钟精度
    
    return [
      Math.round(bounds.north * precision),
      Math.round(bounds.south * precision),
      Math.round(bounds.east * precision),
      Math.round(bounds.west * precision),
      Math.floor(zoom * 10), // 0.1级精度
      Math.floor(date.getTime() / datePrecision)
    ].join('_');
  }

  /**
   * 强制执行计算
   */
  forceCalculation(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number,
    date: Date
  ): void {
    this.requestCalculation(bounds, zoom, date, 'force');
  }

  /**
   * 取消所有待处理的计算
   */
  cancelPending(): void {
    this.debounceTimers.forEach(timer => window.clearTimeout(timer));
    this.debounceTimers.clear();
    this.pendingCalculation = null;
    console.log('🚫 取消所有待处理的阴影计算');
  }

  /**
   * 获取计算统计
   */
  getStats(): {
    isCalculating: boolean;
    pendingCalculations: number;
    lastCalculationTime: number;
    timeSinceLastCalculation: number;
  } {
    return {
      isCalculating: this.isCalculating,
      pendingCalculations: this.debounceTimers.size + (this.pendingCalculation ? 1 : 0),
      lastCalculationTime: this.lastCalculationTime,
      timeSinceLastCalculation: Date.now() - this.lastCalculationTime
    };
  }

  /**
   * 销毁计算器
   */
  destroy(): void {
    this.cancelPending();
    this.lastCalculation = null;
    this.pendingCalculation = null;
    this.isCalculating = false;
  }
}
