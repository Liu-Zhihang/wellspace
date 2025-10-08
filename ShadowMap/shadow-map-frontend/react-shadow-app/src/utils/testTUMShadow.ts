/**
 * TUM阴影计算测试工具
 * 用于验证修复是否有效
 */

import { tumShadowService } from '../services/tumShadowService';

export interface TestResult {
  success: boolean;
  error?: string;
  duration: number;
  bounds: any;
  date: Date;
  zoom: number;
}

/**
 * 测试TUM阴影计算
 */
export async function testTUMShadowCalculation(): Promise<TestResult> {
  const startTime = performance.now();
  
  // 使用北京天安门附近的测试边界
  const testBounds = {
    north: 39.9200,
    south: 39.9000,
    east: 116.4200,
    west: 116.4000
  };
  
  const testDate = new Date();
  const testZoom = 15;
  
  console.log('🧪 开始测试TUM阴影计算...');
  console.log('测试参数:', { testBounds, testDate: testDate.toISOString(), testZoom });
  
  try {
    const result = await tumShadowService.calculateRealTimeShadows(
      testBounds,
      testDate,
      testZoom
    );
    
    const duration = performance.now() - startTime;
    
    console.log('✅ TUM阴影计算测试成功');
    console.log('结果:', {
      shadowsCount: result.shadows.length,
      buildingCount: result.buildingCount,
      calculationTime: result.calculationTime,
      sunPosition: result.sunPosition
    });
    
    return {
      success: true,
      duration,
      bounds: testBounds,
      date: testDate,
      zoom: testZoom
    };
    
  } catch (error) {
    const duration = performance.now() - startTime;
    
    console.error('❌ TUM阴影计算测试失败:', error);
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      duration,
      bounds: testBounds,
      date: testDate,
      zoom: testZoom
    };
  }
}

/**
 * 测试边界数据转换
 */
export function testBoundsConversion(): boolean {
  console.log('🧪 测试边界数据转换...');
  
  // 模拟Mapbox bounds对象
  const mockMapboxBounds = {
    getNorth: () => 39.9200,
    getSouth: () => 39.9000,
    getEast: () => 116.4200,
    getWest: () => 116.4000
  };
  
  try {
    // 测试转换
    const convertedBounds = {
      north: mockMapboxBounds.getNorth(),
      south: mockMapboxBounds.getSouth(),
      east: mockMapboxBounds.getEast(),
      west: mockMapboxBounds.getWest()
    };
    
    console.log('转换前:', mockMapboxBounds);
    console.log('转换后:', convertedBounds);
    
    // 验证转换结果
    if (typeof convertedBounds.north !== 'number' || 
        typeof convertedBounds.south !== 'number' ||
        typeof convertedBounds.east !== 'number' || 
        typeof convertedBounds.west !== 'number') {
      throw new Error('转换后的边界值不是数字');
    }
    
    if (convertedBounds.north <= convertedBounds.south || 
        convertedBounds.east <= convertedBounds.west) {
      throw new Error('转换后的边界值无效');
    }
    
    console.log('✅ 边界数据转换测试成功');
    return true;
    
  } catch (error) {
    console.error('❌ 边界数据转换测试失败:', error);
    return false;
  }
}

/**
 * 运行所有测试
 */
export async function runAllTests(): Promise<void> {
  console.log('🚀 开始运行TUM阴影计算测试套件...');
  
  // 测试1: 边界数据转换
  const boundsTest = testBoundsConversion();
  console.log(`边界转换测试: ${boundsTest ? '✅ 通过' : '❌ 失败'}`);
  
  // 测试2: TUM阴影计算
  const shadowTest = await testTUMShadowCalculation();
  console.log(`阴影计算测试: ${shadowTest.success ? '✅ 通过' : '❌ 失败'}`);
  
  if (shadowTest.error) {
    console.error('错误详情:', shadowTest.error);
  }
  
  console.log('🏁 测试套件完成');
}

// 在开发环境中自动运行测试
if (process.env.NODE_ENV === 'development') {
  // 延迟运行，确保模块加载完成
  setTimeout(() => {
    runAllTests();
  }, 2000);
}
