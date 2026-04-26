import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const assignmentPattern = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

const parseAssignedValue = (rawValue: string): string => {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    return ''
  }

  const quote = trimmed[0]
  if (quote === '"' || quote === "'") {
    let value = ''
    let escaped = false

    for (let index = 1; index < trimmed.length; index += 1) {
      const char = trimmed[index]
      if (char === undefined) {
        break
      }

      if (quote === '"' && escaped) {
        if (char === 'n') {
          value += '\n'
        } else if (char === 'r') {
          value += '\r'
        } else if (char === 't') {
          value += '\t'
        } else {
          value += char
        }
        escaped = false
        continue
      }

      if (quote === '"' && char === '\\') {
        escaped = true
        continue
      }

      if (char === quote) {
        return value
      }

      value += char
    }

    return value
  }

  return trimmed.replace(/\s+#.*$/, '').trim()
}

const expandValue = (value: string, scope: Record<string, string | undefined>): string =>
  value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
    const key = String(braced ?? plain ?? '')
    return scope[key] ?? ''
  })

const parseEnvFile = (filePath: string, baseScope: Record<string, string | undefined>): Record<string, string> => {
  const parsed: Record<string, string> = {}
  const scope: Record<string, string | undefined> = { ...baseScope }
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const match = line.match(assignmentPattern)
    if (!match) {
      continue
    }

    const key = match[1]
    const rawValue = match[2] ?? ''
    if (!key) {
      continue
    }

    const value = expandValue(parseAssignedValue(rawValue), scope)
    parsed[key] = value
    scope[key] = value
  }

  return parsed
}

const loadShadowMapProfile = (repoRoot: string): Record<string, string> => {
  const requestedProfile = process.env.SHADOWMAP_ENV_FILE
  if (requestedProfile === '/dev/null') {
    return {}
  }

  const profilePath = requestedProfile
    ? path.isAbsolute(requestedProfile)
      ? requestedProfile
      : path.resolve(repoRoot, requestedProfile)
    : path.resolve(repoRoot, '.shadowmap.env')

  if (!fs.existsSync(profilePath)) {
    return {}
  }

  return parseEnvFile(profilePath, process.env)
}

const normalizeOptionalValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

const normalizeOrigin = (value: string | undefined, fallback: string): string =>
  (normalizeOptionalValue(value) ?? fallback).replace(/\/+$/, '')

const originFromUrl = (value: string | undefined): string | undefined => {
  const trimmed = normalizeOptionalValue(value)
  if (!trimmed) {
    return undefined
  }

  try {
    const parsed = new URL(trimmed)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return undefined
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, '../..')
  const viteEnv = loadEnv(mode, __dirname, '')
  const profileEnv = loadShadowMapProfile(repoRoot)

  const backendOrigin = normalizeOrigin(
    process.env.SHADOWMAP_BACKEND_ORIGIN ??
      profileEnv.SHADOWMAP_BACKEND_ORIGIN ??
      process.env.SHADOW_ENGINE_BACKEND_URL ??
      profileEnv.SHADOW_ENGINE_BACKEND_URL ??
      originFromUrl(process.env.BACKEND_URL ?? profileEnv.BACKEND_URL) ??
      viteEnv.VITE_BACKEND_BASE_URL,
    'http://localhost:3001',
  )

  const engineOrigin = normalizeOptionalValue(
    process.env.SHADOWMAP_ENGINE_ORIGIN ??
      profileEnv.SHADOWMAP_ENGINE_ORIGIN ??
      process.env.SHADOW_ENGINE_BASE_URL ??
      profileEnv.SHADOW_ENGINE_BASE_URL,
  ) ?? ''

  const mapboxAccessToken = normalizeOptionalValue(
    process.env.SHADOWMAP_MAPBOX_ACCESS_TOKEN ??
      profileEnv.SHADOWMAP_MAPBOX_ACCESS_TOKEN ??
      process.env.MAPBOX_ACCESS_TOKEN ??
      profileEnv.MAPBOX_ACCESS_TOKEN ??
      viteEnv.VITE_MAPBOX_ACCESS_TOKEN,
  ) ?? ''

  const canopyRasterPath = normalizeOptionalValue(
    process.env.SHADOW_ENGINE_CANOPY_RASTER_PATH ??
      profileEnv.SHADOW_ENGINE_CANOPY_RASTER_PATH ??
      process.env.CANOPY_RASTER_PATH ??
      profileEnv.CANOPY_RASTER_PATH ??
      viteEnv.VITE_CANOPY_RASTER_PATH,
  ) ?? ''

  return {
    plugins: [react()],
    define: {
      global: 'globalThis',
      __SHADOWMAP_BACKEND_ORIGIN__: JSON.stringify(backendOrigin),
      __SHADOWMAP_ENGINE_ORIGIN__: JSON.stringify(engineOrigin),
      __SHADOWMAP_MAPBOX_ACCESS_TOKEN__: JSON.stringify(mapboxAccessToken),
      __SHADOWMAP_CANOPY_RASTER_PATH__: JSON.stringify(canopyRasterPath),
    },
    optimizeDeps: {
      include: ['leaflet', 'leaflet-shadow-simulator', 'suncalc']
    },
    server: {
      port: 5173,
      host: true,
      fs: {
        allow: ['..', '../..']
      }
    }
  }
})
