CREATE TABLE "product_price_history" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"price_micros" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_product_id_product_cache_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product_cache"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_price_history_product_idx" ON "product_price_history" USING btree ("product_id","recorded_at");