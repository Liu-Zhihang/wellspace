BEGIN;

ALTER TABLE public.buildings RENAME TO buildings_dirty_20260406;
ALTER TABLE public.buildings_service_20260406 RENAME TO buildings;

GRANT SELECT ON public.buildings TO gisuser;

COMMIT;
