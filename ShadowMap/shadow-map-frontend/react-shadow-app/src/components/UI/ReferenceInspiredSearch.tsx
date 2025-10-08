/**
 * 参考专业网站的顶部搜索栏设计
 * 学习参考网站的简洁搜索布局
 */

import React, { useState } from 'react';

export const ReferenceInspiredSearch: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    
    setIsSearching(true);
    console.log(`🔍 搜索: ${searchQuery}`);
    
    // 模拟搜索延迟
    setTimeout(() => {
      setIsSearching(false);
      console.log(`✅ 搜索完成: ${searchQuery}`);
    }, 1000);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  return (
    <div className="fixed top-4 left-4 z-30 flex items-center space-x-3">
      {/* 汉堡菜单 */}
      <button
        className="w-10 h-10 rounded-lg bg-white/95 backdrop-blur-sm shadow-lg border border-gray-200 flex items-center justify-center text-gray-600 hover:text-gray-800 transition-colors"
        title="菜单"
      >
        ☰
      </button>

      {/* 搜索栏 */}
      <div className="flex items-center bg-white/95 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 overflow-hidden">
        <input
          type="text"
          placeholder="搜索地点..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyPress={handleKeyPress}
          className="px-4 py-2 w-64 text-sm focus:outline-none bg-transparent placeholder-gray-500"
        />
        
        <button
          onClick={handleSearch}
          disabled={isSearching || !searchQuery.trim()}
          className={`px-3 py-2 text-sm font-medium transition-colors ${
            isSearching || !searchQuery.trim()
              ? 'text-gray-400 cursor-not-allowed'
              : 'text-blue-600 hover:text-blue-700 hover:bg-blue-50'
          }`}
          title="搜索"
        >
          {isSearching ? '⏳' : '📤'}
        </button>
      </div>
    </div>
  );
};
