# Local DEM Data Integration

## Overview

The application now uses **local DEM (Digital Elevation Model) TIF files** directly from the `public` folder instead of requesting data from external APIs or GeoServer. This approach is:

✅ **Simpler** - No server setup required
✅ **Faster** - No network latency
✅ **More Reliable** - Data consistency guaranteed
✅ **More Efficient** - Built-in caching

## File Structure

```
shadow-map-frontend/react-shadow-app/public/
└── Example/
    └── Height/
        └── europe/
            └── e010_n50_e015_n45/
                └── 11.4_48.2_11.6_48.0_sr_ss.tif
```

The TIF file naming convention: `{west}_{north}_{east}_{south}_sr_ss.tif`
- Example: `11.4_48.2_11.6_48.0_sr_ss.tif` covers:
  - Longitude: 11.4° to 11.6° E
  - Latitude: 48.0° to 48.2° N
  - This is the Munich area

## How to Use

### Basic Usage

```typescript
import { localDemService } from './services/localDemService';

// Get elevation at a specific point
const elevation = await localDemService.getElevationAt(11.5, 48.1);
console.log('Elevation:', elevation, 'meters');

// Load DEM data for an area
const demData = await localDemService.loadDemData([11.4, 48.0, 11.6, 48.2]);
if (demData) {
  console.log('DEM loaded:', {
    width: demData.width,
    height: demData.height,
    dataPoints: demData.data.length
  });
}
```

### Integration with Shadow Simulator

To integrate the local DEM with your shadow simulation:

```typescript
// In your shadow simulator initialization
const bounds = map.getBounds();
const demData = await localDemService.loadDemData([
  bounds.getWest(),
  bounds.getSouth(),
  bounds.getEast(),
  bounds.getNorth()
]);

if (demData) {
  // Use demData.data (Float32Array) for shadow calculations
  shadowSimulator.setTerrainData(demData);
}
```

## Adding More TIF Files

To add coverage for additional areas:

1. **Place TIF files** in the appropriate folder:
   ```
   public/Example/Height/{region}/{grid_cell}/{bounds}.tif
   ```

2. **Update `localDemService.ts`** to recognize the new files:
   ```typescript
   private getTifPathForBounds(bounds: [number, number, number, number]): string | null {
     const [west, south, east, north] = bounds;
     
     // Add your new area
     if (west >= X1 && east <= X2 && south >= Y1 && north <= Y2) {
       return '/Example/Height/region/grid/file.tif';
     }
     
     // ...existing checks
   }
   ```

## Cache Management

The service automatically caches loaded TIF files:

```typescript
// Get cache statistics
const stats = localDemService.getCacheStats();
console.log('Cached files:', stats.size);
console.log('Cache keys:', stats.keys);

// Clear cache if needed
localDemService.clearCache();
```

## Why Not GeoServer?

### ❌ GeoServer Approach (Complex)
- Upload TIF via SSH/SMB
- Configure GeoServer layers
- Set up WMS/WCS endpoints
- Handle authentication
- Deal with CORS issues
- Manage server resources
- Network latency on every request

### ✅ Local TIF Approach (Simple)
- Copy TIF to `public` folder
- Import and use the service
- Automatic caching
- Zero network overhead
- Works offline

## Performance Notes

- **First Load**: ~500ms-2s depending on TIF size
- **Cached Access**: <10ms (instant)
- **Memory Usage**: ~4-16MB per TIF (depending on resolution)
- **Browser Compatibility**: Works in all modern browsers (uses GeoTIFF.js)

## Data Format

The TIF files should be:
- **Format**: GeoTIFF
- **Projection**: WGS84 (EPSG:4326) preferred
- **Data Type**: Float32 or Int16
- **Bands**: Single band (elevation only)
- **Compression**: LZW or DEFLATE recommended

## Troubleshooting

### TIF File Not Loading
1. Check file path in browser DevTools Network tab
2. Verify file is in `public` folder (not `src`)
3. Check console for error messages

### Wrong Elevation Values
1. Verify TIF projection is WGS84
2. Check that bounds in filename match actual data
3. Ensure elevation is in meters

### Memory Issues
1. Clear cache: `localDemService.clearCache()`
2. Use smaller TIF tiles
3. Consider compression

## Next Steps

1. **Test with Current File**: The Munich area TIF is ready to use
2. **Integrate with Shadow Sim**: Update `useShadowMap.ts` to use local DEM
3. **Add More Coverage**: Add TIF files for other areas as needed
4. **Optimize**: Implement tile-based loading for very large areas

---

**Note**: This approach eliminates the need for GeoServer, WFS, WMS, or any backend DEM API. Everything runs client-side in the browser.
