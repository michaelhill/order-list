-- Sailrite, indexed as a `curated` vendor: only the products named below,
-- not the storefront.
--
-- They sell thousands of marine items an FRC team will never buy, so a full
-- scrape would bury the parts that matter in results about upholstery tools.
-- The `curated` type reads its product list out of `vendors.config` -- a NOT
-- NULL text column the rest of the app never reads, which is why it is the
-- natural home for it -- and fetches each URL through the ordinary extractor.
--
-- Fourteen products: the two 4 oz Dacron sailcloths, the eight Insignia
-- adhesive-backed fabrics (SKUs 127137/127136/127135/127108 at 26 inches and
-- 943100/107011/946111/945111 at 54), the one Dyneema webbing they stock, and
-- the three Spyderline braid sizes. The "Sample of ..." variants that share
-- those SKUs with an S suffix are deliberately excluded.
--
-- Adding or removing one is an UPDATE to this row's config, not a code change.
--
-- Data only, so the drizzle snapshots are unaffected and the deploy's
-- destructive-migration gate reads it as additive.
INSERT INTO vendors (id, name, type, config, hostname) VALUES
  ('sailrite', 'Sailrite', 'curated', '{
  "urls": [
    "https://www.sailrite.com/Dacron-Sailcloth-4oz-Dark-Blue-60",
    "https://www.sailrite.com/Dacron-Sailcloth-4oz-Red-60",
    "https://www.sailrite.com/Insignia-Adhesive-Backed-Red-26-Fabric",
    "https://www.sailrite.com/Insignia-Adhesive-Backed-Blue-26-Fabric",
    "https://www.sailrite.com/Insignia-Adhesive-Backed-Black-26-Fabric",
    "https://www.sailrite.com/Insignia-Adhesive-Backed-White-26-Fabric",
    "https://www.sailrite.com/Insignia-Adhesive-Backed-Red-54",
    "https://www.sailrite.com/Insignia-Adhesive-Backed-Blue-54",
    "https://www.sailrite.com/Insignia-Adhesive-Backed-Black-54",
    "https://www.sailrite.com/Insignia-Adhesive-Backed-White-54",
    "https://www.sailrite.com/1-White-Dyneema-Webbing",
    "https://www.sailrite.com/Spyder-Line-Dinghy-One-Design-Braid-1-8mm",
    "https://www.sailrite.com/Spyder-Line-Dinghy-One-Design-Braid-2-8mm",
    "https://www.sailrite.com/Spyder-Line-Dinghy-One-Design-Braid-3-8mm"
  ]
}', 'www.sailrite.com')
ON CONFLICT (id) DO NOTHING;
