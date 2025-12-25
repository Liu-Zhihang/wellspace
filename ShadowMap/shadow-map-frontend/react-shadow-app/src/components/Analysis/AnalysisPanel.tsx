import { useShadowMapStore } from '../../store/shadowMapStore';

export const AnalysisPanel = () => {
  const {
    analysisResult,
    analysisResults,
    statusMessages,
    removeStatusMessage,
  } = useShadowMapStore();


  // 格式化数值
  const formatNumber = (num: number | undefined, decimals: number = 1): string => {
    return num?.toFixed(decimals) || '-';
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4 max-h-screen overflow-y-auto">
      {/* 简洁标题 */}
      <h3 className="text-lg font-medium text-gray-800">分析结果</h3>

      {/* 太阳位置 - 简化显示 */}
      {analysisResults.sunPosition && (
        <div className="bg-gradient-to-br from-yellow-50 to-orange-50 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl">☀️</span>
            <div>
              <h4 className="font-medium text-gray-800">太阳位置</h4>
              <p className="text-sm text-gray-600">
                高度 {formatNumber(analysisResults.sunPosition.altitude)}° · 
                方位 {formatNumber(analysisResults.sunPosition.azimuth)}°
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${
              (analysisResults.sunPosition.altitude || 0) > 0 ? 'bg-yellow-400' : 'bg-gray-400'
            }`}></div>
            <span className="text-sm font-medium">
              {(analysisResults.sunPosition.altitude || 0) > 0 ? '白天' : '夜晚'}
            </span>
          </div>
        </div>
      )}

      {/* 状态消息 - 只显示最新的 */}
      {statusMessages.length > 0 && (
        <div className="space-y-2">
          {statusMessages.slice(0, 3).map((msg) => (
            <div
              key={msg.id}
              className={`p-3 rounded-lg text-sm flex items-start gap-2 ${
                msg.type === 'error'
                  ? 'bg-red-50 text-red-700'
                  : msg.type === 'warning'
                  ? 'bg-yellow-50 text-yellow-700'
                  : 'bg-blue-50 text-blue-700'
              }`}
            >
              <span className="text-lg">
                {msg.type === 'error' ? '❌' : msg.type === 'warning' ? '⚠️' : 'ℹ️'}
              </span>
              <span className="flex-1">{msg.message}</span>
              <button
                onClick={() => removeStatusMessage(msg.id)}
                className="text-gray-400 hover:text-gray-600 ml-2"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 建筑物统计 - 简化 */}
      {analysisResult && (
        <div className="bg-gray-50 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xl">🏢</span>
            <h4 className="font-medium text-gray-800">建筑物数据</h4>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="text-center">
              <div className="text-lg font-bold text-blue-600">
                {analysisResult.buildingCount || 0}
              </div>
              <div className="text-gray-600">建筑物数量</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-green-600">
                {formatNumber(analysisResult.averageHeight || 0, 0)}m
              </div>
              <div className="text-gray-600">平均高度</div>
            </div>
          </div>
        </div>
      )}

      {/* 空状态 */}
      {!analysisResult && !analysisResults.sunPosition && (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-3">🌤️</div>
          <p className="text-sm">点击地图查看阴影分析</p>
        </div>
      )}
    </div>
  );
};
