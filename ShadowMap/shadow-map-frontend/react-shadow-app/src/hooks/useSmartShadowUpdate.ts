import { useCallback, useRef, useEffect } from 'react';

interface ShadowUpdateOptions {
  moveDelay?: number;      // Delay applied after map move events
  zoomDelay?: number;      // Delay applied after zoom interactions
  timeDelay?: number;      // Delay applied after time slider changes
  minZoom?: number;        // Minimum zoom required before recalculating
}

/**
 * Smart shadow update hook that throttles expensive recomputations.
 */
export function useSmartShadowUpdate(
  updateFunction: () => void,
  options: ShadowUpdateOptions = {}
) {
  const {
    moveDelay = 300,
    zoomDelay = 500,
    timeDelay = 100,
    minZoom = 15
  } = options;

  const updateTimeoutRef = useRef<number | null>(null);
  const isInteractingRef = useRef(false);
  const lastUpdateRef = useRef({ center: '', zoom: 0, time: 0 });

  // Clear any pending timeout
  const clearUpdateTimeout = useCallback(() => {
    if (updateTimeoutRef.current !== null) {
      window.clearTimeout(updateTimeoutRef.current);
      updateTimeoutRef.current = null;
    }
  }, []);

  // Core throttling logic
  const smartUpdate = useCallback((
    type: 'move' | 'zoom' | 'time',
    currentZoom: number,
    center?: { lat: number; lng: number },
    currentTime?: number
  ) => {
    if (currentZoom < minZoom) {
      console.log(`⏸️ Zoom level ${currentZoom.toFixed(1)} is below ${minZoom}, skipping shadow update`);
      return;
    }

    const cacheKey = center ? `${center.lat.toFixed(3)},${center.lng.toFixed(3)}` : '';
    const timeKey = currentTime || Date.now();

    const lastUpdate = lastUpdateRef.current;
    if (type === 'move' &&
        lastUpdate.center === cacheKey &&
        Math.abs(lastUpdate.zoom - currentZoom) < 0.5) {
      console.log('📍 Map center unchanged; skipping shadow update');
      return;
    }

    if (type === 'time' &&
        Math.abs(timeKey - lastUpdate.time) < 30000) { // within 30 seconds
      console.log('⏰ Time delta under 30s; skipping shadow update');
      return;
    }

    clearUpdateTimeout();

    let delay = moveDelay;
    if (type === 'zoom') delay = zoomDelay;
    if (type === 'time') delay = timeDelay;

    console.log(`🔄 Scheduling shadow update (${type}, delay: ${delay}ms)`);

    updateTimeoutRef.current = window.setTimeout(() => {
      updateTimeoutRef.current = null;
      console.log(`✅ Executing shadow update (${type})`);

      lastUpdateRef.current = {
        center: cacheKey,
        zoom: currentZoom,
        time: timeKey
      };

      updateFunction();
      isInteractingRef.current = false;
    }, delay);

    isInteractingRef.current = true;
  }, [updateFunction, moveDelay, zoomDelay, timeDelay, minZoom, clearUpdateTimeout]);

  const onMapMove = useCallback((zoom: number, center: { lat: number; lng: number }) => {
    smartUpdate('move', zoom, center);
  }, [smartUpdate]);

  const onMapZoom = useCallback((zoom: number, center: { lat: number; lng: number }) => {
    smartUpdate('zoom', zoom, center);
  }, [smartUpdate]);

  const onTimeChange = useCallback((zoom: number, time: number) => {
    smartUpdate('time', zoom, undefined, time);
  }, [smartUpdate]);

  const immediateUpdate = useCallback(() => {
    clearUpdateTimeout();
    console.log('⚡ Immediate shadow update requested');
    updateFunction();
    isInteractingRef.current = false;
  }, [updateFunction, clearUpdateTimeout]);

  useEffect(() => {
    return () => {
      clearUpdateTimeout();
    };
  }, [clearUpdateTimeout]);

  return {
    onMapMove,
    onMapZoom,
    onTimeChange,
    immediateUpdate,
    isInteracting: () => isInteractingRef.current
  };
}
