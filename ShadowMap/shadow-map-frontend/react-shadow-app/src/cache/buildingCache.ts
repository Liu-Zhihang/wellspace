/**
 * @file Client-side cache for storing and managing GeoJSON features.
 * This cache helps prevent duplicate features and accumulates data from multiple API calls.
 */

import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';

/**
 * A simple in-memory cache for GeoJSON features.
 * It uses a Map to store features by their ID, ensuring uniqueness.
 */
class FeatureCache {
  private features: Map<string | number, Feature<Geometry, GeoJsonProperties>>;

  constructor() {
    this.features = new Map();
    console.log('FeatureCache initialized.');
  }

  /**
   * Adds or updates features from a FeatureCollection.
   * Skips features without a valid 'id' in their properties.
   * @param featureCollection The FeatureCollection to add.
   * @returns The number of new features that were added to the cache.
   */
  public add(featureCollection: FeatureCollection): number {
    let newFeaturesCount = 0;
    if (!featureCollection || !featureCollection.features) {
      return newFeaturesCount;
    }

    for (const feature of featureCollection.features) {
      const id = feature.properties?.id;

      if (id !== null && id !== undefined) {
        if (!this.features.has(id)) {
          this.features.set(id, feature);
          newFeaturesCount++;
        }
      } else {
        console.warn('Skipping a feature because it lacks an ID.', feature);
      }
    }
    
    console.log(`Cache: Added ${newFeaturesCount} new features. Total features in cache: ${this.features.size}`);
    return newFeaturesCount;
  }

  /**
   * Retrieves all cached features as a FeatureCollection.
   * @returns A FeatureCollection containing all unique features.
   */
  public getAllAsFeatureCollection(): FeatureCollection {
    const allFeatures = Array.from(this.features.values());
    return {
      type: 'FeatureCollection',
      features: allFeatures,
    };
  }

  /**
   * Clears all features from the cache.
   */
  public clear(): void {
    this.features.clear();
    console.log('FeatureCache cleared.');
  }

  /**
   * Gets the total number of unique features in the cache.
   */
  public get size(): number {
    return this.features.size;
  }
}

// Export a singleton instance of the cache so it's shared across the app.
export const buildingCache = new FeatureCache();
