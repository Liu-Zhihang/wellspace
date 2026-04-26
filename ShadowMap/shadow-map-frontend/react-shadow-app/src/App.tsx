import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ShadowMapViewport } from './components/Map/ShadowMapViewport'
import { LeftIconToolbar } from './components/UI/LeftIconToolbar'
import { useShadowMapStore } from './store/shadowMapStore'
import './App.css'
import { useEffect } from 'react'

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
  const baseMapId = useShadowMapStore((state) => state.mapSettings.baseMapId ?? 'mapbox-streets')
  const figureModeEnabled = useShadowMapStore((state) => state.figureModeEnabled)
  const figureHudVisible = useShadowMapStore((state) => state.figureHudVisible)
  const setFigureModeEnabled = useShadowMapStore((state) => state.setFigureModeEnabled)
  const setFigureHudVisible = useShadowMapStore((state) => state.setFigureHudVisible)
  const updateMapSettings = useShadowMapStore((state) => state.updateMapSettings)
  const setMobilityFlowStyle = useShadowMapStore((state) => state.setMobilityFlowStyle)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const figure = params.get('figure') ?? params.get('fig')
    const baseMap = params.get('basemap')
    const mobilityStyle = params.get('trajectory') ?? params.get('mobility')

    if (figure === '1' || figure === 'true') {
      setFigureModeEnabled(true)
    }
    if (baseMap) {
      updateMapSettings({ baseMapId: baseMap })
    }
    if (mobilityStyle === 'path' || mobilityStyle === 'trips') {
      setMobilityFlowStyle(mobilityStyle)
    }
  }, [setFigureModeEnabled, setMobilityFlowStyle, updateMapSettings])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (key !== 'f' && key !== 'h') return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      event.preventDefault()
      if (key === 'f') {
        setFigureModeEnabled(!figureModeEnabled)
        return
      }
      if (key === 'h' && figureModeEnabled) {
        setFigureHudVisible(!figureHudVisible)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [figureHudVisible, figureModeEnabled, setFigureHudVisible, setFigureModeEnabled])

  return (
    <QueryClientProvider client={queryClient}>
      <div className="relative flex h-full w-full overflow-hidden bg-slate-900">
        <main className="relative h-full w-full">
          <ShadowMapViewport baseMapId={baseMapId} className="h-full w-full" />
        </main>
        {figureModeEnabled ? (figureHudVisible ? <LeftIconToolbar /> : null) : <LeftIconToolbar />}
      </div>
    </QueryClientProvider>
  )
}

export default App
