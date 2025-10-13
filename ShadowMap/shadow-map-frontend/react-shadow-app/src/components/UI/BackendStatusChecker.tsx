import React, { useState, useEffect } from 'react';

interface BackendStatus {
  connected: boolean;
  lastCheck: Date;
  error?: string;
  buildingApiStatus?: 'working' | 'failed' | 'unknown';
}

export const BackendStatusChecker: React.FC = () => {
  const [status, setStatus] = useState<BackendStatus>({
    connected: false,
    lastCheck: new Date(),
    buildingApiStatus: 'unknown'
  });
  const [checking, setChecking] = useState(false);

  const checkBackendStatus = async () => {
    setChecking(true);
    
    try {
      // Check basic connection
      const response = await fetch('http://localhost:3500/api/health', {
        method: 'GET',
        timeout: 5000,
      });
      
      if (response.ok) {
        // Test building API
        const buildingResponse = await fetch('http://localhost:3500/api/buildings/info');
        
        setStatus({
          connected: true,
          lastCheck: new Date(),
          buildingApiStatus: buildingResponse.ok ? 'working' : 'failed'
        });
      } else {
        setStatus({
          connected: false,
          lastCheck: new Date(),
          error: `HTTP ${response.status}`,
          buildingApiStatus: 'unknown'
        });
      }
    } catch (error) {
      setStatus({
        connected: false,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : 'Connection refused',
        buildingApiStatus: 'unknown'
      });
    } finally {
      setChecking(false);
    }
  };

  // Auto-check on mount and every 30 seconds
  useEffect(() => {
    checkBackendStatus();
    const interval = setInterval(checkBackendStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  if (status.connected) {
    return (
      <div className="fixed top-24 left-1/2 transform -translate-x-1/2 z-40">
        <div className="bg-green-50 text-green-700 px-4 py-2 rounded-lg shadow-lg border border-green-200 flex items-center space-x-2">
          <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
          <span className="text-sm font-medium">Backend Connected</span>
          <span className="text-xs text-green-600">
            Building API: {status.buildingApiStatus === 'working' ? '✅' : '⚠️'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed top-24 left-1/2 transform -translate-x-1/2 z-40 max-w-md">
      <div className="bg-red-50 text-red-700 p-4 rounded-lg shadow-lg border border-red-200">
        <div className="flex items-center space-x-2 mb-2">
          <div className="w-2 h-2 bg-red-400 rounded-full animate-pulse" />
          <span className="font-semibold">Backend Connection Failed</span>
        </div>
        
        <div className="text-sm space-y-2">
          <div>Error: {status.error || 'Connection refused'}</div>
          <div className="text-xs text-red-600">
            Last check: {status.lastCheck.toLocaleTimeString()}
          </div>
          
          <div className="pt-2 border-t border-red-200">
            <div className="font-medium mb-1">Windows Troubleshooting:</div>
            <ol className="text-xs space-y-1 list-decimal list-inside">
              <li>Open PowerShell/CMD as Administrator</li>
              <li>Navigate: <code className="bg-red-100 px-1 rounded">cd ShadowMap\shadow-map-backend</code></li>
              <li>Install: <code className="bg-red-100 px-1 rounded">npm install</code></li>
              <li>Start: <code className="bg-red-100 px-1 rounded">npm run dev</code></li>
              <li>Check Windows Firewall for port 3001</li>
            </ol>
          </div>
          
          <div className="flex space-x-2 pt-2">
            <button
              onClick={checkBackendStatus}
              disabled={checking}
              className="px-3 py-1 bg-red-500 text-white text-xs rounded hover:bg-red-600 disabled:opacity-50"
            >
              {checking ? 'Checking...' : 'Retry'}
            </button>
            <button
              onClick={() => window.open('http://localhost:3500/api/health', '_blank')}
              className="px-3 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600"
            >
              Test Direct
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
