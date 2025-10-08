/**
 * 简洁优雅的统一控制面板
 * 将多个功能整合到一个浮动面板中
 */

import React, { useState } from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';

export const CompactControlPanel: React.FC = () => {
  const { mapSettings, updateMapSettings } = useShadowMapStore();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'shadow' | 'buildings' | 'strategy'>('shadow');

  return (
    <div className="absolute top-4 right-4 z-20">
      {/* 主控制按钮 */}
      <div className="flex items-center space-x-2">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={`p-3 rounded-xl shadow-lg transition-all duration-200 ${
            isOpen ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
          }`}
          title="阴影控制"
        >
          <span className="text-xl">🎨</span>
        </button>
        
        {/* 快速状态指示器 */}
        <div className="flex items-center space-x-1">
          <div className={`w-2 h-2 rounded-full ${
            mapSettings.enableBuildingFilter ? 'bg-orange-400' : 'bg-green-400'
          }`} title={mapSettings.enableBuildingFilter ? '已启用建筑筛选' : '显示所有建筑'} />
          <div className={`w-2 h-2 rounded-full ${
            mapSettings.autoOptimize ? 'bg-blue-400' : 'bg-gray-300'
          }`} title={mapSettings.autoOptimize ? '自动优化已启用' : '手动模式'} />
        </div>
      </div>

      {/* 控制面板 */}
      {isOpen && (
        <div className="absolute top-16 right-0 w-80 bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden">
          {/* 标签切换 */}
          <div className="flex border-b border-gray-100">
            {[
              { id: 'shadow', name: '阴影', icon: '🎨' },
              { id: 'buildings', name: '建筑', icon: '🏗️' },
              { id: 'strategy', name: '策略', icon: '⚙️' }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex-1 py-3 px-4 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600'
                    : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
                }`}
              >
                <span className="mr-1">{tab.icon}</span>
                {tab.name}
              </button>
            ))}
          </div>

          {/* 面板内容 */}
          <div className="p-4 max-h-96 overflow-y-auto">
            {activeTab === 'shadow' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">阴影透明度</span>
                  <span className="text-xs text-gray-500">{Math.round(mapSettings.shadowOpacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.1"
                  value={mapSettings.shadowOpacity}
                  onChange={(e) => updateMapSettings({ shadowOpacity: parseFloat(e.target.value) })}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                />

                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">阴影颜色</span>
                  <input
                    type="color"
                    value={mapSettings.shadowColor}
                    onChange={(e) => updateMapSettings({ shadowColor: e.target.value })}
                    className="w-8 h-8 rounded cursor-pointer border border-gray-300"
                  />
                </div>

                <div className="flex items-center space-x-3">
                  <label className="flex items-center space-x-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mapSettings.autoOptimize}
                      onChange={(e) => updateMapSettings({ autoOptimize: e.target.checked })}
                      className="rounded"
                    />
                    <span className="text-sm text-gray-700">自动优化</span>
                  </label>
                </div>

                {/* 快速预设 */}
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { name: '清晰', opacity: 0.8, color: '#2c3e50' },
                    { name: '柔和', opacity: 0.5, color: '#7f8c8d' },
                    { name: '淡化', opacity: 0.3, color: '#bdc3c7' },
                    { name: '隐藏', opacity: 0.1, color: '#ecf0f1' }
                  ].map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => updateMapSettings({ 
                        shadowOpacity: preset.opacity, 
                        shadowColor: preset.color 
                      })}
                      className="px-3 py-2 text-xs rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-colors"
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'buildings' && (
              <div className="space-y-4">
                <div className="flex items-center space-x-3">
                  <label className="flex items-center space-x-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mapSettings.enableBuildingFilter}
                      onChange={(e) => updateMapSettings({ enableBuildingFilter: e.target.checked })}
                      className="rounded"
                    />
                    <span className="text-sm font-medium text-gray-700">启用建筑筛选</span>
                  </label>
                </div>
                
                <div className="text-xs text-gray-500 p-3 bg-gray-50 rounded-lg">
                  {mapSettings.enableBuildingFilter ? 
                    '🔧 只显示重要建筑，减少阴影密度' : 
                    '🏗️ 显示所有建筑物，完整阴影效果'
                  }
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {[
                    { name: '显示全部', filter: false },
                    { name: '重要建筑', filter: true }
                  ].map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => updateMapSettings({ enableBuildingFilter: preset.filter })}
                      className={`px-3 py-2 text-xs rounded-lg border transition-colors ${
                        mapSettings.enableBuildingFilter === preset.filter
                          ? 'border-blue-500 bg-blue-50 text-blue-700'
                          : 'border-gray-200 hover:border-blue-300 hover:bg-blue-50'
                      }`}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'strategy' && (
              <div className="space-y-4">
                <div className="p-3 bg-green-50 rounded-lg border border-green-200">
                  <div className="flex items-center space-x-2 mb-2">
                    <span className="text-green-600">✅</span>
                    <span className="text-sm font-medium text-green-800">当前策略</span>
                  </div>
                  <div className="text-sm text-green-700">
                    完整查询 - 查询所有60+种建筑类型
                  </div>
                  <div className="text-xs text-green-600 mt-1">
                    覆盖率: 100% | 确保不漏建筑物
                  </div>
                </div>

                <div className="space-y-2">
                  {[
                    { 
                      name: '完整查询', 
                      coverage: '100%', 
                      desc: '所有建筑类型',
                      active: true 
                    },
                    { 
                      name: '标准查询', 
                      coverage: '80%', 
                      desc: '主要建筑类型',
                      active: false 
                    },
                    { 
                      name: '快速查询', 
                      coverage: '40%', 
                      desc: '住宅商业',
                      active: false 
                    }
                  ].map((strategy, index) => (
                    <div
                      key={strategy.name}
                      className={`p-3 rounded-lg border ${
                        strategy.active 
                          ? 'border-green-300 bg-green-50' 
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-800">{strategy.name}</span>
                        <span className="text-xs bg-gray-100 px-2 py-1 rounded">
                          {strategy.coverage}
                        </span>
                      </div>
                      <div className="text-xs text-gray-600 mt-1">{strategy.desc}</div>
                    </div>
                  ))}
                </div>

                <div className="text-xs text-gray-500 p-2 bg-blue-50 rounded">
                  💡 系统已优化为完整查询，确保阴影覆盖所有建筑
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
