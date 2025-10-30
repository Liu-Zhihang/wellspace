/**
 * Shadow Calculation Optimization Strategy
 * 
 * 
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
 */
export class ShadowCalculationOptimizer {
  private lastCalculation: ShadowCalculationContext | null = null;
  private calculationHistory: ShadowCalculationContext[] = [];
  private maxHistorySize = 20;
  private debounceTimer: number | null = null;
  private isCalculating = false;

  /**
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

    if (!this.lastCalculation) {
      return {
        shouldCalculate: true,
        reason: 'first calculation'
      };
    }

    const cachedContext = this.findSimilarCalculation(currentView, date, buildingCount);
    if (cachedContext) {
      console.log('🎯 Found similar shadow calculation', {
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
        reason: 'using cached result',
        cachedContext
      };
    }

    const viewChanged = this.hasSignificantViewChange(
      this.lastCalculation.viewState,
      currentView
    );

    if (!viewChanged) {
      const timeChanged = this.hasSignificantTimeChange(
        this.lastCalculation.date,
        date
      );

      if (!timeChanged) {
        return {
          shouldCalculate: false,
          reason: 'view and time unchanged'
        };
      }

      return {
        shouldCalculate: true,
        reason: 'significant time change'
      };
    }

    return {
      shouldCalculate: true,
      reason: 'significant view change'
    };
  }

  /**
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
   */
  private hasSignificantViewChange(
    oldView: ViewState,
    newView: ViewState
  ): boolean {
    if (Math.abs(oldView.zoom - newView.zoom) > 0.5) {
      return true;
    }

    const centerMovement = Math.sqrt(
      Math.pow(newView.center.lng - oldView.center.lng, 2) +
      Math.pow(newView.center.lat - oldView.center.lat, 2)
    );

    const threshold = this.getMovementThreshold(newView.zoom);
    
    if (centerMovement > threshold) {
      console.log('📍 Viewport movement:', {
        movement: centerMovement.toFixed(6),
        threshold: threshold.toFixed(6),
        zoom: newView.zoom
      });
      return true;
    }

    return false;
  }

  /**
   */
  private getMovementThreshold(zoom: number): number {
    if (zoom >= 18) return 0.0001;  // 11
    if (zoom >= 16) return 0.0005;  // 55
    if (zoom >= 14) return 0.001;   // 111
    if (zoom >= 12) return 0.005;   // 555
    return 0.01;                     // 1.1
  }

  /**
   */
  private hasSignificantTimeChange(oldDate: Date, newDate: Date): boolean {
    const timeDiff = Math.abs(newDate.getTime() - oldDate.getTime());
    const fifteenMinutes = 15 * 60 * 1000;

    return timeDiff > fifteenMinutes;
  }

  /**
   */
  private findSimilarCalculation(
    currentView: ViewState,
    date: Date,
    buildingCount: number
  ): ShadowCalculationContext | null {
    for (let i = this.calculationHistory.length - 1; i >= 0; i--) {
      const history = this.calculationHistory[i];

      if (Math.abs(history.buildingCount - buildingCount) > 10) {
        continue;
      }

      if (!this.hasSignificantViewChange(history.viewState, currentView)) {
        if (!this.hasSignificantTimeChange(history.date, date)) {
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

    if (this.calculationHistory.length > this.maxHistorySize) {
      this.calculationHistory.shift();
    }

    shadowCache.set(
      context.viewState.bounds,
      context.viewState.zoom,
      date,
      { calculated: true }
    );

    console.log('📝 Recording shadow calculation:', {
      historySize: this.calculationHistory.length,
      center: context.viewState.center,
      zoom: context.viewState.zoom,
      time: date.toLocaleTimeString(),
      buildings: buildingCount
    });
  }

  /**
   */
  debouncedCalculate(
    callback: () => void,
    delay: number = 500
  ): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      if (!this.isCalculating) {
        callback();
      }
    }, delay);
  }

  /**
   */
  setCalculating(isCalculating: boolean): void {
    this.isCalculating = isCalculating;
  }

  /**
   */
  clear(): void {
    this.lastCalculation = null;
    this.calculationHistory = [];
    console.log('🗑️ Clearing shadow calculation history');
  }

  /**
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

export const shadowOptimizer = new ShadowCalculationOptimizer();