/**
 * 参考专业网站的简洁时间轴设计
 * 学习参考网站的UI设计理念
 */

import React, { useState, useEffect } from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';

export const ReferenceInspiredTimeline: React.FC = () => {
  const { 
    currentDate, 
    setCurrentDate, 
    isAnimating, 
    setIsAnimating 
  } = useShadowMapStore();

  const [localDate, setLocalDate] = useState(currentDate);
  const [speed, setSpeed] = useState(1);

  // 同步到全局状态
  useEffect(() => {
    setCurrentDate(localDate);
  }, [localDate, setCurrentDate]);

  // 动画控制
  useEffect(() => {
    if (!isAnimating) return;

    const interval = setInterval(() => {
      setLocalDate(prev => {
        const newDate = new Date(prev);
        newDate.setMinutes(newDate.getMinutes() + (10 * speed));
        
        if (newDate.getHours() >= 24) {
          newDate.setHours(0, 0);
          newDate.setDate(newDate.getDate() + 1);
        }
        
        return newDate;
      });
    }, 300 / speed);

    return () => clearInterval(interval);
  }, [isAnimating, speed]);

  // 计算太阳参数
  const calculateSunPosition = (date: Date) => {
    const hour = date.getHours();
    const minute = date.getMinutes();
    
    // 简化的太阳高度角计算（基于北京纬度39.9°）
    const latitude = 39.9;
    const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24));
    const declination = 23.45 * Math.sin((360 * (284 + dayOfYear) / 365) * Math.PI / 180);
    
    // 太阳高度角（简化计算）
    const hourAngle = (hour + minute / 60 - 12) * 15;
    const elevation = Math.asin(
      Math.sin(latitude * Math.PI / 180) * Math.sin(declination * Math.PI / 180) +
      Math.cos(latitude * Math.PI / 180) * Math.cos(declination * Math.PI / 180) * Math.cos(hourAngle * Math.PI / 180)
    ) * 180 / Math.PI;
    
    // 太阳方位角
    const azimuth = Math.atan2(
      Math.sin(hourAngle * Math.PI / 180),
      Math.cos(hourAngle * Math.PI / 180) * Math.sin(latitude * Math.PI / 180) - 
      Math.tan(declination * Math.PI / 180) * Math.cos(latitude * Math.PI / 180)
    ) * 180 / Math.PI + 180;
    
    return {
      elevation: Math.max(0, elevation).toFixed(1),
      azimuth: azimuth.toFixed(1),
      direction: getDirection(azimuth)
    };
  };

  const getDirection = (azimuth: number) => {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(azimuth / 22.5) % 16;
    return directions[index];
  };

  const sunPosition = calculateSunPosition(localDate);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('zh-CN', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    });
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('zh-CN', { 
      month: 'short', 
      day: 'numeric' 
    });
  };

  const handleTimeClick = (hour: number) => {
    const newDate = new Date(localDate);
    newDate.setHours(hour, 0, 0, 0);
    setLocalDate(newDate);
  };

  const currentHour = localDate.getHours();

  // 生成24小时时间轴
  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 z-40">
      <div className="bg-white/95 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 p-4 min-w-[800px] max-w-[90vw]">
        {/* 参考网站风格的时间轴 */}
        <div className="flex items-center justify-between mb-3">
          {/* 时间轴 */}
          <div className="flex items-center space-x-1">
            {hours.map((hour) => (
              <button
                key={hour}
                onClick={() => handleTimeClick(hour)}
                className={`px-2 py-1 text-sm font-medium rounded transition-all ${
                  hour === currentHour
                    ? 'bg-blue-500 text-white shadow-md'
                    : 'text-gray-600 hover:text-blue-600 hover:bg-blue-50'
                }`}
                title={`${hour}时`}
              >
                {hour}时
              </button>
            ))}
          </div>

          {/* 播放控制 */}
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setIsAnimating(!isAnimating)}
              className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm transition-all ${
                isAnimating 
                  ? 'bg-red-500 hover:bg-red-600' 
                  : 'bg-green-500 hover:bg-green-600'
              }`}
              title={isAnimating ? '暂停' : '播放'}
            >
              {isAnimating ? '⏸️' : '▶️'}
            </button>
            
            <select
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="text-sm bg-white rounded border border-gray-300 px-2 py-1"
              disabled={!isAnimating}
            >
              <option value={0.5}>0.5x</option>
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={4}>4x</option>
            </select>
          </div>
        </div>

        {/* 参考网站风格的信息栏 */}
        <div className="flex items-center justify-between text-sm text-gray-600">
          <div className="flex items-center space-x-4">
            <span className="font-medium">{formatDate(localDate)}</span>
            <span className="font-medium text-blue-600">{formatTime(localDate)}</span>
          </div>
          
          <div className="flex items-center space-x-4">
            <span>太阳高度: <span className="font-medium text-orange-600">{sunPosition.elevation}°</span></span>
            <span>方位角: <span className="font-medium text-orange-600">{sunPosition.azimuth}° {sunPosition.direction}</span></span>
          </div>
        </div>

        {/* 当前时间指示器 */}
        <div className="relative mt-2">
          <div className="h-1 bg-gray-200 rounded-full">
            <div 
              className="absolute top-0 h-1 w-1 bg-blue-500 rounded-full transition-all duration-300"
              style={{ 
                left: `${(currentHour / 23) * 100}%`,
                transform: 'translateX(-50%)'
              }}
            >
              <div className="absolute inset-0 bg-blue-500 rounded-full animate-ping opacity-75"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
