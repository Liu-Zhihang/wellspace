import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { MapComponent } from './components/Map/MapComponent'
import { MapboxMapComponent } from './components/Map/MapboxMapComponent'
import { Wfs3DShadowMapFixed } from './components/Map/Wfs3DShadowMapFixed'
import { CleanShadowMap } from './components/Map/CleanShadowMap'
import { ReferenceInspiredSearch } from './components/UI/ReferenceInspiredSearch'
import { ReferenceInspiredControls } from './components/UI/ReferenceInspiredControls'
import { ReferenceInspiredTimeline } from './components/UI/ReferenceInspiredTimeline'
import { BackendStatusChecker } from './components/UI/BackendStatusChecker'
import { SimpleControlPanel } from './components/UI/SimpleControlPanel'
import { LeftIconToolbar } from './components/UI/LeftIconToolbar'
import './App.css'

// Create a shared query client for data fetching
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 10 * 60 * 1000, // 10 minutes
    },
  },
})

function App() {
  const [mapMode, setMapMode] = useState<'mapbox' | 'leaflet' | 'wfs3d' | 'clean'>('clean') // Switch map engine

  return (
    <QueryClientProvider client={queryClient}>
      <div className="h-screen w-screen relative bg-gray-900 overflow-hidden">
        {/* Top header */}
        <header className="shadow-map-header pointer-events-none fixed top-6 left-1/2 z-50 -translate-x-1/2">
          <div
            className="pointer-events-auto items-center gap-4 rounded-2xl border border-gray-200 bg-white px-6 py-3 shadow-xl"
            style={{ display: 'inline-flex', width: 'auto' }}
          >
            <h1 className="text-lg font-bold text-gray-800 whitespace-nowrap">
              🌅 Shadow Map Analysis
            </h1>
            <div className="flex items-center text-xs font-medium text-gray-600 bg-gray-100 px-2.5 py-1 rounded-full shadow-sm">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full mr-1.5"></div>
              {mapMode === 'clean' ? 'Clean 3D' : mapMode === 'wfs3d' ? 'WFS 3D' : mapMode === 'mapbox' ? 'Mapbox GL' : 'Leaflet'}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMapMode('clean')}
                className={`text-xs px-3 py-1.5 rounded-full transition-colors font-medium ${
                  mapMode === 'clean' 
                    ? 'bg-emerald-500 text-white shadow-sm'
                    : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-100'
                }`}
              >
                Clean 3D
              </button>
              <button
                onClick={() => setMapMode('wfs3d')}
                className={`text-xs px-3 py-1.5 rounded-full transition-colors font-medium ${
                  mapMode === 'wfs3d' 
                    ? 'bg-emerald-500 text-white shadow-sm'
                    : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-100'
                }`}
              >
                WFS 3D
              </button>
              <button
                onClick={() => setMapMode('mapbox')}
                className={`text-xs px-3 py-1.5 rounded-full transition-colors font-medium ${
                  mapMode === 'mapbox' 
                    ? 'bg-sky-500 text-white shadow-sm'
                    : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-100'
                }`}
              >
                Mapbox
              </button>
              <button
                onClick={() => setMapMode('leaflet')}
                className={`text-xs px-3 py-1.5 rounded-full transition-colors font-medium ${
                  mapMode === 'leaflet' 
                    ? 'bg-violet-500 text-white shadow-sm'
                    : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-100'
                }`}
              >
                Leaflet
              </button>
            </div>
          </div>
        </header>

        {/* Map viewport */}
        <main className="absolute inset-0">
          {mapMode === 'clean' ? (
            <CleanShadowMap className="w-full h-full" />
          ) : mapMode === 'wfs3d' ? (
            <Wfs3DShadowMapFixed className="w-full h-full" />
          ) : mapMode === 'mapbox' ? (
            <MapboxMapComponent className="w-full h-full" />
          ) : (
            <MapComponent className="w-full h-full" />
          )}
        </main>

        {/* Mode specific UI */}
        {mapMode === 'clean' ? (
          <>
            <LeftIconToolbar />
            <ReferenceInspiredTimeline />
          </>
        ) : (
          <>
            <BackendStatusChecker />
            <SimpleControlPanel />
            <ReferenceInspiredSearch />
            <ReferenceInspiredControls />
            <ReferenceInspiredTimeline />
          </>
        )}
      </div>
    </QueryClientProvider>
  )
}

export default App
