import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ShadowMapViewport } from './components/Map/ShadowMapViewport'
import { LeftIconToolbar } from './components/UI/LeftIconToolbar'
import { useShadowMapStore } from './store/shadowMapStore'
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
  const baseMapId = useShadowMapStore((state) => state.mapSettings.baseMapId ?? 'mapbox-streets')
  return (
    <QueryClientProvider client={queryClient}>
      <div className="relative flex h-full w-full overflow-hidden bg-slate-900">
        <main className="relative h-full w-full">
          <ShadowMapViewport baseMapId={baseMapId} className="h-full w-full" />
        </main>
        <LeftIconToolbar />
      </div>
    </QueryClientProvider>
  )
}

export default App
