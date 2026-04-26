BEGIN;

DROP TABLE IF EXISTS public.buildings_service_20260406;

CREATE TABLE public.buildings_service_20260406 AS
SELECT ogc_fid, wkb_geometry, source, id, height, var, region, geom, tile_id
FROM public.buildings
WHERE geom IS NOT NULL;

ALTER TABLE public.buildings_service_20260406
  ADD PRIMARY KEY (ogc_fid);

CREATE INDEX buildings_service_20260406_geom_idx
  ON public.buildings_service_20260406 USING gist (geom);

CREATE INDEX buildings_service_20260406_tile_idx
  ON public.buildings_service_20260406 (tile_id);

ANALYZE public.buildings_service_20260406;

COMMIT;
