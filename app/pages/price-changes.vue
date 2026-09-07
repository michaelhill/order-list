<script setup lang="ts">
import { refDebounced } from "@vueuse/core";
import { useRouteQuery } from "@vueuse/router";
import type { TableColumn } from "@nuxt/ui";

definePageMeta({
  layout: "default",
});

const pageTitle = "Price Changes";
const pageDescription
  = "Every price move recorded across the tracked vendor catalogue.";

useSeoMeta({
  title: pageTitle,
  description: pageDescription,
  ogTitle: pageTitle,
  ogDescription: pageDescription,
});

interface PriceChange {
  id: string;
  title: string;
  vendorName: string;
  url: string | null;
  image: string | null;
  currency: string;
  previousPrice: number;
  newPrice: number;
  absolute: number;
  percent: number | null;
  changedAt: string;
}

interface PriceChangeResponse {
  changes: PriceChange[];
  total: number;
  increases: number;
  decreases: number;
  page: number;
  limit: number;
  from: string;
  to: string;
  vendors: Array<{ name: string; count: number }>;
  truncated: boolean;
}

// Deliberately the UTC day rather than the viewer's local one. This page is
// server-rendered, so the default range is computed twice -- once on the
// droplet and once in the browser -- and a local-day default makes those two
// disagree whenever the two are not on the same calendar date. That is not a
// cosmetic mismatch: the SSR pass would fetch one range, the client would
// hydrate with another and immediately fetch again, so a page load costs two
// of these queries on a one-core box and the dates visibly jump.
//
// UTC is also the right anchor rather than merely a consistent one: the
// droplet runs on it, and the server reads these dates as its own local
// midnight against timestamps vendord writes at the same offset.
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return isoDay(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

const DEFAULT_DAYS = 30;

// In the URL, so a filtered view can be linked to and survives a reload.
const fromDate = useRouteQuery<string>("from", daysAgo(DEFAULT_DAYS));
const toDate = useRouteQuery<string>("to", isoDay(new Date()));
const selectedVendors = useRouteQuery<string[]>("vendors", []);
const searchTerm = useRouteQuery<string>("q", "");
const sortBy = useRouteQuery<"recent" | "drop" | "rise" | "movement">(
  "sort",
  "recent",
);
const page = useRouteQuery("page", 1, { transform: Number });

const debouncedSearch = refDebounced(searchTerm, 300);

const { data, status, error } = await useFetch<PriceChangeResponse>(
  "/api/vendors/price-changes",
  {
    query: {
      from: fromDate,
      to: toDate,
      vendors: selectedVendors,
      q: debouncedSearch,
      sort: sortBy,
      page,
      limit: 50,
    },
    lazy: true,
  },
);

// Any change to what is being asked puts you back on the first page -- staying
// on page 7 of a result set that now has two pages shows an empty table.
watch([fromDate, toDate, selectedVendors, debouncedSearch, sortBy], () => {
  page.value = 1;
});

const changes = computed(() => data.value?.changes ?? []);
const total = computed(() => data.value?.total ?? 0);

const vendorOptions = computed(() =>
  (data.value?.vendors ?? []).map(vendor => ({
    label: `${vendor.name} (${vendor.count})`,
    value: vendor.name,
  })),
);

const sortOptions = [
  { label: "Most recent", value: "recent" },
  { label: "Biggest drop", value: "drop" },
  { label: "Biggest rise", value: "rise" },
  { label: "Biggest move", value: "movement" },
];

const rangePresets = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

function applyPreset(days: number) {
  fromDate.value = daysAgo(days);
  toDate.value = isoDay(new Date());
}

function isPresetActive(days: number) {
  return fromDate.value === daysAgo(days) && toDate.value === isoDay(new Date());
}

const hasFilters = computed(
  () =>
    selectedVendors.value.length > 0
    || Boolean(searchTerm.value)
    || sortBy.value !== "recent"
    || !isPresetActive(DEFAULT_DAYS),
);

function clearFilters() {
  selectedVendors.value = [];
  searchTerm.value = "";
  sortBy.value = "recent";
  applyPreset(DEFAULT_DAYS);
}

function formatPrice(price: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    // Sub-cent prices are real in this catalogue, so they are shown rather
    // than rounded away -- but only when the figure actually carries them.
    maximumFractionDigits: Math.round(price * 100) === price * 100 ? 2 : 4,
  }).format(price);
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const columns: TableColumn<PriceChange>[] = [
  { accessorKey: "title", header: "Product" },
  { accessorKey: "vendorName", header: "Vendor" },
  { accessorKey: "previousPrice", header: "Was" },
  { accessorKey: "newPrice", header: "Now" },
  { accessorKey: "percent", header: "Change" },
  { accessorKey: "changedAt", header: "Changed" },
];

// One modal for the page, as the search page does: a page of rows is up to 50
// products and almost none of them will be asked about.
const historyProduct = ref<{ id: string; title: string } | null>(null);
const historyOpen = ref(false);

function openPriceHistory(change: PriceChange) {
  historyProduct.value = { id: change.id, title: change.title };
  historyOpen.value = true;
}
</script>

