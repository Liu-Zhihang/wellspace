import React, { useMemo } from 'react';
import { SunIcon } from '@heroicons/react/24/outline';
import { useShadowMapStore } from '../../store/shadowMapStore';

export const GeometryAnalysisOverlay: React.FC = () => {
  const {
    selectedGeometryId,
    uploadedGeometries,
    geometryAnalyses,
    mapSettings,
    addStatusMessage,
    updateMapSettings,
    shadowServiceStatus,
    shadowServiceResult,
    shadowServiceError
  } = useShadowMapStore();

  const selectedGeometry = useMemo(
    () => uploadedGeometries.find((item) => item.id === selectedGeometryId),
    [uploadedGeometries, selectedGeometryId],
  );

  if (!selectedGeometry) {
    return null;
  }

  const analysis = selectedGeometryId ? geometryAnalyses[selectedGeometryId] : undefined;
  const heatmapEnabled = mapSettings.showSunExposure;

  const handleShowHeatmap = () => {
    updateMapSettings({ showSunExposure: true, showShadowLayer: false });
    addStatusMessage?.('Sun exposure heatmap enabled. Shadow layer dimmed for clarity.', 'info');
  };

  const statusMap: Record<string, { label: string; tone: string }> = {
    loading: { label: 'Running analysis…', tone: 'text-amber-200' },
    success: { label: 'Analysis ready', tone: 'text-emerald-200' },
    error: { label: 'Analysis failed', tone: 'text-rose-200' },
    idle: { label: 'Idle', tone: 'text-slate-300' },
  };

  const statusMeta = statusMap[shadowServiceStatus] ?? statusMap.idle;

  type Summary = { sunlight: number; coverage: number; notes?: string };

  const summary: Summary | null = shadowServiceResult
    ? {
        sunlight: shadowServiceResult.metrics.avgSunlightHours,
        coverage: shadowServiceResult.metrics.avgShadowPercent,
        notes: shadowServiceResult.metrics.shadowAreaSqm
          ? `Shadow area ${(shadowServiceResult.metrics.shadowAreaSqm / 10000).toFixed(1)} ha`
          : shadowServiceResult.cache.hit
            ? 'Cache hit'
            : 'Fresh compute',
      }
    : analysis
      ? {
          sunlight: analysis.stats.avgSunlightHours,
          coverage: analysis.stats.shadedRatio * 100,
          notes: analysis.stats.notes,
        }
      : null;

  return (
    <aside className="pointer-events-none fixed right-4 top-20 z-40 w-64 max-w-sm">
      <div className="pointer-events-auto rounded-2xl bg-slate-950/80 p-4 text-slate-100 shadow-xl backdrop-blur">
        <header className="mb-4">
          <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Selected geometry</p>
          <h3 className="mt-1 text-base font-semibold text-slate-50">{selectedGeometry.name}</h3>
        </header>

        <section className="space-y-2 text-sm text-slate-200/90">
          <p className={`text-xs font-semibold uppercase tracking-[0.18em] ${statusMeta.tone}`}>
            {statusMeta.label}
          </p>
          <p className="text-xs text-slate-400">
            Sun exposure heatmap {heatmapEnabled ? 'is visible.' : 'is currently hidden.'}
          </p>
          {shadowServiceError && (
            <p className="text-xs text-rose-300">{shadowServiceError}</p>
          )}
        </section>

        <section className="mt-4 rounded-xl bg-blue-500/15 p-3 text-sm text-slate-100">
          <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-slate-200/70">Shadow analysis</p>
          {summary ? (
            <dl className="space-y-2">
              <div className="flex items-center justify-between">
                <dt className="text-slate-200/80">Avg sunlight</dt>
                <dd className="font-semibold text-slate-50">{summary.sunlight.toFixed(1)} h</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-slate-200/80">Shadow coverage</dt>
                <dd className="font-semibold text-slate-50">{summary.coverage.toFixed(1)}%</dd>
              </div>
              {summary.notes && (
                <div className="rounded-lg bg-slate-900/40 px-3 py-2 text-[11px] text-slate-200/80">
                  {summary.notes}
                </div>
              )}
            </dl>
          ) : (
            <p className="text-xs text-slate-200/80">
              Select a polygon to trigger the backend shadow analysis. Results appear automatically once ready.
            </p>
          )}
        </section>

        <footer className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={handleShowHeatmap}
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-600/70 bg-slate-900/70 text-slate-200 transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-300"
            aria-label="Ensure heatmap is visible"
          >
            <SunIcon className="h-5 w-5" />
          </button>
          <div className="text-[11px] text-slate-400">
            Use the toolbar to disable the heatmap once you are done inspecting exposure.
          </div>
        </footer>
      </div>
    </aside>
  );
};

export default GeometryAnalysisOverlay;
