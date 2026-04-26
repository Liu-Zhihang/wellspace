BEGIN;

CREATE TABLE IF NOT EXISTS public.buildings_na_lod1 (
  ogc_fid bigserial PRIMARY KEY,
  source character varying,
  id character varying,
  height double precision,
  var double precision,
  region character varying,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  tile_id text NOT NULL
);

CREATE INDEX IF NOT EXISTS buildings_na_lod1_geom_idx
  ON public.buildings_na_lod1 USING gist (geom);

CREATE INDEX IF NOT EXISTS buildings_na_lod1_tile_idx
  ON public.buildings_na_lod1 (tile_id);

GRANT SELECT ON public.buildings_na_lod1 TO gisuser;

COMMIT;
