import React, { useState, useEffect } from 'react'
import { useShadowMapStore } from '../../store/shadowMapStore'

const speedOptions = [0.5, 1, 2, 4]

export const ReferenceInspiredTimeline: React.FC = () => {
  const { currentDate, setCurrentDate, isAnimating, setIsAnimating } = useShadowMapStore()

  const [localDate, setLocalDate] = useState(currentDate)
  const [speed, setSpeed] = useState(1)

  useEffect(() => {
    setCurrentDate(localDate)
  }, [localDate, setCurrentDate])

  useEffect(() => {
    if (!isAnimating) return

    const interval = setInterval(() => {
      setLocalDate((previous) => {
        const next = new Date(previous)
        next.setMinutes(next.getMinutes() + 10 * speed)
        if (next.getHours() >= 24) {
          next.setHours(0, 0, 0, 0)
          next.setDate(next.getDate() + 1)
        }
        return next
      })
    }, 300 / speed)

    return () => clearInterval(interval)
  }, [isAnimating, speed])

  const calculateSunPosition = (date: Date) => {
    const hour = date.getHours()
    const minute = date.getMinutes()
    const latitude = 39.9
    const dayOfYear = Math.floor(
      (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24),
    )
    const declination =
      23.45 * Math.sin(((360 * (284 + dayOfYear)) / 365) * Math.PI / 180)
    const hourAngle = (hour + minute / 60 - 12) * 15
    const elevation =
      Math.asin(
        Math.sin(latitude * Math.PI / 180) * Math.sin(declination * Math.PI / 180) +
          Math.cos(latitude * Math.PI / 180) *
            Math.cos(declination * Math.PI / 180) *
            Math.cos(hourAngle * Math.PI / 180),
      ) *
      180 /
      Math.PI
    const azimuth =
      Math.atan2(
        Math.sin(hourAngle * Math.PI / 180),
        Math.cos(hourAngle * Math.PI / 180) * Math.sin(latitude * Math.PI / 180) -
          Math.tan(declination * Math.PI / 180) * Math.cos(latitude * Math.PI / 180),
      ) *
        180 /
        Math.PI +
      180

    return {
      elevation: Math.max(0, elevation).toFixed(1),
      azimuth: azimuth.toFixed(1),
      direction: getDirection(azimuth),
    }
  }

  const getDirection = (azimuth: number) => {
    const directions = [
      'N',
      'NNE',
      'NE',
      'ENE',
      'E',
      'ESE',
      'SE',
      'SSE',
      'S',
      'SSW',
      'SW',
      'WSW',
      'W',
      'WNW',
      'NW',
      'NNW',
    ]
    const index = Math.round(azimuth / 22.5) % 16
    return directions[index]
  }

  const sunPosition = calculateSunPosition(localDate)

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })
  }

  const handleTimeClick = (hour: number) => {
    const next = new Date(localDate)
    next.setHours(hour, 0, 0, 0)
    setLocalDate(next)
  }

  const currentHour = localDate.getHours()
  const hours = Array.from({ length: 24 }, (_, index) => index)

  return (
    <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 z-40">
      <div className="bg-white/95 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 p-4 min-w-[800px] max-w-[90vw]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center space-x-1">
            {hours.map((hour) => (
              <button
                key={hour}
                onClick={() => handleTimeClick(hour)}
                className={`px-2 py-1 text-sm font-medium rounded transition-all ${
                  hour === currentHour
                    ? 'bg-blue-500 text-white shadow-md'
                    : 'text-gray-600 hover:text-blue-600 hover:bg-blue-50'
                }`}
                title={`Jump to ${hour.toString().padStart(2, '0')}:00`}
              >
                {hour.toString().padStart(2, '0')}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsAnimating(!isAnimating)}
              className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm transition-all ${
                isAnimating
                  ? 'bg-red-500 hover:bg-red-600'
                  : 'bg-green-500 hover:bg-green-600'
              }`}
              title={isAnimating ? 'Pause playback' : 'Start playback'}
            >
              {isAnimating ? '⏸️' : '▶️'}
            </button>

            <div className="flex items-center gap-2 rounded-full bg-gray-100 px-2 py-1">
              {speedOptions.map((option) => (
                <button
                  key={option}
                  onClick={() => setSpeed(option)}
                  className={`px-2 py-1 text-xs font-semibold rounded-full transition-colors ${
                    option === speed
                      ? 'bg-white text-blue-600 shadow-sm'
                      : 'text-gray-600 hover:text-blue-600'
                  }`}
                  disabled={!isAnimating}
                >
                  {option}x
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between text-sm text-gray-600">
          <div className="flex items-center space-x-4">
            <span className="font-medium">{formatDate(localDate)}</span>
            <span className="font-medium text-blue-600">{formatTime(localDate)}</span>
          </div>

          <div className="flex items-center space-x-4">
            <span>
              Solar elevation:{' '}
              <span className="font-medium text-orange-600">{sunPosition.elevation}°</span>
            </span>
            <span>
              Azimuth:{' '}
              <span className="font-medium text-orange-600">
                {sunPosition.azimuth}° {sunPosition.direction}
              </span>
            </span>
          </div>
        </div>

        <div className="relative mt-2">
          <div className="h-1 bg-gray-200 rounded-full">
            <div
              className="absolute top-0 h-1 w-1 bg-blue-500 rounded-full transition-all duration-300"
              style={{
                left: `${(currentHour / 23) * 100}%`,
                transform: 'translateX(-50%)',
              }}
            >
              <div className="absolute inset-0 bg-blue-500 rounded-full animate-ping opacity-75"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
