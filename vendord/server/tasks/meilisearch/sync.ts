import { defineTask } from "nitropack/runtime";
import { MeiliSearch, MeiliSearchApiError } from "meilisearch";
import { useDB } from "../../../../server/utils/db";
import { productCache, vendors } from "../../../../server/utils/schema";
import {
  htmlToText,
  parseCachedProduct,
  productPrice,
} from "../../utils/product-doc";

interface ProductDocument {
  id: string;
  title: string;
  description?: string;
  image?: string;
  price?: number;
  currency?: string;
  vendorId: string;
  vendorName: string;
  vendorHostname?: string;
  vendorType?: string;
  variantId?: string;
  variantTitle?: string;
  skus?: string[];
  originalUrl?: string;
  updatedAt: string;
}

interface TaskResult {
  success: boolean;
  error?: string;
  indexed?: number;
  message?: string;
  taskUids?: number[];
  indexName?: string;
}

export default defineTask({
  meta: {
    name: "meilisearch:sync",
    description: "Sync all cached products to Meilisearch",
  },
  async run(): Promise<{ result: TaskResult }> {
    const meiliHost = process.env.MEILISEARCH_HOST;
    const meiliKey = process.env.MEILISEARCH_API_KEY;
    const indexName = process.env.MEILISEARCH_INDEX || "products";

    if (!meiliHost) {
      return {
        result: { success: false, error: "MEILISEARCH_HOST is not configured" },
      };
    }

    const client = new MeiliSearch({
      host: meiliHost,
      apiKey: meiliKey,
    });

    const db = useDB();
    const allProducts = await db.select().from(productCache);
    const allVendors = await db.select().from(vendors);
    if (allProducts.length === 0) {
      return {
        result: { success: true, indexed: 0, message: "No products to index" },
      };
    }

    const documents: ProductDocument[] = allProducts
      .map((cached) => {
        const product = parseCachedProduct(cached.productJson, cached.id);
        if (!product) return undefined;
        const vendor = allVendors.find((v) => v.id === cached.vendorId);
        if (!vendor) {
          return undefined;
        }

        return {
          id: Buffer.from(cached.id).toString("base64").replace(/=/g, ""),
          title: product.title || "Unknown Product",
          description:
            htmlToText(product.description)
            ?? htmlToText(product.body_html)
            ?? "No description",
          image: product.image || product.images?.[0]?.src,
          price: productPrice(product),
          currency: product.currency,
          vendorId: cached.vendorId,
          vendorName: vendor.name || cached.vendorId,
          vendorHostname: vendor.hostname,
          vendorType: vendor.type,
          variantId: product.variants?.[0]?.id,
          variantTitle: product.variants?.[0]?.title,
          skus: [
            ...(product.variants?.map(
              (v: Record<string, unknown>) => v.sku || v.id,
            ) || []),
          ],
          updatedAt: cached.updatedAt.toISOString(),
          originalUrl:
            product.url || product.handle
              ? vendor.type === "shopify"
                ? `https://${vendor.hostname}/products/${product.handle}`
                : `https://${vendor.hostname}/${product.handle}`
              : undefined,
        };
      })
      .filter((doc) => doc !== undefined);

    const index = client.index(indexName);
    try {
      await index.fetchInfo();
    } catch (error: unknown) {
      if (
        error instanceof MeiliSearchApiError &&
        error.cause?.code == "index_not_found"
      ) {
        client.createIndex(indexName);
        console.log(`Created index ${indexName}`);
      } else {
        throw error;
      }
    }

    await index.updateSettings({
      // "sort" ahead of the relevance rules, which is not where Meilisearch
      // puts it by default -- the default order is words, typo, proximity,
      // attribute, sort, exactness, so an explicit sort only ever breaks ties
      // between documents relevance had already tied. That made
      // `sort=price-asc` look broken in exactly the way a user would notice:
      // searching "led" and asking for cheapest first returned $24.99, $29.99,
      // $2.49, because those sat in three different relevance buckets and each
      // bucket was sorted on its own. Storing prices as numbers was necessary
      // for the sort to mean anything at all, but not sufficient for it to
      // apply. With sort first, a request that names one gets it applied
      // across the whole result set, and a request that does not is unaffected
      // -- the rule is a no-op without a sort parameter, so plain relevance
      // ranking is unchanged.
      rankingRules: [
        "sort",
        "words",
        "typo",
        "proximity",
        "attribute",
        "exactness"
      ],
      searchableAttributes: ["title", "description", "vendorName", "skus"],
      filterableAttributes: [
        "vendorId",
        "vendorName",
        "vendorType",
        "currency",
      ],
      sortableAttributes: ["price", "updatedAt", "title"],
    });

    const chunkSize = 1000;
    const tasks = [];
    for (let i = 0; i < documents.length; i += chunkSize) {
      const chunk = documents.slice(i, i + chunkSize);
      const task = await index.addDocuments(chunk, { primaryKey: "id" });
      tasks.push(task.taskUid);
      await client.tasks.waitForTask(task.taskUid, { timeout: 10000 });
    }

    return {
      result: {
        success: true,
        indexed: documents.length,
        taskUids: tasks,
        indexName,
      },
    };
  },
});
