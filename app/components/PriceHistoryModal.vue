<script setup lang="ts">
import type { PricePoint } from "./PriceHistoryChart.vue";

interface PriceHistoryResponse {
  productId: string;
  currency: string;
  points: PricePoint[];
  trackedSince: string | null;
  lastCheckedAt: string | null;
}

const props = defineProps<{
  // The search document id — base64 of the product cache key. The endpoint
  // accepts the raw cache key too.
  productId: string | null;
  title: string;
}>();

const open = defineModel<boolean>("open", { default: false });

const data = ref<PriceHistoryResponse | null>(null);
const pending = ref(false);
const error = ref<string | null>(null);

// Fetch on open rather than up front: a page of results is up to 100 products
// and almost none of them will be asked about.
watch(
  [open, () => props.productId],
  async ([isOpen, productId]) => {
    if (!isOpen || !productId) return;
    if (data.value?.productId && data.value.productId === productId) return;
    pending.value = true;
    error.value = null;
    data.value = null;
    try {
      data.value = await $fetch<PriceHistoryResponse>(
        "/api/vendors/price-history",
        { query: { id: productId } },
      );
    } catch {
      error.value = "Could not load price history for this product.";
    } finally {
      pending.value = false;
    }
  },
  { immediate: true },
);

const points = computed(() => data.value?.points ?? []);
const currency = computed(() => data.value?.currency ?? "USD");

function formatPrice(price: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.value,
    maximumFractionDigits: Math.round(price * 100) === price * 100 ? 2 : 4,
  }).format(price);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// A product observed only once has no history to draw — and on the morning
// after the first nightly run, that is every product. A chart of one point is a
// dot on an axis, so say what is actually known instead.
const DAY = 24 * 60 * 60 * 1000;
const tooNewToPlot = computed(() => {
  if (points.value.length !== 1) return false;
  const only = points.value[0]!;
  return Date.parse(only.lastSeenAt) - Date.parse(only.recordedAt) < DAY;
});

const current = computed(() => points.value.at(-1)?.price ?? null);
const lowest = computed(() =>
  points.value.length ? Math.min(...points.value.map(p => p.price)) : null);
const highest = computed(() =>
  points.value.length ? Math.max(...points.value.map(p => p.price)) : null);

// Movement since tracking began, which is the number people actually want off
// this chart.
const change = computed(() => {
  const first = points.value[0]?.price;
  const last = current.value;
  if (first == null || last == null || first === 0) return null;
  return { absolute: last - first, percent: ((last - first) / first) * 100 };
});

// Newest first: the most recent change is the one being looked for.
const changeLog = computed(() =>
  [...points.value].reverse().map((point, i, all) => {
    const previous = all[i + 1];
    return {
      recordedAt: point.recordedAt,
      price: point.price,
      delta: previous ? point.price - previous.price : null,
    };
  }));
</script>

<template>
  <UModal v-model:open="open" :title="title" :ui="{ content: 'max-w-3xl' }">
    <template #body>
      <div v-if="pending" class="flex justify-center py-16">
        <UIcon
          name="i-lucide-loader-2"
          class="w-7 h-7 animate-spin text-primary"
        />
      </div>

      <UAlert
        v-else-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="error"
      />

      <div v-else-if="points.length === 0" class="text-center py-12">
        <UIcon
          name="i-lucide-chart-line"
          class="w-10 h-10 mx-auto mb-3 text-muted"
        />
        <h3 class="font-medium mb-1">No price history yet</h3>
        <p class="text-sm text-muted">
          Prices are recorded once a night. This product's first point will
          appear after the next run.
        </p>
      </div>

      <div v-else-if="tooNewToPlot" class="text-center py-10">
        <p class="text-xs text-muted uppercase tracking-wide mb-1">
          First recorded price
        </p>
        <p class="text-3xl font-semibold text-primary mb-3">
          {{ formatPrice(current!) }}
        </p>
        <p class="text-sm text-muted">
          Tracked since {{ formatDate(data?.trackedSince ?? null) }}. There is
          only one observation so far — a chart appears once this price has been
          confirmed on a second night, or changes.
        </p>
      </div>

      <div v-else class="space-y-5">
        <div class="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <p class="text-xs text-muted uppercase tracking-wide">Current</p>
            <p class="text-2xl font-semibold text-primary">
              {{ formatPrice(current!) }}
            </p>
          </div>
          <div v-if="change && Math.abs(change.absolute) > 1e-9">
            <p class="text-xs text-muted uppercase tracking-wide">
              Since tracking began
            </p>
            <p
              class="text-lg font-medium"
              :class="change.absolute > 0 ? 'text-error' : 'text-success'"
            >
              {{ change.absolute > 0 ? "+" : "−"
              }}{{ formatPrice(Math.abs(change.absolute)) }}
              <span class="text-sm text-muted">
                ({{ change.percent > 0 ? "+" : ""
                }}{{ change.percent.toFixed(1) }}%)
              </span>
            </p>
          </div>
          <div v-if="lowest !== null && highest !== null && lowest !== highest">
            <p class="text-xs text-muted uppercase tracking-wide">Range</p>
            <p class="text-lg font-medium">
              {{ formatPrice(lowest) }} – {{ formatPrice(highest) }}
            </p>
          </div>
        </div>

        <PriceHistoryChart
          :points="points"
          :currency="currency"
          :last-checked-at="data?.lastCheckedAt ?? null"
        />

        <p class="text-xs text-muted">
          Tracked since {{ formatDate(data?.trackedSince ?? null) }} · last
          checked {{ formatDate(data?.lastCheckedAt ?? null) }}. Only changes
          are stored, so the line holds flat between them — the price moved on
          the day it steps, not gradually.
        </p>

        <div v-if="changeLog.length > 1">
          <h4 class="text-sm font-medium mb-2">Changes</h4>
          <ul class="divide-y divide-default text-sm">
            <li
              v-for="entry in changeLog"
              :key="entry.recordedAt"
              class="flex items-center justify-between py-1.5"
            >
              <span class="text-muted">{{ formatDate(entry.recordedAt) }}</span>
              <span class="flex items-center gap-2">
                <span class="font-medium">{{ formatPrice(entry.price) }}</span>
                <UBadge
                  v-if="entry.delta !== null"
                  size="sm"
                  variant="subtle"
                  :color="entry.delta > 0 ? 'error' : 'success'"
                >
                  {{ entry.delta > 0 ? "+" : "−"
                  }}{{ formatPrice(Math.abs(entry.delta)) }}
                </UBadge>
                <UBadge v-else size="sm" variant="subtle" color="neutral">
                  first seen
                </UBadge>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </UModal>
</template>
