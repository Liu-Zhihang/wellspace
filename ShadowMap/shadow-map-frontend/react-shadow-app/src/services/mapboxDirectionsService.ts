import mapboxgl from 'mapbox-gl'

export type MapboxDirectionsProfile = 'walking' | 'driving' | 'cycling'

export type MapboxLngLat = {
  lng: number
  lat: number
}

type MapboxDirectionsRoute = {
  distance?: number
  duration?: number
  geometry?: {
    coordinates?: Array<[number, number]>
  }
}

type MapboxDirectionsResponse = {
  code?: string
  message?: string
  routes?: MapboxDirectionsRoute[]
}

const getMapboxAccessToken = () => {
  const envToken =
    (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined) ??
    (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) ??
    undefined
  const runtimeToken = (mapboxgl as unknown as { accessToken?: string })?.accessToken
  return envToken ?? runtimeToken ?? ''
}

export type DirectionsRouteResult = {
  coordinates: Array<[number, number]>
  distanceMeters: number
  durationSeconds: number
}

export const fetchDirectionsRoute = async (options: {
  profile: MapboxDirectionsProfile
  start: MapboxLngLat
  end: MapboxLngLat
  accessToken?: string
}): Promise<DirectionsRouteResult> => {
  const token = options.accessToken ?? getMapboxAccessToken()
  if (!token) {
    throw new Error('Mapbox access token is missing (set VITE_MAPBOX_ACCESS_TOKEN or configure mapboxgl.accessToken).')
  }

  const start = `${options.start.lng},${options.start.lat}`
  const end = `${options.end.lng},${options.end.lat}`
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/${options.profile}/${start};${end}` +
    `?alternatives=false&geometries=geojson&overview=full&steps=false&access_token=${encodeURIComponent(token)}`

  const response = await fetch(url)
  if (!response.ok) {
    const hint = await response.text().catch(() => '')
    throw new Error(`Directions request failed: ${response.status} ${response.statusText}${hint ? ` (${hint})` : ''}`)
  }

  const payload = (await response.json()) as MapboxDirectionsResponse
  const route = payload.routes?.[0]
  const coordinates = route?.geometry?.coordinates
  if (!coordinates || coordinates.length < 2) {
    const message = payload.message ?? payload.code ?? 'No route returned'
    throw new Error(`Directions response missing geometry: ${message}`)
  }

  return {
    coordinates,
    distanceMeters: Number(route.distance ?? 0),
    durationSeconds: Number(route.duration ?? 0),
  }
}
