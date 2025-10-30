export interface DebugInfo {
  mapBounds: any;
  convertedBounds: any;
  currentDate: Date;
  zoom: number;
  mapReady: boolean;
  timestamp: string;
}

export class DebugHelper {
  private static instance: DebugHelper;
  private debugLog: DebugInfo[] = [];
  private readonly maxEntries = 10;

  static getInstance(): DebugHelper {
    if (!DebugHelper.instance) {
      DebugHelper.instance = new DebugHelper();
    }
    return DebugHelper.instance;
  }

  logDebugInfo(info: DebugInfo): void {
    this.debugLog.push(info);
    if (this.debugLog.length > this.maxEntries) {
      this.debugLog.shift();
    }
    console.log('🔍 Shadow debug info recorded', info);
  }

  getRecentDebugInfo(): DebugInfo[] {
    return [...this.debugLog];
  }

  clearDebugLog(): void {
    this.debugLog = [];
    console.log('🧹 Shadow debug log cleared');
  }

  validateMapboxBounds(bounds: any): boolean {
    if (!bounds) {
      console.error('❌ Mapbox bounds object is missing');
      return false;
    }

    const requiredFns = ['getNorth', 'getSouth', 'getEast', 'getWest'] as const;
    for (const fn of requiredFns) {
      if (typeof (bounds as any)[fn] !== 'function') {
        console.error(`❌ Mapbox bounds missing ${fn}`);
        return false;
      }
    }

    try {
      const north = (bounds as any).getNorth();
      const south = (bounds as any).getSouth();
      const east = (bounds as any).getEast();
      const west = (bounds as any).getWest();

      if ([north, south, east, west].some((value) => typeof value !== 'number')) {
        console.error('❌ Mapbox bounds contain non-numeric values', { north, south, east, west });
        return false;
      }

      if (north <= south || east <= west) {
        console.error('❌ Mapbox bounds values are not ordered correctly', { north, south, east, west });
        return false;
      }

      return true;
    } catch (error) {
      console.error('❌ Unable to evaluate Mapbox bounds', error);
      return false;
    }
  }

  validateConvertedBounds(bounds: Record<string, unknown>): boolean {
    if (!bounds) {
      console.error('❌ Converted bounds object is missing');
      return false;
    }

    const requiredProps = ['north', 'south', 'east', 'west'] as const;
    for (const prop of requiredProps) {
      if (!(prop in bounds)) {
        console.error(`❌ Converted bounds missing property ${prop}`);
        return false;
      }
      if (typeof bounds[prop] !== 'number') {
        console.error(`❌ Converted bounds property ${prop} is not numeric`, bounds[prop]);
        return false;
      }
    }

    const { north, south, east, west } = bounds as Record<string, number>;
    if (north <= south || east <= west) {
      console.error('❌ Converted bounds values are not ordered correctly', bounds);
      return false;
    }

    return true;
  }

  generateDebugReport(): string {
    const recent = this.getRecentDebugInfo();
    if (recent.length === 0) {
      return 'No debug information recorded.';
    }

    const latest = recent[recent.length - 1];
    const lines = [
      '🔍 Shadow Debug Report',
      '========================',
      `Timestamp: ${latest.timestamp}`,
      `Map ready: ${latest.mapReady ? 'yes' : 'no'}`,
      `Zoom level: ${latest.zoom}`,
      `Current date: ${latest.currentDate.toISOString()}`,
      '',
      'Mapbox bounds:',
      JSON.stringify(latest.mapBounds, null, 2),
      '',
      'Converted bounds:',
      JSON.stringify(latest.convertedBounds, null, 2),
      '',
      `Recent entries (${recent.length}):`,
      recent
        .map((info, index) => `${index + 1}. ${info.timestamp} - map ready: ${info.mapReady}`)
        .join('\n'),
    ];

    return lines.join('\n');
  }
}

export const debugHelper = DebugHelper.getInstance();
