GlobalBuildingAtlas: An Open Global and Complete Dataset of Building Polygons, Heights, and LoD1 3D Models
===========================================================================================================

Authors: Xiao Xiang Zhu (1,2), Sining Chen (1,2), Fahong Zhang (1), Yilei Shi (1), Yuanyuan Wang (1)  
Affiliations:  
(1) Technical University of Munich  
(2) Munich Center for Machine Learning  
Date: Aug. 1, 2025

1. Overview
-----------
GlobalBuildingAtlas is a dataset providing global and complete coverage of building polygons (GBA.Polygon), heights (GBA.Height) and Level of Detail 1 (LoD1) 3D building models (GBA.LoD1). It is the first open dataset to offer high quality, consistent, and complete building data in 2D and 3D at the individual building level on a global scale. The dataset is delivered in tiles of 5 degree by 5 degree, with GBA.Polygon and GBA.LoD1 in GeoJSON format, and GBA.Height in GeoTiff format. Details see https://github.com/zhu-xlab/GlobalBuildingAtlas.

2. Contents
-----------
This representative dataset includes:

- `height_tif.geojson`  
  Metadata for GBA.Height: extent of each 0.2° × 0.2° height tile and its parent archive (.zip).

- `height_zip.geojson`  
  Metadata for GBA.Height: extent and SHA512 checksums of each 5° × 5° archive (.zip).

- `lod1.geojson`  
  Metadata for GBA.LoD1: extent and SHA512 checksums of each 5° × 5° GeoJSON file.

- `examples/`  
  Example data for previewing:
  - `LoD1/`
    - `europe/e010_n50_e015_n45.geojson`  
      Example GBA.LoD1 tile over Munich, Germany (5° × 5°).
  - `Height/`
    - `europe/e010_n50_e015_n45/11.4_48.2_11.6_48.0_sr_ss.tif`  
      Example GBA.Height tile over Munich, Germany (0.2° × 0.2°). 

- `checksums.sha512`  
  SHA512 checksums for verifying data integrity.

- `README.txt`  
  This file.

3. Format and Structure
-----------------------
File names reflect the geographic extent in EPSG:4326 (WGS84):

- 5° × 5° tiles: `{e/w}{lon_min}_{n/s}{lat_max}_{e/w}{lon_max}_{n/s}{lat_min}`
- 0.2° × 0.2° tiles: `{lon_min}_{lat_max}_{lon_max}_{lat_min}`

Use the metadata files `height_tif.geojson`, `height_zip.geojson`, and `lod1.geojson` to locate specific tiles efficiently.

4. Contact
----------
For questions or feedback, contact: xiaoxiang.zhu@tum.de