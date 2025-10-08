import { fromUrl } from 'geotiff';

/**
 * Service for reading local DEM (Digital Elevation Model) data from TIF files
 * Reads from the public/Example/Height folder
 */
class LocalDemService {
  private cache: Map<string, { data: Float32Array; width: number; height: number; bounds: [number, number, number, number] }> = new Map();
  private loadingPromises: Map<string, Promise<any>> = new Map();

  /**
   * Load DEM data from a local TIF file
   * @param bounds [west, south, east, north] - geographic bounds
   * @returns elevation data and metadata
   */
  async loadDemData(bounds: [number, number, number, number]): Promise<{
    data: Float32Array;
    width: number;
    height: number;
    bounds: [number, number, number, number];
  } | null> {
    try {
      // Determine which TIF file to load based on bounds
      const tifPath = this.getTifPathForBounds(bounds);
      
      if (!tifPath) {
        console.warn('No local DEM file available for bounds:', bounds);
        return null;
      }

      // Check cache first
      const cacheKey = tifPath;
      if (this.cache.has(cacheKey)) {
        console.log('Loading DEM from cache:', cacheKey);
        return this.cache.get(cacheKey)!;
      }

      // Check if already loading
      if (this.loadingPromises.has(cacheKey)) {
        console.log('DEM already loading, waiting...', cacheKey);
        return await this.loadingPromises.get(cacheKey);
      }

      // Load the TIF file
      console.log('Loading DEM from:', tifPath);
      const loadPromise = this.loadTifFile(tifPath, bounds);
      this.loadingPromises.set(cacheKey, loadPromise);

      const result = await loadPromise;
      
      // Cache the result
      this.cache.set(cacheKey, result);
      this.loadingPromises.delete(cacheKey);

      return result;
    } catch (error) {
      console.error('Error loading local DEM data:', error);
      return null;
    }
  }

  /**
   * Determine which TIF file to load based on bounds
   * Currently hardcoded to the example file, but can be extended
   */
  private getTifPathForBounds(bounds: [number, number, number, number]): string | null {
    const [west, south, east, north] = bounds;

    // Check if bounds are within the example TIF coverage
    // Example file: 11.4_48.2_11.6_48.0_sr_ss.tif
    // This covers: lon 11.4-11.6, lat 48.0-48.2
    if (west >= 11.4 && east <= 11.6 && south >= 48.0 && north <= 48.2) {
      return '/Example/Height/europe/e010_n50_e015_n45/11.4_48.2_11.6_48.0_sr_ss.tif';
    }

    // Add more file mappings here as needed
    // For now, just return the example file if bounds are close
    if (west >= 11.0 && east <= 12.0 && south >= 47.5 && north <= 48.5) {
      return '/Example/Height/europe/e010_n50_e015_n45/11.4_48.2_11.6_48.0_sr_ss.tif';
    }

    return null;
  }

  /**
   * Load and parse a TIF file
   */
  private async loadTifFile(
    path: string,
    bounds: [number, number, number, number]
  ): Promise<{
    data: Float32Array;
    width: number;
    height: number;
    bounds: [number, number, number, number];
  }> {
    try {
      // Load the TIF file
      const tiff = await fromUrl(path);
      const image = await tiff.getImage();
      
      // Get raster data
      const rasters = await image.readRasters();
      const elevationData = rasters[0] as Float32Array;
      
      // Get dimensions
      const width = image.getWidth();
      const height = image.getHeight();
      
      // Get geographic bounds from the TIF
      const [minX, minY, maxX, maxY] = image.getBoundingBox();
      const geoBounds: [number, number, number, number] = [minX, minY, maxX, maxY];

      console.log('Loaded DEM TIF:', {
        width,
        height,
        bounds: geoBounds,
        minElevation: Math.min(...elevationData),
        maxElevation: Math.max(...elevationData),
        dataPoints: elevationData.length
      });

      return {
        data: elevationData,
        width,
        height,
        bounds: geoBounds
      };
    } catch (error) {
      console.error('Error loading TIF file:', error);
      throw error;
    }
  }

  /**
   * Get elevation at a specific point
   */
  async getElevationAt(lon: number, lat: number): Promise<number | null> {
    try {
      // Load DEM for this area
      const demData = await this.loadDemData([lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01]);
      
      if (!demData) {
        return null;
      }

      const { data, width, height, bounds } = demData;
      const [west, south, east, north] = bounds;

      // Calculate pixel position
      const x = Math.floor(((lon - west) / (east - west)) * width);
      const y = Math.floor(((north - lat) / (north - south)) * height);

      // Check bounds
      if (x < 0 || x >= width || y < 0 || y >= height) {
        return null;
      }

      // Get elevation
      const index = y * width + x;
      return data[index];
    } catch (error) {
      console.error('Error getting elevation:', error);
      return null;
    }
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
    console.log('Local DEM cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }
}

// Export singleton instance
export const localDemService = new LocalDemService();
