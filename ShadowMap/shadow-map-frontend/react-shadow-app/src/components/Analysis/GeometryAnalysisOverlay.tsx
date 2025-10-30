import React, { useMemo } from 'react';
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
  } = useShadowMapStore();

  const selectedGeometry = useMemo(
    () => uploadedGeometries.find((item) => item.id === selectedGeometryId),
    [uploadedGeometries, selectedGeometryId],
  );

  if (!selectedGeometry) {
    return null;
  }

  const analysis = selectedGeometryId ? geometryAnalyses[selectedGeometryId] : undefined;
  const hasHeatmapEnabled = mapSettings.showSunExposure;

  const handleRunAnalysis = async () => {
    if (!viewportActions.initShadowSimulator) {
      addStatusMessage?.('地图尚未准备好重算，请稍候再试。', 'warning');
      return;
    }

    try {
      addStatusMessage?.(`开始重新分析「${selectedGeometry.name}」的曝光情况…`, 'info');
      await viewportActions.initShadowSimulator();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addStatusMessage?.(`重新分析失败：${message}`, 'error');
    }
  };

  return (
    <aside
      style={{
        position: 'fixed',
        right: '1.5rem',
        top: '6rem',
        width: '320px',
        zIndex: 260,
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          borderRadius: '16px',
          padding: '18px 20px',
          background: 'rgba(15, 23, 42, 0.85)',
          color: '#f8fafc',
          boxShadow: '0 18px 38px rgba(15, 23, 42, 0.36)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <header style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '12px', letterSpacing: '0.08em', opacity: 0.8 }}>SELECTED AREA</div>
          <div style={{ fontSize: '18px', fontWeight: 600, marginTop: '4px' }}>{selectedGeometry.name}</div>
        </header>

        <section style={{ fontSize: '13px', lineHeight: 1.6, opacity: 0.92 }}>
          <div>
            状态：
            {shadowSimulatorReady
              ? '阴影模拟已就绪'
              : isInitialisingShadow
              ? '正在初始化阴影模拟…'
              : '等待阴影模拟准备'}
          </div>
          <div>日照热力：{hasHeatmapEnabled ? '已开启' : '未开启（会自动启用）'}</div>
          <div>控制按钮：左侧工具栏「☀️」可以随时开启/关闭</div>
        </section>

        {analysis ? (
          <section
            style={{
              marginTop: '14px',
              padding: '12px 14px',
              borderRadius: '12px',
              background: 'rgba(96, 165, 250, 0.18)',
            }}
          >
            <div style={{ fontSize: '12px', letterSpacing: '0.08em', opacity: 0.8, marginBottom: '6px' }}>
              ANALYSIS SNAPSHOT
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span>平均日照小时</span>
              <span style={{ fontWeight: 600 }}>
                {analysis.stats.avgSunlightHours.toFixed(2)} h
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span>阴影覆盖率</span>
              <span style={{ fontWeight: 600 }}>
                {(analysis.stats.shadedRatio * 100).toFixed(1)}%
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', opacity: 0.82 }}>
              <span>采样点</span>
              <span>{analysis.stats.sampleCount}</span>
            </div>
          </section>
        ) : (
          <section
            style={{
              fontSize: '13px',
              marginTop: '14px',
              padding: '10px 12px',
              borderRadius: '12px',
              background: 'rgba(148, 163, 184, 0.12)',
              lineHeight: 1.6,
            }}
          >
            上传的多边形准备就绪，开启日照热力图后点击下方按钮即可生成曝光分析。
          </section>
        )}

        <footer style={{ marginTop: '16px', display: 'flex', gap: '10px' }}>
          <button
            type="button"
            onClick={handleRunAnalysis}
            disabled={isInitialisingShadow}
            style={{
              flex: 1,
              height: '40px',
              borderRadius: '12px',
              border: 'none',
              background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
              color: '#fff',
              fontWeight: 600,
              letterSpacing: '0.02em',
              cursor: isInitialisingShadow ? 'not-allowed' : 'pointer',
              opacity: isInitialisingShadow ? 0.6 : 1,
              transition: 'transform 0.15s ease',
            }}
          >
            {analysis ? '重新分析' : '开始分析'}
          </button>
          <button
            type="button"
            onClick={() => {
              addStatusMessage?.('若看不到热力图，可在左侧 ☀️ 面板检查是否已开启 Sun Exposure。', 'info');
            }}
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '12px',
              border: '1px solid rgba(148, 163, 184, 0.4)',
              background: 'rgba(15, 23, 42, 0.35)',
              color: '#e2e8f0',
              fontSize: '18px',
              cursor: 'pointer',
              transition: 'background 0.2s ease',
            }}
            title="帮助"
          >
            ?
          </button>
        </footer>
      </div>
    </aside>
  );
};

export default GeometryAnalysisOverlay;