<template>
  <div>
    <UPageHero
      title="Price Changes"
      description="Every price move recorded across the tracked vendor catalogue"
    />

    <UContainer class="py-8">
      <div class="flex flex-col gap-4 mb-6">
        <div class="flex flex-wrap items-end gap-3">
          <UFormField label="From">
            <UInput v-model="fromDate" type="date" class="w-44" />
          </UFormField>

          <UFormField label="To">
            <UInput v-model="toDate" type="date" class="w-44" />
          </UFormField>

          <div class="flex gap-1 pb-0.5">
            <UButton
              v-for="preset in rangePresets"
              :key="preset.days"
              size="sm"
              :variant="isPresetActive(preset.days) ? 'solid' : 'ghost'"
              color="neutral"
              @click="applyPreset(preset.days)"
            >
              {{ preset.label }}
            </UButton>
          </div>
        </div>

        <div class="flex flex-wrap gap-3">
          <UInput
            v-model="searchTerm"
            icon="i-lucide-search"
            placeholder="Filter by product or vendor..."
            class="flex-1 min-w-64"
            :loading="status === 'pending'"
          />

          <USelectMenu
            v-model="selectedVendors"
            :items="vendorOptions"
            value-key="value"
            multiple
            placeholder="All vendors"
            class="w-56"
            :disabled="vendorOptions.length === 0"
          />

          <USelectMenu
            v-model="sortBy"
            :items="sortOptions"
            value-key="value"
            class="w-44"
          />

          <UButton
            v-if="hasFilters"
            variant="ghost"
            color="neutral"
            icon="i-lucide-x"
            @click="clearFilters"
          >
            Clear
          </UButton>
        </div>
      </div>

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        class="mb-6"
        title="Could not load price changes"
        :description="error.statusMessage || 'Please try again.'"
      />

      <UAlert
        v-else-if="data?.truncated"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        class="mb-6"
        title="Showing a partial range"
        description="This range holds more changes than one request returns. Narrow the dates to see all of them."
      />

      <div
        v-if="!error"
        class="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-4 text-sm"
      >
        <p class="text-muted">
          {{ total }} change{{ total === 1 ? "" : "s" }}
        </p>
        <p v-if="data && data.decreases > 0" class="text-success">
          {{ data.decreases }} decrease{{ data.decreases === 1 ? "" : "s" }}
        </p>
        <p v-if="data && data.increases > 0" class="text-error">
          {{ data.increases }} increase{{ data.increases === 1 ? "" : "s" }}
        </p>
      </div>

      <div v-if="status === 'pending' && changes.length === 0" class="space-y-2">
        <USkeleton v-for="row in 8" :key="row" class="h-12 rounded-lg" />
      </div>

      <UPageCard
        v-else-if="!error && total === 0"
        class="text-center py-12"
      >
        <UIcon
          name="i-lucide-chart-no-axes-combined"
          class="w-12 h-12 mx-auto mb-4 text-muted"
        />
        <h3 class="text-lg font-medium mb-2">No price changes in this range</h3>
        <p class="text-muted">
          Prices are checked once a night, and only moves are recorded — a quiet
          range is a real answer. Try widening the dates or clearing filters.
        </p>
      </UPageCard>

      <template v-else-if="!error">
        <UTable
          :columns="columns"
          :data="changes"
          :loading="status === 'pending'"
        >
          <template #title-cell="{ row }">
            <div class="flex items-center gap-3 max-w-md">
              <img
                v-if="row.original.image"
                :src="row.original.image"
                :alt="row.original.title"
                class="w-10 h-10 rounded object-contain bg-elevated shrink-0"
              >
              <div class="min-w-0">
                <ULink
                  v-if="row.original.url"
                  :to="row.original.url"
                  target="_blank"
                  class="font-medium hover:underline line-clamp-2"
                >
                  {{ row.original.title }}
                </ULink>
                <span v-else class="font-medium line-clamp-2">
                  {{ row.original.title }}
                </span>
              </div>
            </div>
          </template>

          <template #vendorName-cell="{ row }">
            <span class="text-sm text-muted">{{ row.original.vendorName }}</span>
          </template>

          <template #previousPrice-cell="{ row }">
            <span class="text-muted line-through">
              {{ formatPrice(row.original.previousPrice, row.original.currency) }}
            </span>
          </template>

          <template #newPrice-cell="{ row }">
            <span class="font-medium">
              {{ formatPrice(row.original.newPrice, row.original.currency) }}
            </span>
          </template>

          <template #percent-cell="{ row }">
            <UBadge
              size="sm"
              variant="subtle"
              :color="row.original.absolute > 0 ? 'error' : 'success'"
              :icon="
                row.original.absolute > 0
                  ? 'i-lucide-trending-up'
                  : 'i-lucide-trending-down'
              "
            >
              {{ row.original.absolute > 0 ? "+" : "−"
              }}{{ formatPrice(Math.abs(row.original.absolute), row.original.currency) }}
              <span v-if="row.original.percent !== null" class="opacity-75">
                ({{ row.original.percent > 0 ? "+" : ""
                }}{{ row.original.percent.toFixed(1) }}%)
              </span>
            </UBadge>
          </template>

          <template #changedAt-cell="{ row }">
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm text-muted whitespace-nowrap">
                {{ formatDate(row.original.changedAt) }}
              </span>
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-chart-line"
                aria-label="Price history"
                @click="openPriceHistory(row.original)"
              />
            </div>
          </template>
        </UTable>

        <div v-if="total > 50" class="flex justify-center mt-6">
          <UPagination
            v-model:page="page"
            :total="total"
            :items-per-page="50"
          />
        </div>
      </template>

      <p class="text-xs text-muted mt-6">
        Prices are checked once a night and only changes are stored, so a change
        is dated the night it was first seen — not necessarily the day the
        vendor made it.
      </p>
    </UContainer>

    <PriceHistoryModal
      v-model:open="historyOpen"
      :product-id="historyProduct?.id ?? null"
      :title="historyProduct?.title ?? ''"
    />
  </div>
</template>
