-- Two more FRC vendors for the product search, both ordinary Shopify stores.
--
-- A second migration rather than an edit to 0018: that one has already run in
-- production, and drizzle records migrations as applied by their hash, so a
-- changed file would never be re-run and the rows would silently never appear.
--
-- Data only, so the drizzle snapshots are unaffected and the deploy's
-- destructive-migration gate reads it as additive. ON CONFLICT DO NOTHING for
-- the same reason as 0018 -- it runs once, and a hostname corrected by hand
-- afterwards should stand.
--
-- Note luma.vision is the whole apex domain, TLD included, not a subdomain of
-- a luma.com. The similarly-named lumavision.com is an unrelated company
-- running WooCommerce and is deliberately not here.
INSERT INTO vendors (id, name, type, config, hostname) VALUES
  ('lumynlabs',  'Lumyn Labs',  'shopify', '{}', 'lumynlabs.com'),
  ('lumavision', 'Luma Vision', 'shopify', '{}', 'luma.vision')
ON CONFLICT (id) DO NOTHING;
