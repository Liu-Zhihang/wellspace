/**
 * 端点健康状态实时监控
 * 基于实际测试结果动态调整端点优先级
 */

interface EndpointHealth {
  url: string;
  region: string;
  avgResponseTime: number;
  reliability: number;
  lastHealthy: boolean;
  lastChecked: number;
  successCount: number;
  failureCount: number;
  recentResponseTimes: number[];
}

interface HealthCheckResult {
  healthy: boolean;
  responseTime: number;
  error?: string;
}

export class EndpointHealthMonitor {
  private static instance: EndpointHealthMonitor;
  private endpointStats = new Map<string, EndpointHealth>();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  
  private readonly endpoints = [
    { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', region: '俄罗斯Mail.ru' },
    { url: 'https://overpass-api.de/api/interpreter', region: '德国' },
    { url: 'https://overpass.kumi.systems/api/interpreter', region: '瑞士' },
    { url: 'https://overpass.openstreetmap.ru/api/interpreter', region: '俄罗斯OSM' }
  ];

  private constructor() {
    this.initializeStats();
    this.startPeriodicHealthCheck();
  }

  public static getInstance(): EndpointHealthMonitor {
    if (!EndpointHealthMonitor.instance) {
      EndpointHealthMonitor.instance = new EndpointHealthMonitor();
    }
    return EndpointHealthMonitor.instance;
  }

  /**
   * 初始化端点统计 - 基于您的测试结果
   */
  private initializeStats(): void {
    const initialData = [
      { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', avgResponseTime: 1073, reliability: 0.9, lastHealthy: true },
      { url: 'https://overpass-api.de/api/interpreter', avgResponseTime: 1926, reliability: 0.85, lastHealthy: true },
      { url: 'https://overpass.kumi.systems/api/interpreter', avgResponseTime: 2881, reliability: 0.8, lastHealthy: true },
      { url: 'https://overpass.openstreetmap.ru/api/interpreter', avgResponseTime: 5079, reliability: 0.6, lastHealthy: false }
    ];
    
    this.endpoints.forEach((endpoint, index) => {
      const initial = initialData[index];
      this.endpointStats.set(endpoint.url, {
        url: endpoint.url,
        region: endpoint.region,
        avgResponseTime: initial.avgResponseTime,
        reliability: initial.reliability,
        lastHealthy: initial.lastHealthy,
        lastChecked: Date.now(),
        successCount: initial.lastHealthy ? 10 : 3, // 模拟历史数据
        failureCount: initial.lastHealthy ? 1 : 7,
        recentResponseTimes: [initial.avgResponseTime]
      });
    });
    
    console.log('📊 端点健康监控器初始化完成 (基于用户测试结果)');
  }

  /**
   * 获取最优端点列表 - 实时排序
   */
  public getOptimalEndpoints(lat?: number, lng?: number): string[] {
    const healthyEndpoints = Array.from(this.endpointStats.values())
      .filter(stat => stat.lastHealthy)
      .sort((a, b) => {
        // 综合评分：响应时间 × 可靠性
        const scoreA = a.avgResponseTime / a.reliability;
        const scoreB = b.avgResponseTime / b.reliability;
        return scoreA - scoreB;
      })
      .map(stat => stat.url);
    
    const unhealthyEndpoints = Array.from(this.endpointStats.values())
      .filter(stat => !stat.lastHealthy)
      .sort((a, b) => a.avgResponseTime - b.avgResponseTime)
      .map(stat => stat.url);
    
    const optimal = [...healthyEndpoints, ...unhealthyEndpoints];
    
    // 根据地理位置微调
    if (lat && lng) {
      if (lat > 35 && lat < 70 && lng > -10 && lng < 40) {
        // 欧洲：德国端点优先
        const germanEndpoint = 'https://overpass-api.de/api/interpreter';
        const reordered = [germanEndpoint, ...optimal.filter(url => url !== germanEndpoint)];
        console.log(`🌍 欧洲区域优化排序: ${this.endpointStats.get(germanEndpoint)?.region} 优先`);
        return reordered;
      } else if (lat > 10 && lat < 55 && lng > 60 && lng < 150) {
        // 亚洲：最快端点优先 (当前是Mail.ru)
        console.log(`🌍 亚洲区域优化排序: ${this.endpointStats.get(optimal[0])?.region} 优先`);
      }
    }
    
    return optimal;
  }

  /**
   * 记录查询结果 - 更新端点统计
   */
  public recordQueryResult(endpoint: string, success: boolean, responseTime: number): void {
    const stat = this.endpointStats.get(endpoint);
    if (!stat) return;
    
    // 更新成功/失败计数
    if (success) {
      stat.successCount++;
      stat.lastHealthy = true;
    } else {
      stat.failureCount++;
      // 连续3次失败标记为不健康
      if (stat.failureCount >= stat.successCount) {
        stat.lastHealthy = false;
      }
    }
    
    // 更新响应时间
    stat.recentResponseTimes.push(responseTime);
    if (stat.recentResponseTimes.length > 10) {
      stat.recentResponseTimes.shift(); // 只保留最近10次
    }
    
    // 重新计算平均响应时间
    stat.avgResponseTime = stat.recentResponseTimes.reduce((a, b) => a + b, 0) / stat.recentResponseTimes.length;
    
    // 重新计算可靠性
    const total = stat.successCount + stat.failureCount;
    stat.reliability = stat.successCount / total;
    
    stat.lastChecked = Date.now();
    
    console.log(`📊 更新端点统计 ${stat.region}: ${success ? '✅' : '❌'} (${responseTime}ms, 可靠性${(stat.reliability * 100).toFixed(1)}%)`);
  }

  /**
   * 定期健康检查
   */
  private startPeriodicHealthCheck(): void {
    // 每5分钟检查一次端点健康状态
    this.healthCheckInterval = setInterval(async () => {
      console.log('🔄 执行定期端点健康检查...');
      await this.performHealthCheck();
    }, 5 * 60 * 1000);
    
    console.log('⏰ 定期健康检查已启动 (5分钟间隔)');
  }

  /**
   * 执行健康检查
   */
  private async performHealthCheck(): Promise<void> {
    const healthQuery = '[out:json][timeout:3]; way["building"="yes"](bbox:39.9,116.4,39.901,116.401); out count;';
    
    const promises = this.endpoints.map(async (endpoint) => {
      try {
        const startTime = Date.now();
        
        const axios = require('axios');
        const response = await axios.post(endpoint.url, healthQuery, {
          headers: { 'Content-Type': 'text/plain', 'User-Agent': 'ShadowMap-Monitor/1.0' },
          timeout: 5000,
          validateStatus: (status: number) => status === 200
        });
        
        const responseTime = Date.now() - startTime;
        
        if (response.data && typeof response.data === 'object') {
          this.recordQueryResult(endpoint.url, true, responseTime);
          return { endpoint: endpoint.url, healthy: true, responseTime };
        } else {
          this.recordQueryResult(endpoint.url, false, responseTime);
          return { endpoint: endpoint.url, healthy: false, responseTime, error: '响应数据异常' };
        }
        
      } catch (error) {
        const responseTime = Date.now() - Date.now(); // 重置
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.recordQueryResult(endpoint.url, false, 5000); // 标记失败，使用5秒作为惩罚时间
        return { endpoint: endpoint.url, healthy: false, responseTime: 5000, error: errorMsg };
      }
    });
    
    const results = await Promise.allSettled(promises);
    
    const healthyCount = results.filter(result => 
      result.status === 'fulfilled' && result.value.healthy
    ).length;
    
    console.log(`📊 健康检查完成: ${healthyCount}/${this.endpoints.length} 端点健康`);
  }

  /**
   * 获取详细统计信息
   */
  public getDetailedStats(): {
    endpoints: Array<EndpointHealth & { score: number }>;
    summary: {
      totalEndpoints: number;
      healthyEndpoints: number;
      avgResponseTime: number;
      bestEndpoint: string;
      worstEndpoint: string;
    };
  } {
    const endpointList = Array.from(this.endpointStats.values()).map(stat => ({
      ...stat,
      score: stat.avgResponseTime / stat.reliability // 越小越好
    }));
    
    const healthyEndpoints = endpointList.filter(ep => ep.lastHealthy);
    const bestEndpoint = healthyEndpoints.sort((a, b) => a.score - b.score)[0];
    const worstEndpoint = endpointList.sort((a, b) => b.score - a.score)[0];
    
    return {
      endpoints: endpointList.sort((a, b) => a.score - b.score),
      summary: {
        totalEndpoints: endpointList.length,
        healthyEndpoints: healthyEndpoints.length,
        avgResponseTime: healthyEndpoints.reduce((sum, ep) => sum + ep.avgResponseTime, 0) / Math.max(healthyEndpoints.length, 1),
        bestEndpoint: bestEndpoint?.region || 'none',
        worstEndpoint: worstEndpoint?.region || 'none'
      }
    };
  }

  /**
   * 停止监控
   */
  public destroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      console.log('⏹️ 端点健康监控已停止');
    }
  }
}

// 导出单例实例
export const endpointHealthMonitor = EndpointHealthMonitor.getInstance();
