import React, { useMemo } from 'react';
import { SunIcon } from '@heroicons/react/24/outline';
import { useShadowMapStore } from '../../store/shadowMapStore';

export const GeometryAnalysisOverlay: React.FC = () => {
  const {
    selectedGeometryId,
    uploadedGeometries,
    geometryAnalyses,
    shadowSimulatorReady,
    isInitialisingShadow,
    mapSettings,
    viewportActions,
    addStatusMessage,
    updateMapSettings,
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

  const handleRunAnalysis = async () => {
    if (!viewportActions.initShadowSimulator) {
      addStatusMessage?.('Map viewport is not ready to run the analysis yet.', 'warning');
      return;
    }

    try {
      updateMapSettings({ showSunExposure: true, showShadowLayer: false });
      addStatusMessage?.(`Re-running exposure analysis for "${selectedGeometry.name}"...`, 'info');
      await viewportActions.initShadowSimulator();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addStatusMessage?.(`Exposure analysis failed: ${message}`, 'error');
    }
  };

  const handleShowHeatmap = () => {
    updateMapSettings({ showSunExposure: true, showShadowLayer: false });
    addStatusMessage?.('Sun exposure heatmap enabled. Shadow layer dimmed for clarity.', 'info');
  };

  const simulatorStatus = shadowSimulatorReady
    ? 'Shadow simulator ready'
    : isInitialisingShadow
    ? 'Initialising shadow simulator...'
    : 'Load buildings to initialise shadows';

  return (
    <aside className="pointer-events-none fixed right-6 top-24 z-40 w-80 max-w-xs">
      <div className="pointer-events-auto rounded-3xl bg-slate-950/85 p-6 text-slate-100 shadow-2xl backdrop-blur">
        <header className="mb-4">
          <p className="text-xs uppercase tracking-[0.18em] text-slate-300">Selected geometry</p>
          <h3 className="mt-2 text-lg font-semibold text-slate-50">{selectedGeometry.name}</h3>
        </header>

        <section className="space-y-2 text-sm text-slate-200/90">
          <div className="flex items-start gap-2">
            <span className="mt-1 h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
            <div>
              <p className="font-medium text-slate-100">{simulatorStatus}</p>
              <p className="text-xs text-slate-300">
                Sun exposure heatmap {heatmapEnabled ? 'is visible' : 'is currently hidden'}.
              </p>
            </div>
          </div>
        </section>

        {analysis ? (
          <section className="mt-5 rounded-2xl bg-blue-500/15 p-4 text-sm text-slate-100">
            <p className="mb-3 text-[11px] uppercase tracking-[0.2em] text-slate-200/70">Exposure snapshot</p>
            <dl className="space-y-2">
              <div className="flex items-center justify-between">
                <dt className="text-slate-200/80">Average sunlight hours</dt>
                <dd className="font-semibold text-slate-50">{analysis.stats.avgSunlightHours.toFixed(2)} h</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-slate-200/80">Shadow coverage</dt>
                <dd className="font-semibold text-slate-50">{(analysis.stats.shadedRatio * 100).toFixed(1)}%</dd>
              </div>
              <div className="flex items-center justify-between text-xs">
                <dt className="text-slate-300">Total sampled points</dt>
                <dd className="text-slate-100">{analysis.stats.sampleCount}</dd>
              </div>
              <div className="flex items-center justify-between text-xs">
                <dt className="text-slate-300">Skipped samples</dt>
                <dd className="text-slate-100">{analysis.stats.invalidSamples}</dd>
              </div>
            </dl>
            {analysis.stats.notes ? (
              <p className="mt-3 rounded-lg bg-slate-900/40 px-3 py-2 text-xs text-slate-200/80">
                {analysis.stats.notes}
              </p>
            ) : null}
          </section>
        ) : (
          <section className="mt-5 rounded-2xl border border-slate-700/60 bg-slate-900/60 p-4 text-sm text-slate-200/80">
            Upload a polygon and enable the Sun Exposure toggle to generate an exposure snapshot for this area.
          </section>
        )}

        <footer className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={handleRunAnalysis}
            disabled={isInitialisingShadow}
            className="flex-1 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-md transition hover:from-blue-600 hover:to-indigo-600 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {analysis ? 'Refresh Analysis' : 'Run Exposure Analysis'}
          </button>
          <button
            type="button"
            onClick={handleShowHeatmap}
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-600/70 bg-slate-900/70 text-slate-200 transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-300"
            aria-label="Ensure heatmap is visible"
          >
            <SunIcon className="h-5 w-5" />
          </button>
        </footer>
      </div>
    </aside>
  );
};

export default GeometryAnalysisOverlay;
