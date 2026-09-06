-- RoboPromo, the FRC bumper vendor.
--
-- type 'volusion': they run Volusion, which serves none of the catalogue
-- endpoints the other scrapers use. See vendord/server/utils/volusion.ts --
-- the store's own /pindex.asp is the enumeration point.
--
-- Data only, so the drizzle snapshots are unaffected and the deploy's
-- destructive-migration gate reads it as additive. ON CONFLICT DO NOTHING, as
-- with 0018 and 0019: it runs once, and a hostname corrected by hand should
-- stand.
INSERT INTO vendors (id, name, type, config, hostname) VALUES
  ('robopromo', 'RoboPromo', 'volusion', '{}', 'www.robopromo.com')
ON CONFLICT (id) DO NOTHING;
