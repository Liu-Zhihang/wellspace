import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ShadowMapViewport } from './components/Map/ShadowMapViewport'
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
              Clean 3D Viewport
            </div>
          </div>
        </header>

        {/* Map viewport */}
        <main className="absolute inset-0">
          <ShadowMapViewport className="w-full h-full" />
        </main>

        <LeftIconToolbar />
      </div>
    </QueryClientProvider>
  )
}

export default App
