/**
 * 简化的控制面板
 * 解决用户找不到按钮的问题
 */

import React, { useState } from 'react'
import { useShadowMapStore } from '../../store/shadowMapStore'

export const SimpleControlPanel: React.FC = () => {
  const { mapSettings, updateMapSettings } = useShadowMapStore()
  const [isOpen, setIsOpen] = useState(false)

  const toggleBuildings = () => {
    updateMapSettings({
      showBuildingLayer: !mapSettings.showBuildingLayer,
      dataLayers: {
        ...mapSettings.dataLayers,
        buildings: {
          ...mapSettings.dataLayers.buildings,
          enabled: !mapSettings.showBuildingLayer,
        },
      },
    })
  }

  const toggleShadows = () => {
    updateMapSettings({
      showShadowLayer: !mapSettings.showShadowLayer,
      dataLayers: {
        ...mapSettings.dataLayers,
        shadows: {
          ...mapSettings.dataLayers.shadows,
          enabled: !mapSettings.showShadowLayer,
        },
      },
    })
  }

  return (
    <div className="fixed top-24 right-6 z-40">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-16 h-16 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-2xl flex items-center justify-center text-2xl font-bold transition-all duration-200 hover:scale-110"
        title="Toggle control panel"
      >
        ⚙️
      </button>

      {isOpen && (
        <div className="absolute top-24 right-0 bg-white rounded-2xl shadow-2xl border border-gray-200/80 p-6 min-w-[300px]">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-800">Map controls</h3>
            <button
              onClick={() => setIsOpen(false)}
              className="text-gray-500 hover:text-gray-700 text-xl"
              aria-label="Close panel"
            >
              ✕
            </button>
          </div>

          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-700">🏢 Building layer</span>
              <button
                onClick={toggleBuildings}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mapSettings.showBuildingLayer
                    ? 'bg-green-100 text-green-800 border-2 border-green-300'
                    : 'bg-gray-100 text-gray-600 border-2 border-gray-300'
                }`}
              >
                {mapSettings.showBuildingLayer ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            <div className="text-xs text-gray-500 mb-2">
              {mapSettings.showBuildingLayer
                ? '✅ Display outlines and height data for loaded buildings.'
                : '❌ Hide the building extrusion layer.'}
            </div>
          </div>

          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-700">🌑 Shadow layer</span>
              <button
                onClick={toggleShadows}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mapSettings.showShadowLayer
                    ? 'bg-green-100 text-green-800 border-2 border-green-300'
                    : 'bg-gray-100 text-gray-600 border-2 border-gray-300'
                }`}
              >
                {mapSettings.showShadowLayer ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            <div className="text-xs text-gray-500 mb-2">
              {mapSettings.showShadowLayer
                ? '✅ Render realtime shadow overlays on the map.'
                : '❌ Hide the shadow overlay layer.'}
            </div>
          </div>

          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-700">🔍 Building filter</span>
              <button
                onClick={() =>
                  updateMapSettings({ enableBuildingFilter: !mapSettings.enableBuildingFilter })
                }
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mapSettings.enableBuildingFilter
                    ? 'bg-orange-100 text-orange-800 border-2 border-orange-300'
                    : 'bg-gray-100 text-gray-600 border-2 border-gray-300'
                }`}
              >
                {mapSettings.enableBuildingFilter ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            <div className="text-xs text-gray-500 mb-2">
              {mapSettings.enableBuildingFilter
                ? '🔧 Highlight key buildings to keep the shadow view lightweight.'
                : '🏗️ Show the complete building dataset for full detail.'}
            </div>
          </div>

          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-600 space-y-1">
              <div className="flex items-center">
                <div
                  className={`w-2 h-2 rounded-full mr-2 ${
                    mapSettings.showBuildingLayer ? 'bg-green-500' : 'bg-gray-400'
                  }`}
                ></div>
                Buildings: {mapSettings.showBuildingLayer ? 'Visible' : 'Hidden'}
              </div>
              <div className="flex items-center">
                <div
                  className={`w-2 h-2 rounded-full mr-2 ${
                    mapSettings.showShadowLayer ? 'bg-green-500' : 'bg-gray-400'
                  }`}
                ></div>
                Shadows: {mapSettings.showShadowLayer ? 'Visible' : 'Hidden'}
              </div>
              <div className="flex items-center">
                <div
                  className={`w-2 h-2 rounded-full mr-2 ${
                    mapSettings.enableBuildingFilter ? 'bg-orange-500' : 'bg-gray-400'
                  }`}
                ></div>
                Filter: {mapSettings.enableBuildingFilter ? 'Active' : 'Inactive'}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default SimpleControlPanel
