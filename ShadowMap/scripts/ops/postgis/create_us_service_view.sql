CREATE OR REPLACE VIEW public.buildings_us_service AS
SELECT ogc_fid, source, id, height, var, region, geom, tile_id
FROM public.buildings_us_lod1
WHERE region IN ('USA', 'PRI', 'VIR');

GRANT SELECT ON public.buildings_us_service TO gisuser;
