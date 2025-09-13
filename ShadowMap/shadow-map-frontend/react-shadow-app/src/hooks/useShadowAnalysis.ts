import { useRef } from 'react';
import L from 'leaflet';
import { useShadowMapStore } from '../store/shadowMapStore';
import { GeoUtils } from '../utils/geoUtils';
import type { ShadowAnalysisResult, ShadowAnalysisPoint } from '../types';

export const useShadowAnalysis = () => {
  const analysisMarkerRef = useRef<L.Marker | null>(null);
  const analysisCircleRef = useRef<L.Circle | null>(null);
  const analysisCache = useRef<Map<string, any>>(new Map()); // 分析结果缓存
  
  const {
    currentDate,
    analysisRadius,
    setAnalysisResult,
    addStatusMessage,
  } = useShadowMapStore();

  // 分析指定位置的阴影情况
  const analyzePointShadow = async (
    map: L.Map, 
    lat: number, 
    lng: number,
    shadeMapInstance: any
  ): Promise<void> => {
    try {
      addStatusMessage(`🔍 开始分析位置 ${lat.toFixed(4)}°, ${lng.toFixed(4)}° 的阴影情况`, 'info');
      
      // 等待阴影模拟器完全就绪
      if (!shadeMapInstance || !shadeMapInstance._map) {
        addStatusMessage('⚠️ 阴影模拟器未就绪，请稍后重试', 'warning');
        return;
      }
      
      // 确保建筑物数据已加载完成
      addStatusMessage('🔄 确保建筑物数据已加载...', 'info');
      await new Promise(resolve => setTimeout(resolve, 200)); // 等待数据稳定
      
      // 移除之前的分析标记
      if (analysisMarkerRef.current) {
        map.removeLayer(analysisMarkerRef.current);
      }
      if (analysisCircleRef.current) {
        map.removeLayer(analysisCircleRef.current);
      }

      // 添加分析点标记
      const marker = L.marker([lat, lng], {
        icon: L.divIcon({
          className: 'analysis-marker',
          html: '<div style="background: #ff4444; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        })
      });
      marker.addTo(map);
      analysisMarkerRef.current = marker;

      // 添加分析范围圆圈
      const circle = L.circle([lat, lng], {
        radius: analysisRadius,
        fillColor: '#3388ff',
        fillOpacity: 0.1,
        color: '#3388ff',
        weight: 2,
        dashArray: '5, 5',
      });
      circle.addTo(map);
      analysisCircleRef.current = circle;

      // 生成采样点
      const samplePoints = generateSamplePoints(lat, lng, analysisRadius, 16);
      
      // 分析每个采样点的阴影情况
      const analysisPromises = samplePoints.map(async (point) => {
        try {
          const shadowInfo = await analyzeSinglePoint(point.lat, point.lng, shadeMapInstance);
          return {
            lat: point.lat,
            lng: point.lng,
            hoursOfSun: shadowInfo.hoursOfSun,
            shadowPercent: shadowInfo.shadowPercent,
          };
        } catch (error) {
          // 单个点分析失败时，记录错误但继续分析其他点
          console.error(`❌ 采样点 ${point.lat.toFixed(4)}, ${point.lng.toFixed(4)} 分析失败:`, error);
          throw error; // 传播错误，让用户知道具体问题
        }
      });

      const analysisResults = await Promise.all(analysisPromises);
      
      // 计算统计信息
      const stats = calculateShadowStats(analysisResults);
      
      // 更新分析结果
      const result: ShadowAnalysisResult = {
        center: [lat, lng],
        radius: analysisRadius,
        samplePoints: analysisResults,
        stats,
        metadata: {
          date: currentDate,
          sampleCount: analysisResults.length,
        },
      };
      
      setAnalysisResult(result);
      
      // 显示弹窗信息
      showAnalysisPopup(map, lat, lng, result);
      
      addStatusMessage(`✅ 阴影分析完成！平均日照时长: ${stats.avgHoursOfSun.toFixed(1)} 小时`, 'info');
      
    } catch (error) {
      console.error('❌ 阴影分析失败:', error);
      
      // 显示具体的错误原因，不使用fallback
      if (error instanceof Error) {
        if (error.message.includes('太阳曝光分析未启用')) {
          addStatusMessage('❌ 请先开启"🌈 太阳热力图"进行准确的阴影分析', 'error');
        } else if (error.message.includes('阴影模拟器')) {
          addStatusMessage('❌ 阴影模拟器未正确初始化，请刷新页面重试', 'error');
        } else {
          addStatusMessage(`❌ 阴影分析失败: ${error.message}`, 'error');
        }
      } else {
        addStatusMessage('❌ 阴影分析遇到未知错误', 'error');
      }
    }
  };

  // 生成采样点（圆形分布）
  const generateSamplePoints = (centerLat: number, centerLng: number, radius: number, count: number) => {
    const points = [{ lat: centerLat, lng: centerLng }]; // 中心点
    
    // 生成圆形分布的采样点
    for (let i = 0; i < count; i++) {
      const angle = (i * 2 * Math.PI) / count;
      const distance = radius * 0.8; // 采样点距离中心80%半径
      
      const offsetLat = (distance * Math.cos(angle)) / 111000; // 纬度偏移
      const offsetLng = (distance * Math.sin(angle)) / (111000 * Math.cos(centerLat * Math.PI / 180)); // 经度偏移
      
      points.push({
        lat: centerLat + offsetLat,
        lng: centerLng + offsetLng,
      });
    }
    
    return points;
  };

  // 分析单个点的阴影情况
  const analyzeSinglePoint = async (lat: number, lng: number, shadeMapInstance: any) => {
    try {
      // 生成缓存键
      const cacheKey = `${lat.toFixed(6)}_${lng.toFixed(6)}_${currentDate.toISOString().split('T')[0]}`;
      
      // 检查缓存
      if (analysisCache.current.has(cacheKey)) {
        console.log(`📋 使用缓存结果: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
        return analysisCache.current.get(cacheKey);
      }
      
      // 获取当前地图实例
      const map = shadeMapInstance._map || (window as any).mapInstance;
      
      if (shadeMapInstance && map) {
        // 将经纬度转换为像素坐标
        const pixelPoint = map.latLngToContainerPoint([lat, lng]);
        
        console.log(`🔍 分析点 ${lat.toFixed(4)}, ${lng.toFixed(4)} -> 像素坐标 ${pixelPoint.x}, ${pixelPoint.y}`);
        
        // 方法1: 尝试使用 getHoursOfSun 方法（需要太阳曝光分析开启）
        if (typeof shadeMapInstance.getHoursOfSun === 'function') {
          try {
            // 检查是否启用了太阳曝光分析
            const isExposureEnabled = shadeMapInstance.options?.sunExposure?.enabled;
            
            if (!isExposureEnabled) {
              console.error(`❌ 太阳曝光分析未启用，无法进行准确的阴影分析`);
              throw new Error('太阳曝光分析未启用。请开启"🌈 太阳热力图"以获得准确的日照分析结果。');
            } else {
              // 多次尝试获取稳定结果
              let hoursOfSun = 0;
              let validResults = 0;
              const maxAttempts = 3;
              
              for (let attempt = 0; attempt < maxAttempts; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 150 + attempt * 50)); // 递增延迟
                
                const result = shadeMapInstance.getHoursOfSun(pixelPoint.x, pixelPoint.y);
                
                if (typeof result === 'number' && !isNaN(result) && result >= 0) {
                  hoursOfSun += result;
                  validResults++;
                  console.log(`📊 尝试 ${attempt + 1}: ${result} 小时 (像素: ${pixelPoint.x}, ${pixelPoint.y})`);
                }
              }
              
              // 如果有有效结果，使用平均值
              if (validResults > 0) {
                const avgHours = hoursOfSun / validResults;
                console.log(`✅ 稳定结果: ${avgHours.toFixed(2)} 小时 (${validResults}/${maxAttempts} 次成功)`);
                
                const result = {
                  hoursOfSun: Math.max(0, avgHours),
                  shadowPercent: Math.max(0, Math.min(100, (12 - avgHours) / 12 * 100)),
                };
                
                // 缓存稳定的结果
                analysisCache.current.set(cacheKey, result);
                
                return result;
              } else {
                throw new Error(`无法获取有效的日照数据。尝试了${maxAttempts}次，都未获得有效结果。`);
              }
            }
          } catch (sunError) {
            console.error('getHoursOfSun 方法调用失败:', sunError);
            throw sunError; // 不再隐藏错误，直接抛出
          }
        } else {
          throw new Error('getHoursOfSun 方法不可用。阴影模拟器可能未正确初始化。');
        }
        
        // 方法2: 使用 readPixel 方法读取阴影数据
        if (typeof shadeMapInstance.readPixel === 'function') {
          try {
            const pixelData = shadeMapInstance.readPixel(pixelPoint.x, pixelPoint.y);
            console.log(`🎨 readPixel 结果:`, pixelData);
            
            if (pixelData && pixelData.length >= 4) {
              // 分析像素数据来判断阴影情况
              const [r, g, b, a] = pixelData;
              const brightness = (r + g + b) / 3;
              
              // 基于亮度计算阴影百分比
              const shadowPercent = Math.max(0, (255 - brightness) / 255 * 100);
              const hoursOfSun = Math.max(0, 12 - (shadowPercent / 100 * 12));
              
              return {
                hoursOfSun,
                shadowPercent,
              };
            }
          } catch (pixelError) {
            console.warn('readPixel 方法调用失败:', pixelError);
          }
        }
      }
      
      // 如果所有方法都失败，直接报错
      throw new Error('所有阴影分析方法都失败。请检查：1) 太阳热力图是否开启 2) 阴影模拟器是否正确加载 3) 地图是否完全初始化');
      
    } catch (error) {
      console.error(`❌ 分析点 ${lat.toFixed(4)}, ${lng.toFixed(4)} 失败:`, error);
      // 直接抛出错误，不返回默认值
      throw error;
    }
  };

  // 计算阴影统计信息
  const calculateShadowStats = (points: ShadowAnalysisPoint[]) => {
    const hoursOfSunValues = points.map(p => p.hoursOfSun);
    const shadowPercentValues = points.map(p => p.shadowPercent);
    
    const avgHoursOfSun = hoursOfSunValues.reduce((sum, val) => sum + val, 0) / points.length;
    const avgShadowPercent = shadowPercentValues.reduce((sum, val) => sum + val, 0) / points.length;
    const maxShadowPercent = Math.max(...shadowPercentValues);
    const minShadowPercent = Math.min(...shadowPercentValues);
    
    // 计算标准差
    const variance = shadowPercentValues.reduce((sum, val) => sum + Math.pow(val - avgShadowPercent, 2), 0) / points.length;
    const stdDev = Math.sqrt(variance);
    
    // 计算阴影等级分布
    const shadowLevels = {
      无阴影: points.filter(p => p.shadowPercent < 10).length,
      轻微阴影: points.filter(p => p.shadowPercent >= 10 && p.shadowPercent < 30).length,
      中等阴影: points.filter(p => p.shadowPercent >= 30 && p.shadowPercent < 60).length,
      重度阴影: points.filter(p => p.shadowPercent >= 60 && p.shadowPercent < 80).length,
      极重阴影: points.filter(p => p.shadowPercent >= 80).length,
    };
    
    return {
      avgHoursOfSun,
      avgShadowPercent,
      maxShadowPercent,
      minShadowPercent,
      stdDev,
      shadowLevels,
    };
  };

  // 显示分析结果弹窗
  const showAnalysisPopup = (map: L.Map, lat: number, lng: number, result: ShadowAnalysisResult) => {
    const popup = L.popup({
      maxWidth: 300,
      className: 'shadow-analysis-popup',
    })
    .setLatLng([lat, lng])
    .setContent(`
      <div class="p-3">
        <h3 class="font-bold text-lg mb-2">🌅 阴影分析结果</h3>
        <div class="space-y-2 text-sm">
          <div class="flex justify-between">
            <span>位置:</span>
            <span>${lat.toFixed(4)}°, ${lng.toFixed(4)}°</span>
          </div>
          <div class="flex justify-between">
            <span>平均日照:</span>
            <span>${result.stats.avgHoursOfSun.toFixed(1)} 小时</span>
          </div>
          <div class="flex justify-between">
            <span>平均阴影:</span>
            <span>${result.stats.avgShadowPercent.toFixed(1)}%</span>
          </div>
          <div class="flex justify-between">
            <span>分析时间:</span>
            <span>${result.metadata.date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <div class="mt-3 pt-2 border-t">
            <div class="text-xs text-gray-600">采样点: ${result.metadata.sampleCount} 个</div>
            <div class="text-xs text-gray-600">分析半径: ${Math.round(result.radius)} 米</div>
          </div>
        </div>
      </div>
    `)
    .openOn(map);
  };

  // 清除分析结果
  const clearAnalysis = (map: L.Map) => {
    if (analysisMarkerRef.current) {
      map.removeLayer(analysisMarkerRef.current);
      analysisMarkerRef.current = null;
    }
    if (analysisCircleRef.current) {
      map.removeLayer(analysisCircleRef.current);
      analysisCircleRef.current = null;
    }
    setAnalysisResult(null);
  };

  // 计算一天内的日照时长（详细版本）
  const calculateDailyHoursOfSun = async (lat: number, lng: number, date: Date): Promise<number> => {
    try {
      let totalHoursOfSun = 0;
      const samplesPerHour = 4; // 每小时4次采样
      const startHour = 6; // 从早上6点开始
      const endHour = 18; // 到晚上6点结束
      
      for (let hour = startHour; hour <= endHour; hour += 1/samplesPerHour) {
        const testDate = new Date(date);
        testDate.setHours(Math.floor(hour), (hour % 1) * 60, 0, 0);
        
        const sunPosition = GeoUtils.getSunPosition(testDate, lat, lng);
        
        if (sunPosition.altitude > 0) {
          // 太阳在地平线以上，计算是否有阴影遮挡
          const shadowFactor = calculateShadowFactor(sunPosition, lat, lng, testDate);
          const sunlightStrength = Math.min(1, sunPosition.altitude / 60) * (1 - shadowFactor);
          
          if (sunlightStrength > 0.1) { // 阈值：10%以上的阳光强度算作有日照
            totalHoursOfSun += (1 / samplesPerHour) * sunlightStrength;
          }
        }
      }
      
      console.log(`🌞 ${lat.toFixed(4)}, ${lng.toFixed(4)} 计算得出日照时长: ${totalHoursOfSun.toFixed(1)} 小时`);
      return Math.max(0, totalHoursOfSun);
    } catch (error) {
      console.error('计算日照时长失败:', error);
      return 0;
    }
  };

  // 计算阴影因子（基于真实太阳位置和时间）
  const calculateShadowFactor = (sunPosition: any, lat: number, lng: number, testDate: Date): number => {
    // 基于真实时间而不是当前时间
    const timeOfDay = testDate.getHours() + testDate.getMinutes() / 60;
    
    // 基于太阳高度角的精确计算
    let shadowFactor = 0;
    
    // 太阳高度角越低，阴影越多
    if (sunPosition.altitude < 5) {
      shadowFactor = 0.9; // 极低角度，几乎全是阴影
    } else if (sunPosition.altitude < 15) {
      shadowFactor = 0.6; // 低角度，较多阴影
    } else if (sunPosition.altitude < 30) {
      shadowFactor = 0.3; // 中等角度，中等阴影
    } else if (sunPosition.altitude < 45) {
      shadowFactor = 0.15; // 较高角度，较少阴影
    } else {
      shadowFactor = 0.05; // 高角度，最少阴影
    }
    
    // 考虑地理位置的影响（纬度越高，冬季阴影越多）
    const latitudeFactor = Math.abs(lat) / 90 * 0.1; // 纬度影响最大10%
    shadowFactor += latitudeFactor;
    
    // 考虑季节影响
    const dayOfYear = Math.floor((testDate.getTime() - new Date(testDate.getFullYear(), 0, 0).getTime()) / 86400000);
    const seasonFactor = 0.1 * Math.sin((dayOfYear - 172) * 2 * Math.PI / 365); // 冬季更多阴影
    shadowFactor += Math.abs(seasonFactor);
    
    return Math.min(0.9, Math.max(0.05, shadowFactor)); // 限制在5%-90%范围内
  };

  // 清理分析缓存
  const clearAnalysisCache = () => {
    analysisCache.current.clear();
    console.log('🧹 分析缓存已清理');
  };

  return {
    analyzePointShadow,
    clearAnalysis,
    clearAnalysisCache,
  };
};
