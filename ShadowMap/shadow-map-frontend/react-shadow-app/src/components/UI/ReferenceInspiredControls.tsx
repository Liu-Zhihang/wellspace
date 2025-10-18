import React, { useState } from 'react'
import { useShadowMapStore } from '../../store/shadowMapStore'

type AccentKey = 'sky' | 'emerald' | 'violet' | 'amber' | 'slate'

export const ReferenceInspiredControls: React.FC = () => {
  const { mapSettings, updateMapSettings } = useShadowMapStore()
  const [activePanel, setActivePanel] = useState<string | null>(null)

  const controlButtons = [
    { id: 'search', icon: '🔍', label: 'Search', color: 'sky' as AccentKey },
    { id: 'layers', icon: '🗺️', label: 'Layers', color: 'emerald' as AccentKey },
    { id: '3d', icon: '🏗️', label: '3D View', color: 'violet' as AccentKey },
    { id: 'zoom-in', icon: '➕', label: 'Zoom in', color: 'slate' as AccentKey },
    { id: 'zoom-out', icon: '➖', label: 'Zoom out', color: 'slate' as AccentKey },
    { id: 'info', icon: 'ℹ️', label: 'Info', color: 'amber' as AccentKey },
  ]

  const accentStyles: Record<AccentKey, { inactive: string; active: string; ring: string }> = {
    sky: {
      inactive: 'text-sky-600 hover:bg-sky-50',
      active: 'bg-sky-500 text-white shadow-lg',
      ring: 'focus:ring-sky-300',
    },
    emerald: {
      inactive: 'text-emerald-600 hover:bg-emerald-50',
      active: 'bg-emerald-500 text-white shadow-lg',
      ring: 'focus:ring-emerald-300',
    },
    violet: {
      inactive: 'text-violet-600 hover:bg-violet-50',
      active: 'bg-violet-500 text-white shadow-lg',
      ring: 'focus:ring-violet-300',
    },
    amber: {
      inactive: 'text-amber-600 hover:bg-amber-50',
      active: 'bg-amber-500 text-white shadow-lg',
      ring: 'focus:ring-amber-300',
    },
    slate: {
      inactive: 'text-slate-600 hover:bg-slate-100',
      active: 'bg-slate-700 text-white shadow-lg',
      ring: 'focus:ring-slate-400',
    },
  }

  const handleControlClick = (controlId: string) => {
    if (controlId === 'zoom-in') {
      console.log('Zooming in')
    } else if (controlId === 'zoom-out') {
      console.log('Zooming out')
    } else if (controlId === '3d') {
      console.log('Switching 3D mode')
    } else {
      setActivePanel(activePanel === controlId ? null : controlId)
    }
  }

  const getButtonClasses = (color: AccentKey, isActive: boolean) => {
    const accent = accentStyles[color]
    return [
      'w-12 h-12 rounded-xl flex items-center justify-center text-xl transition-all duration-150 shadow-md bg-white/95 backdrop-blur focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white',
      accent.ring,
      isActive ? accent.active : accent.inactive,
    ].join(' ')
  }

  return (
    <div className="fixed top-8 right-6 z-40 flex flex-col space-y-3">
      {controlButtons.map((button) => (
        <div key={button.id} className="relative">
          <button
            onClick={() => handleControlClick(button.id)}
            className={getButtonClasses(button.color, activePanel === button.id)}
            title={button.label}
          >
            {button.icon}
          </button>

          {activePanel === button.id && (
            <div className="absolute top-0 right-14 bg-white/95 backdrop-blur-md rounded-xl shadow-2xl border border-white/30 p-4 min-w-[220px]">
              {button.id === 'layers' && (
                <div>
                  <h3 className="font-medium text-gray-800 mb-3">Layer options</h3>
                  <div className="space-y-3">
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm text-gray-700">Filtered buildings</span>
                      <input
                        type="checkbox"
                        checked={mapSettings.enableBuildingFilter}
                        onChange={(event) =>
                          updateMapSettings({ enableBuildingFilter: event.target.checked })
                        }
                        className="rounded border-gray-300 focus:ring-sky-300 focus:border-sky-300"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm text-gray-700">Auto optimise</span>
                      <input
                        type="checkbox"
                        checked={!!mapSettings.autoOptimize}
                        onChange={(event) =>
                          updateMapSettings({ autoOptimize: event.target.checked })
                        }
                        className="rounded border-gray-300 focus:ring-sky-300 focus:border-sky-300"
                      />
                    </label>
                  </div>
                </div>
              )}

              {button.id === 'info' && (
                <div className="space-y-2 text-sm text-gray-600">
                  <h3 className="font-medium text-gray-800">Application details</h3>
                  <div className="grid gap-1">
                    <div>Version: v2.0</div>
                    <div>Shadow engine: Mapbox GL</div>
                    <div>Sources: OSM + DEM</div>
                    <div>Query mode: full fidelity</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      <div className="mt-5 bg-white/95 backdrop-blur-md rounded-2xl shadow-2xl border border-white/40 p-4">
        <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-3 text-center">
          Shadow presets
        </div>
        <div className="flex items-center justify-between gap-2">
          {[
            { opacity: 0.3, color: '#bdc3c7', label: 'Light' },
            { opacity: 0.5, color: '#7f8c8d', label: 'Medium' },
            { opacity: 0.7, color: '#2c3e50', label: 'Deep' },
          ].map((preset) => (
            <button
              key={preset.label}
              onClick={() =>
                updateMapSettings({
                  shadowOpacity: preset.opacity,
                  shadowColor: preset.color,
                })
              }
              className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg transition-all duration-150 border ${
                Math.abs(mapSettings.shadowOpacity - preset.opacity) < 0.1
                  ? 'border-sky-400 bg-sky-50 text-sky-700 shadow-sm'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'
              }`}
              title={preset.label}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
