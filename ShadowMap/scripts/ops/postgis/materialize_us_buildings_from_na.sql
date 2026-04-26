BEGIN;

DROP TABLE IF EXISTS public.buildings_us_lod1;

CREATE TABLE public.buildings_us_lod1 AS
WITH us_aoi AS (
  SELECT ST_UnaryUnion(
    ST_Collect(ARRAY[
      ST_MakeEnvelope(-125.0, 24.0, -66.0, 50.0, 4326),
      ST_MakeEnvelope(-180.0, 51.0, -129.0, 72.5, 4326),
      ST_MakeEnvelope(-161.0, 18.5, -154.0, 23.0, 4326),
      ST_MakeEnvelope(-68.5, 17.5, -64.0, 19.0, 4326)
    ])
  ) AS geom
),
tile_bounds AS (
  SELECT
    tiles.tile_id,
    ST_MakeEnvelope(
      LEAST(parsed.lon_a, parsed.lon_b),
      LEAST(parsed.lat_a, parsed.lat_b),
      GREATEST(parsed.lon_a, parsed.lon_b),
      GREATEST(parsed.lat_a, parsed.lat_b),
      4326
    ) AS geom
  FROM (
    SELECT DISTINCT tile_id
    FROM public.buildings_na_lod1
  ) AS tiles
  CROSS JOIN LATERAL (
    SELECT regexp_match(
      tiles.tile_id,
      '^([we])([0-9]{3})_([ns])([0-9]{2})_([we])([0-9]{3})_([ns])([0-9]{2})$'
    ) AS match_parts
  ) AS raw
  CROSS JOIN LATERAL (
    SELECT
      (CASE raw.match_parts[1] WHEN 'w' THEN -1 ELSE 1 END) * raw.match_parts[2]::integer AS lon_a,
      (CASE raw.match_parts[3] WHEN 's' THEN -1 ELSE 1 END) * raw.match_parts[4]::integer AS lat_a,
      (CASE raw.match_parts[5] WHEN 'w' THEN -1 ELSE 1 END) * raw.match_parts[6]::integer AS lon_b,
      (CASE raw.match_parts[7] WHEN 's' THEN -1 ELSE 1 END) * raw.match_parts[8]::integer AS lat_b
  ) AS parsed
  WHERE raw.match_parts IS NOT NULL
),
candidate_tiles AS (
  SELECT tile_bounds.tile_id
  FROM tile_bounds
  CROSS JOIN us_aoi
  WHERE ST_Intersects(tile_bounds.geom, us_aoi.geom)
)
SELECT na.*
FROM public.buildings_na_lod1 AS na
JOIN candidate_tiles USING (tile_id)
CROSS JOIN us_aoi
WHERE ST_Intersects(na.geom, us_aoi.geom);

ALTER TABLE public.buildings_us_lod1
  ADD CONSTRAINT buildings_us_lod1_pkey PRIMARY KEY (ogc_fid);

CREATE INDEX buildings_us_lod1_geom_idx
  ON public.buildings_us_lod1 USING gist (geom);

CREATE INDEX buildings_us_lod1_tile_idx
  ON public.buildings_us_lod1 (tile_id);

ANALYZE public.buildings_us_lod1;

GRANT SELECT ON public.buildings_us_lod1 TO gisuser;

COMMIT;
