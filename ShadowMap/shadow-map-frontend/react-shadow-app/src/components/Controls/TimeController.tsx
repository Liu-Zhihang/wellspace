import React, { useState, useEffect, useRef } from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { useShadowMap } from '../../hooks/useShadowMap';

export const TimeController: React.FC = () => {
  const {
    currentDate,
    setCurrentDate,
    shadowSettings,
    updateShadowSettings,
  } = useShadowMapStore();

  const { updateSunPosition } = useShadowMap();
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1); // 倍速：1=1小时/秒，2=2小时/秒等
  const [selectedDate, setSelectedDate] = useState(currentDate);
  const intervalRef = useRef<number | null>(null);

  // 播放/暂停动画
  const togglePlayback = () => {
    if (isPlaying) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      intervalRef.current = window.setInterval(() => {
        const newDate = new Date(currentDate);
        newDate.setHours(newDate.getHours() + playSpeed);
        setCurrentDate(newDate);
      }, 1000); // 每秒更新
    }
  };

  // 停止动画
  const stopPlayback = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPlaying(false);
    setCurrentDate(selectedDate);
  };

  // 时间快进
  const fastForward = (hours: number) => {
    const newDate = new Date(currentDate);
    newDate.setHours(newDate.getHours() + hours);
    setCurrentDate(newDate);
    setSelectedDate(newDate);
  };

  // 时间快退
  const fastBackward = (hours: number) => {
    const newDate = new Date(currentDate);
    newDate.setHours(newDate.getHours() - hours);
    setCurrentDate(newDate);
    setSelectedDate(newDate);
  };

  // 设置预设时间
  const setPresetTime = (hour: number) => {
    const newDate = new Date(currentDate);
    newDate.setHours(hour, 0, 0, 0);
    setCurrentDate(newDate);
    setSelectedDate(newDate);
  };

  // 格式化日期时间
  const formatDateForInput = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  // 解析输入的日期时间
  const parseDateFromInput = (value: string): Date => {
    return new Date(value);
  };

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  // 当日期改变时更新太阳位置
  useEffect(() => {
    updateSunPosition();
  }, [currentDate]);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4">
      {/* 简洁的标题 */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-gray-800">时间控制</h3>
        {isPlaying && (
          <div className="flex items-center gap-1 text-xs text-green-600">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            播放中
          </div>
        )}
      </div>

      {/* 精简的日期时间 */}
      <div className="space-y-3">
        <input
          type="datetime-local"
          value={formatDateForInput(currentDate)}
          onChange={(e) => {
            const newDate = parseDateFromInput(e.target.value);
            setCurrentDate(newDate);
            setSelectedDate(newDate);
          }}
          className="w-full px-4 py-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
        />

        {/* 精简的快捷时间 */}
        <div className="flex gap-2">
          <button onClick={() => setPresetTime(6)} className="flex-1 py-2 text-sm bg-gradient-to-r from-orange-50 to-yellow-50 hover:from-orange-100 hover:to-yellow-100 text-orange-700 rounded-lg transition-all">
            🌅 日出
          </button>
          <button onClick={() => setPresetTime(12)} className="flex-1 py-2 text-sm bg-gradient-to-r from-yellow-50 to-orange-50 hover:from-yellow-100 hover:to-orange-100 text-yellow-700 rounded-lg transition-all">
            ☀️ 正午
          </button>
          <button onClick={() => setPresetTime(18)} className="flex-1 py-2 text-sm bg-gradient-to-r from-orange-50 to-red-50 hover:from-orange-100 hover:to-red-100 text-orange-700 rounded-lg transition-all">
            🌇 日落
          </button>
        </div>
      </div>

      {/* 简化的播放控制 */}
      <div className="flex items-center justify-center gap-3 py-2">
        <button
          onClick={() => fastBackward(1)}
          className="w-10 h-10 flex items-center justify-center bg-gray-50 hover:bg-gray-100 rounded-full transition-colors"
          title="后退1小时"
        >
          ⏪
        </button>
        <button
          onClick={togglePlayback}
          className={`w-12 h-12 flex items-center justify-center rounded-full transition-all ${
            isPlaying 
              ? 'bg-red-50 hover:bg-red-100 text-red-600' 
              : 'bg-green-50 hover:bg-green-100 text-green-600'
          }`}
        >
          {isPlaying ? '⏸️' : '▶️'}
        </button>
        <button
          onClick={() => fastForward(1)}
          className="w-10 h-10 flex items-center justify-center bg-gray-50 hover:bg-gray-100 rounded-full transition-colors"
          title="前进1小时"
        >
          ⏩
        </button>
      </div>

      {/* 简化的速度控制 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>播放速度</span>
          <span className="font-medium">{playSpeed}x</span>
        </div>
        <input
          type="range"
          min="0.5"
          max="6"
          step="0.5"
          value={playSpeed}
          onChange={(e) => setPlaySpeed(parseFloat(e.target.value))}
          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer slider"
        />
      </div>
    </div>
  );
};
