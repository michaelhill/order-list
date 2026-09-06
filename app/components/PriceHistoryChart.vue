<script setup lang="ts">
// A step plot, drawn as plain SVG. The data is a handful of points per product
// — one per price change — so a charting library would be several hundred
// kilobytes to draw a dozen line segments, and none of them step the way this
// has to without configuration anyway.

export interface PricePoint {
  price: number;
  recordedAt: string;
  lastSeenAt: string;
}

const props = defineProps<{
  points: PricePoint[];
  currency: string;
  lastCheckedAt: string | null;
}>();

// Viewport units. The SVG scales to its container through viewBox, so these are
// only ever relative to each other.
const W = 720;
const H = 260;
const PAD = { top: 16, right: 16, bottom: 28, left: 56 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const DAY = 24 * 60 * 60 * 1000;

interface Step {
  price: number;
  from: number;
  to: number;
}

// Each price holds from the moment it was first seen until the moment the next
// one was, and the last one holds until the most recent scrape that confirmed
// it. That last bound is the point of storing lastSeenAt: without it the only
// honest thing to draw would be a single dot, and with a guess in its place the
// chart would claim a price for days nobody checked.
const steps = computed((): Step[] => {
  const sorted = [...props.points].sort(
    (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt),
  );
  const end = props.lastCheckedAt
    ? Date.parse(props.lastCheckedAt)
    : Date.parse(sorted.at(-1)?.lastSeenAt ?? new Date().toISOString());

  return sorted.map((point, i) => {
    const from = Date.parse(point.recordedAt);
    const next = sorted[i + 1];
    return {
      price: point.price,
      from,
      to: next ? Date.parse(next.recordedAt) : Math.max(end, from),
    };
  });
});

const domain = computed(() => {
  const first = steps.value[0];
  const last = steps.value.at(-1);
  if (!first || !last) return { t0: 0, t1: 1, p0: 0, p1: 1 };

  const t0 = first.from;
  // The observed window is exactly what gets drawn, however short. Padding it
  // out to a nominal day used to make a genuine few-hour observation render as
  // a stub in the middle of empty chart; spanning the plot with the axis
  // labelled by the real dates says the same thing without the dead space.
  // Only a truly zero-width window needs a guard, and it cannot reach here —
  // the modal shows a single instantaneous observation as text instead.
  const t1 = last.to > t0 ? last.to : t0 + DAY;

  const prices = steps.value.map(step => step.price);
  let p0 = Math.min(...prices);
  let p1 = Math.max(...prices);
  if (p1 - p0 < 1e-9) {
    // A price that has never moved: centre it rather than dividing by zero.
    const pad = Math.max(p1 * 0.1, 1);
    p0 -= pad;
    p1 += pad;
  } else {
    const pad = (p1 - p0) * 0.15;
    p0 -= pad;
    p1 += pad;
  }
  return { t0, t1, p0: Math.max(0, p0), p1 };
});

function x(time: number): number {
  const { t0, t1 } = domain.value;
  const span = t1 - t0 || 1;
  return PAD.left + ((time - t0) / span) * PLOT_W;
}

function y(price: number): number {
  const { p0, p1 } = domain.value;
  const span = p1 - p0 || 1;
  return PAD.top + PLOT_H - ((price - p0) / span) * PLOT_H;
}

// Horizontal run, vertical jump, horizontal run — never a diagonal. A diagonal
// between two samples would read as a price drifting over the days between
// them, when what actually happened is that it held and then moved once.
const linePath = computed(() => {
  const parts: string[] = [];
  steps.value.forEach((step, i) => {
    const yy = y(step.price);
    if (i === 0) parts.push(`M ${x(step.from)} ${yy}`);
    else parts.push(`L ${x(step.from)} ${yy}`);
    parts.push(`L ${x(step.to)} ${yy}`);
  });
  return parts.join(" ");
});

const areaPath = computed(() => {
  if (steps.value.length === 0) return "";
  const base = PAD.top + PLOT_H;
  const first = steps.value[0]!;
  const last = steps.value.at(-1)!;
  return `${linePath.value} L ${x(last.to)} ${base} L ${x(first.from)} ${base} Z`;
});

function formatPrice(price: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: props.currency || "USD",
    // Sub-cent prices are real (distributors quote them at quantity breaks),
    // but only spell them out when they carry.
    maximumFractionDigits: Math.round(price * 100) === price * 100 ? 2 : 4,
  }).format(price);
}

