/**
 * 调试辅助工具
 * 阴影计算诊断工具
 */

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

  static getInstance(): DebugHelper {
    if (!DebugHelper.instance) {
      DebugHelper.instance = new DebugHelper();
    }
    return DebugHelper.instance;
  }

  /**
   * 记录调试信息
   */
  logDebugInfo(info: DebugInfo): void {
    this.debugLog.push(info);
    
    // 只保留最近10条记录
    if (this.debugLog.length > 10) {
      this.debugLog.shift();
    }
    
    console.log('🔍 调试信息:', info);
  }

  /**
   * 获取最近的调试信息
   */
  getRecentDebugInfo(): DebugInfo[] {
    return [...this.debugLog];
  }

  /**
   * 清空调试日志
   */
  clearDebugLog(): void {
    this.debugLog = [];
    console.log('🧹 调试日志已清空');
  }

  /**
   * 验证Mapbox bounds对象
   */
  validateMapboxBounds(bounds: any): boolean {
    if (!bounds) {
      console.error('❌ bounds对象为空');
      return false;
    }

    if (typeof bounds.getNorth !== 'function') {
      console.error('❌ bounds对象缺少getNorth方法');
      return false;
    }

    if (typeof bounds.getSouth !== 'function') {
      console.error('❌ bounds对象缺少getSouth方法');
      return false;
    }

    if (typeof bounds.getEast !== 'function') {
      console.error('❌ bounds对象缺少getEast方法');
      return false;
    }

    if (typeof bounds.getWest !== 'function') {
      console.error('❌ bounds对象缺少getWest方法');
      return false;
    }

    try {
      const north = bounds.getNorth();
      const south = bounds.getSouth();
      const east = bounds.getEast();
      const west = bounds.getWest();

      if (typeof north !== 'number' || typeof south !== 'number' || 
          typeof east !== 'number' || typeof west !== 'number') {
        console.error('❌ bounds坐标值不是数字:', { north, south, east, west });
        return false;
      }

      if (north <= south || east <= west) {
        console.error('❌ bounds坐标值无效:', { north, south, east, west });
        return false;
      }

      return true;
    } catch (error) {
      console.error('❌ 获取bounds坐标时出错:', error);
      return false;
    }
  }

  /**
   * 验证转换后的边界对象
   */
  validateConvertedBounds(bounds: any): boolean {
    if (!bounds) {
      console.error('❌ 转换后的bounds对象为空');
      return false;
    }

    const requiredProps = ['north', 'south', 'east', 'west'];
    for (const prop of requiredProps) {
      if (!(prop in bounds)) {
        console.error(`❌ 转换后的bounds对象缺少${prop}属性`);
        return false;
      }

      if (typeof bounds[prop] !== 'number') {
        console.error(`❌ 转换后的bounds对象${prop}属性不是数字:`, bounds[prop]);
        return false;
      }
    }

    if (bounds.north <= bounds.south || bounds.east <= bounds.west) {
      console.error('❌ 转换后的bounds坐标值无效:', bounds);
      return false;
    }

    return true;
  }

  /**
   * 生成调试报告
   */
  generateDebugReport(): string {
    const recent = this.getRecentDebugInfo();
    if (recent.length === 0) {
      return '暂无调试信息';
    }

    const latest = recent[recent.length - 1];
    return `
🔍 阴影计算调试报告
========================
时间: ${latest.timestamp}
地图就绪: ${latest.mapReady ? '是' : '否'}
缩放级别: ${latest.zoom}
当前日期: ${latest.currentDate.toISOString()}

Mapbox Bounds:
${JSON.stringify(latest.mapBounds, null, 2)}

转换后 Bounds:
${JSON.stringify(latest.convertedBounds, null, 2)}

最近${recent.length}次调试记录:
${recent.map((info, index) => `${index + 1}. ${info.timestamp} - 地图就绪: ${info.mapReady}`).join('\n')}
    `.trim();
  }
}

// 导出单例实例
export const debugHelper = DebugHelper.getInstance();
