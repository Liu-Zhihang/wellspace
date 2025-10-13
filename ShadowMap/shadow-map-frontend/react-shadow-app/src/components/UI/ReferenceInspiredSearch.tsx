import React, { useState } from 'react'

export const ReferenceInspiredSearch: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)

  const handleSearch = async () => {
    if (!searchQuery.trim()) return

    setIsSearching(true)
    console.log(`Searching for: ${searchQuery}`)

    // Simulate async search
    setTimeout(() => {
      setIsSearching(false)
      console.log(`Search completed: ${searchQuery}`)
    }, 1000)
  }

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      handleSearch()
    }
  }

  return (
    <div className="fixed top-8 left-6 z-40 flex items-center gap-4">
      <button
        className="w-11 h-11 rounded-xl bg-white/95 backdrop-blur-md shadow-xl border border-white/40 flex items-center justify-center text-gray-600 hover:text-gray-900 transition-colors"
        title="Open navigation"
      >
        ☰
      </button>

      <div className="flex items-center bg-white/95 backdrop-blur-md rounded-xl shadow-xl border border-white/40 overflow-hidden">
        <input
          type="text"
          placeholder="Search places..."
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyPress={handleKeyPress}
          className="px-4 py-2.5 w-72 text-sm focus:outline-none bg-transparent placeholder-gray-500"
        />
        
        <button
          onClick={handleSearch}
          disabled={isSearching || !searchQuery.trim()}
          className={`px-4 py-2.5 text-sm font-medium transition-colors ${
            isSearching || !searchQuery.trim()
              ? 'text-gray-400 cursor-not-allowed'
              : 'text-blue-600 hover:text-blue-700 hover:bg-blue-50'
          }`}
          title="Search"
        >
          {isSearching ? '⏳' : '📤'}
        </button>
      </div>
    </div>
  )
}