function formatDate(time: number): string {
  return new Date(time).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDate(time: number): string {
  return new Date(time).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

const priceTicks = computed(() => {
  const { p0, p1 } = domain.value;
  return [0, 0.5, 1].map((f) => {
    const price = p0 + (p1 - p0) * f;
    return { price, y: y(price) };
  });
});

const dateTicks = computed(() => {
  const { t0, t1 } = domain.value;
  const count = t1 - t0 > 45 * DAY ? 4 : 3;
  return Array.from({ length: count }, (_, i) => {
    const time = t0 + ((t1 - t0) * i) / (count - 1);
    return { time, x: x(time) };
  });
});

// Hover readout. Tracking the pointer against the step the cursor sits inside
// is what makes a sparse chart legible — a tooltip anchored to the change dots
// alone would leave the long flat runs, which are most of the chart, inert.
const hover = ref<{ x: number; time: number; step: Step } | null>(null);
const svgEl = useTemplateRef<SVGSVGElement>("svgEl");

function onMove(event: PointerEvent) {
  const svg = svgEl.value;
  if (!svg || steps.value.length === 0) return;
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0) return;
  // Client pixels -> viewBox units.
  const vx = ((event.clientX - rect.left) / rect.width) * W;
  const clamped = Math.min(Math.max(vx, PAD.left), PAD.left + PLOT_W);
  const { t0, t1 } = domain.value;
  const time = t0 + ((clamped - PAD.left) / PLOT_W) * (t1 - t0);
  const step
    = steps.value.find(s => time >= s.from && time <= s.to)
    ?? (time < steps.value[0]!.from ? steps.value[0]! : steps.value.at(-1)!);
  hover.value = { x: clamped, time, step };
}

function onLeave() {
  hover.value = null;
}

// Keep the readout box inside the plot at both ends.
const hoverBox = computed(() => {
  if (!hover.value) return null;
  const width = 150;
  const left = Math.min(
    Math.max(hover.value.x - width / 2, PAD.left),
    PAD.left + PLOT_W - width,
  );
  return { left, width };
});
</script>

<template>
  <div class="w-full">
    <svg
      ref="svgEl"
      :viewBox="`0 0 ${W} ${H}`"
      class="w-full h-auto touch-none"
      role="img"
      aria-label="Price over time"
      @pointermove="onMove"
      @pointerleave="onLeave"
    >
      <defs>
        <linearGradient id="price-history-fill" x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0%"
            stop-color="currentColor"
            class="text-primary"
            stop-opacity="0.18"
          />
          <stop
            offset="100%"
            stop-color="currentColor"
            class="text-primary"
            stop-opacity="0"
          />
        </linearGradient>
      </defs>

      <!-- Horizontal gridlines and the price axis. -->
      <g class="text-muted">
        <line
          v-for="tick in priceTicks"
          :key="`grid-${tick.y}`"
          :x1="PAD.left"
          :x2="PAD.left + PLOT_W"
          :y1="tick.y"
          :y2="tick.y"
          stroke="currentColor"
          stroke-opacity="0.18"
          stroke-width="1"
        />
        <text
          v-for="tick in priceTicks"
          :key="`ylabel-${tick.y}`"
          :x="PAD.left - 8"
          :y="tick.y + 4"
          text-anchor="end"
          fill="currentColor"
          font-size="11"
        >
          {{ formatPrice(tick.price) }}
        </text>
        <text
          v-for="tick in dateTicks"
          :key="`xlabel-${tick.x}`"
          :x="tick.x"
          :y="H - 8"
          text-anchor="middle"
          fill="currentColor"
          font-size="11"
        >
          {{ formatShortDate(tick.time) }}
        </text>
      </g>

      <path :d="areaPath" fill="url(#price-history-fill)" />
      <path
        :d="linePath"
        fill="none"
        stroke="currentColor"
        class="text-primary"
        stroke-width="2"
        stroke-linejoin="round"
      />

      <!-- A dot at each price change, plus one at the start. -->
      <circle
        v-for="(step, i) in steps"
        :key="`dot-${i}`"
        :cx="x(step.from)"
        :cy="y(step.price)"
        r="3.5"
        fill="currentColor"
        class="text-primary"
      />

      <g v-if="hover && hoverBox">
        <line
          :x1="hover.x"
          :x2="hover.x"
          :y1="PAD.top"
          :y2="PAD.top + PLOT_H"
          stroke="currentColor"
          class="text-muted"
          stroke-opacity="0.5"
          stroke-width="1"
          stroke-dasharray="3 3"
        />
        <circle
          :cx="hover.x"
          :cy="y(hover.step.price)"
          r="5"
          fill="currentColor"
          class="text-primary"
          fill-opacity="0.25"
        />
        <rect
          :x="hoverBox.left"
          :y="PAD.top"
          :width="hoverBox.width"
          height="40"
          rx="6"
          class="fill-default stroke-default"
          stroke-width="1"
        />
        <text
          :x="hoverBox.left + 10"
          :y="PAD.top + 17"
          fill="currentColor"
          font-size="12"
          font-weight="600"
        >
          {{ formatPrice(hover.step.price) }}
        </text>
        <text
          :x="hoverBox.left + 10"
          :y="PAD.top + 32"
          fill="currentColor"
          class="text-muted"
          font-size="11"
        >
          {{ formatDate(hover.time) }}
        </text>
      </g>
    </svg>
  </div>
</template>
