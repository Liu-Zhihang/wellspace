/**
 * 简洁的时间轴控制组件
 * 重新设计，避免在页面中间占用空间
 */

import React, { useState, useEffect } from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';

export const CompactTimeline: React.FC = () => {
  const { 
    currentDate, 
    setCurrentDate, 
    isAnimating, 
    setIsAnimating 
  } = useShadowMapStore();

  const [localDate, setLocalDate] = useState(currentDate);
  const [speed, setSpeed] = useState(1);
  const [isExpanded, setIsExpanded] = useState(false);

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

  // 🔧 手动同步到当前时间
  const syncToCurrentTime = () => {
    const now = new Date();
    setLocalDate(now);
    console.log(`🕐 手动同步到当前时间: ${formatTime(now)}`);
  };

  const getTimeIcon = (hour: number) => {
    if (hour >= 0 && hour < 6) return '🌙';
    if (hour === 6) return '🌅';
    if (hour >= 7 && hour < 12) return '☀️';
    if (hour === 12) return '🌞';
    if (hour >= 13 && hour < 18) return '☀️';
    if (hour === 18) return '🌆';
    return '🌙';
  };

  const getTimeLabel = (hour: number) => {
    if (hour >= 0 && hour < 6) return '深夜';
    if (hour >= 6 && hour < 12) return '上午';
    if (hour >= 12 && hour < 18) return '下午';
    return '夜晚';
  };

  const currentHour = localDate.getHours();
  const currentMinute = localDate.getMinutes();
  const timeProgress = (currentHour * 60 + currentMinute) / (24 * 60) * 100;

  return (
    <div className="fixed bottom-4 right-4 z-40">
      {/* 紧凑模式 - 默认显示 */}
      {!isExpanded && (
        <div className="bg-white/95 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 p-3">
          <div className="flex items-center space-x-3">
            {/* 时间显示 */}
            <div className="flex items-center space-x-2">
              <span className="text-lg">{getTimeIcon(currentHour)}</span>
              <div className="text-sm">
                <div className="font-medium text-gray-800">{formatTime(localDate)}</div>
                <div className="text-xs text-gray-500">{getTimeLabel(currentHour)}</div>
              </div>
            </div>

            {/* 播放控制 */}
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

            {/* 同步到当前时间 */}
            <button
              onClick={syncToCurrentTime}
              className="w-8 h-8 rounded-full bg-blue-100 hover:bg-blue-200 flex items-center justify-center text-blue-600 text-sm transition-all"
              title="同步到当前时间"
            >
              🔄
            </button>

            {/* 展开按钮 */}
            <button
              onClick={() => setIsExpanded(true)}
              className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-600 text-sm transition-all"
              title="展开时间轴"
            >
              ⏰
            </button>
          </div>
        </div>
      )}

      {/* 展开模式 - 详细时间轴 */}
      {isExpanded && (
        <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-xl border border-gray-200 p-4 w-96">
          {/* 头部控制 */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-2">
              <span className="text-lg">{getTimeIcon(currentHour)}</span>
              <div>
                <div className="font-medium text-gray-800">{formatTime(localDate)}</div>
                <div className="text-xs text-gray-500">{formatDate(localDate)}</div>
              </div>
            </div>
            
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
              
              <button
                onClick={syncToCurrentTime}
                className="w-8 h-8 rounded-full bg-blue-100 hover:bg-blue-200 flex items-center justify-center text-blue-600 text-sm transition-all"
                title="同步到当前时间"
              >
                🔄
              </button>
              
              <button
                onClick={() => setIsExpanded(false)}
                className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-600 text-sm transition-all"
                title="收起"
              >
                ✕
              </button>
            </div>
          </div>

          {/* 时间轴 */}
          <div className="relative mb-4">
            <div className="h-2 bg-gray-200 rounded-full">
              {/* 时间段背景 */}
              <div className="h-2 bg-gradient-to-r from-indigo-400 via-yellow-400 to-indigo-400 rounded-full opacity-30"></div>
              
              {/* 时间点按钮 */}
              <div className="absolute inset-0 flex">
                {Array.from({ length: 24 }, (_, hour) => (
                  <button
                    key={hour}
                    onClick={() => handleTimeClick(hour)}
                    className={`flex-1 h-2 relative group transition-all ${
                      hour === currentHour
                        ? 'bg-orange-500 rounded-full'
                        : 'hover:bg-white/50 rounded-full'
                    }`}
                    title={`${hour.toString().padStart(2, '0')}:00`}
                  >
                    {/* 小时标记 */}
                    {hour % 4 === 0 && (
                      <div className="absolute -bottom-6 left-1/2 transform -translate-x-1/2 text-xs text-gray-600">
                        {hour}
                      </div>
                    )}
                  </button>
                ))}
              </div>

              {/* 当前时间指示器 */}
              <div 
                className="absolute top-1/2 transform -translate-y-1/2 w-3 h-3 bg-orange-500 rounded-full shadow-lg"
                style={{ 
                  left: `${timeProgress}%`,
                  transform: 'translateX(-50%) translateY(-50%)'
                }}
              >
                <div className="absolute inset-0 bg-orange-500 rounded-full animate-ping opacity-75"></div>
              </div>
            </div>
          </div>

          {/* 速度控制 */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">播放速度</span>
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

          {/* 快速时间按钮 */}
          <div className="mt-3 grid grid-cols-4 gap-2">
            {[
              { hour: 6, label: '日出' },
              { hour: 12, label: '正午' },
              { hour: 18, label: '日落' },
              { hour: 0, label: '午夜' }
            ].map(({ hour, label }) => (
              <button
                key={hour}
                onClick={() => handleTimeClick(hour)}
                className={`px-3 py-2 text-xs rounded-lg border transition-all ${
                  currentHour === hour
                    ? 'border-orange-500 bg-orange-50 text-orange-700'
                    : 'border-gray-200 hover:border-orange-300 hover:bg-orange-50'
                }`}
              >
                {getTimeIcon(hour)} {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
