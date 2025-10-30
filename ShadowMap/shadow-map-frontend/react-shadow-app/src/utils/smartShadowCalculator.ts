/**
 */

interface CalculationContext {
  bounds: { north: number; south: number; east: number; west: number };
  zoom: number;
  date: Date;
  cacheKey: string;
}

interface CalculationThrottleOptions {
  moveDelay: number;
  zoomDelay: number;
  dateDelay: number;
  minMovement: number;
  minZoomChange: number;
  maxCalculationInterval: number;
}

export class SmartShadowCalculator {
  private debounceTimers = new Map<string, number>();
  private lastCalculation: CalculationContext | null = null;
  private lastCalculationTime = 0;
  private isCalculating = false;
  private pendingCalculation: CalculationContext | null = null;
  private calculateFunction: (context: CalculationContext) => Promise<void>;
  
  private readonly options: CalculationThrottleOptions = {
    moveDelay: 800,
    zoomDelay: 500,
    dateDelay: 300,
    minMovement: 0.001,
    minZoomChange: 0.2,
    maxCalculationInterval: 30000
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

    if (this.isCalculating) {
      this.pendingCalculation = context;
      return;
    }

    if (trigger === 'force') {
      this.performCalculation(context, '');
      return;
    }

    const shouldCalculate = this.shouldPerformCalculation(context, trigger);
    if (!shouldCalculate.should) {
      return;
    }

    const delay = this.getDebounceDelay(trigger);
    const timerKey = `${trigger}_calculation`;
    
    if (this.debounceTimers.has(timerKey)) {
      const existingTimer = this.debounceTimers.get(timerKey);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }
    }

    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(timerKey);
      this.performCalculation(context, `${trigger}`);
    }, delay);

    this.debounceTimers.set(timerKey, timer);
  }

  /**
   */
  private async performCalculation(context: CalculationContext, _reason: string): Promise<void> {
    if (this.isCalculating) {
      return;
    }

    this.isCalculating = true;
    try {
      
      await this.calculateFunction(context);
      
      this.lastCalculation = context;
      this.lastCalculationTime = Date.now();
    } catch (error) {
    } finally {
      this.isCalculating = false;
      
      if (this.pendingCalculation) {
        const pending = this.pendingCalculation;
        this.pendingCalculation = null;
        
        setTimeout(() => {
          this.performCalculation(pending, '');
        }, 100);
      }
    }
  }

  /**
   */
  private shouldPerformCalculation(
    context: CalculationContext, 
    trigger: 'move' | 'zoom' | 'date'
  ): { should: boolean; reason: string } {
    const timeSinceLastCalculation = Date.now() - this.lastCalculationTime;
    if (timeSinceLastCalculation > this.options.maxCalculationInterval) {
      return { should: true, reason: 'interval expired' };
    }

    if (!this.lastCalculation) {
      return { should: true, reason: 'first calculation' };
    }

    const last = this.lastCalculation;

    if (context.cacheKey === last.cacheKey) {
      return { should: false, reason: 'cache key unchanged' };
    }

    switch (trigger) {
      case 'move':
        const movement = this.calculateBoundsDistance(context.bounds, last.bounds);
        if (movement < this.options.minMovement) {
          return { should: false, reason: `movement too small (${movement.toFixed(6)})` };
        }
        break;

      case 'zoom':
        const zoomChange = Math.abs(context.zoom - last.zoom);
        if (zoomChange < this.options.minZoomChange) {
          return { should: false, reason: `zoom delta ${zoomChange.toFixed(2)} below threshold` };
        }
        break;

      case 'date':
        const timeDiff = Math.abs(context.date.getTime() - last.date.getTime());
        if (timeDiff < 60000) {
          return { should: false, reason: `time delta ${timeDiff}ms below threshold` };
        }
        break;
    }

    return { should: true, reason: `${trigger}` };
  }

  /**
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
   */
  private generateCacheKey(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number,
    date: Date
  ): string {
    const precision = 1000;
    const datePrecision = 60 * 1000;
    
    return [
      Math.round(bounds.north * precision),
      Math.round(bounds.south * precision),
      Math.round(bounds.east * precision),
      Math.round(bounds.west * precision),
      Math.floor(zoom * 10),
      Math.floor(date.getTime() / datePrecision)
    ].join('_');
  }

  /**
   */
  forceCalculation(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number,
    date: Date
  ): void {
    this.requestCalculation(bounds, zoom, date, 'force');
  }

  /**
   */
  cancelPending(): void {
    this.debounceTimers.forEach(timer => window.clearTimeout(timer));
    this.debounceTimers.clear();
    this.pendingCalculation = null;
  }

  /**
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
   */
  destroy(): void {
    this.cancelPending();
    this.lastCalculation = null;
    this.pendingCalculation = null;
    this.isCalculating = false;
  }
}
