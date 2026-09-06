<script setup lang="ts">
import { computed, ref } from 'vue'
import { canBuildVendorCart, isPerItemCartVendor } from '~/utils/cart'
import type { Order } from '~/types/orders'
import type { CartLinkResult } from '~~/server/utils/cart-link'

const props = defineProps<{
  order: Order
  // Icon-only, for the denser table view.
  compact?: boolean
}>()

const toast = useToast()
const loading = ref(false)

// Handing off to a cart only makes sense while the order is still being
// assembled — once it's placed, the link would just build a second cart.
const visible = computed(
  () => props.order.status === 'to_order' && canBuildVendorCart(props.order)
)

const vendorLabel = computed(
  () => props.order.vendorName?.trim() || 'the vendor'
)

// BigCommerce adds one part at a time, so those orders get a list instead of
// a single link. Known before the request, so the button can skip pre-opening
// a tab it won't use.
const perItem = computed(() => isPerItemCartVendor(props.order))

const plan = ref<CartLinkResult | null>(null)
const listOpen = ref(false)
// Which parts have been clicked, so a long order doesn't lose its place.
const addedIds = ref(new Set<string>())

// Vendors whose add endpoint answers with JSON rather than a page (Rock West's
// Salesforce Commerce one does) would otherwise leave the buyer looking at a
// wall of `{"action":"Cart-AddProduct"...}` in the handoff tab. Once the add
// has landed, put the cart there instead.
//
// The add has to be a top-level navigation, so this cannot be tidied away into
// a hidden iframe: the store's session cookie would then be third-party and
// blocked, and the cart the buyer finally opened would be empty. And nothing
// cross-origin reports when that navigation finished -- no load event reaches
// this window -- so the follow-up is timed rather than triggered.
//
// The delay is therefore load-bearing, not cosmetic. Navigating too early
// aborts the POST in flight and the part is silently missing from the cart:
// measured, a 250ms follow-up loses the add outright, while 800ms does not.
// The add itself loaded in 330-776ms over five runs, so 2s is roughly 2.5x the
// slowest observed and 5x the median. A connection slow enough to beat that
// still fails visibly rather than quietly -- the buyer lands on the cart page,
// which lists exactly what is in it, with every row still clickable to retry.
const CART_REVEAL_MS = 2000
let revealTimer: ReturnType<typeof setTimeout> | undefined

function revealCartAfterAdd() {
  const cartUrl = plan.value?.cartUrl
  if (!cartUrl) return
  // Rescheduled on every row, so a buyer working down a list only waits out
  // the delay once, after the last part they add.
  clearTimeout(revealTimer)
  revealTimer = setTimeout(() => {
    // Re-targets the existing named window rather than opening another.
    window.open(cartUrl, 'vendorcart')
  }, CART_REVEAL_MS)
}

// Rows that submit a form need the reveal; plain links land on a real page
// already, so they get the tick and nothing more.
function onAddSubmit(id: string) {
  addedIds.value.add(id)
  revealCartAfterAdd()
}

// Shared between the link rows and the form rows, which have to look alike.
const rowClass
  = 'flex w-full items-start gap-2 rounded-md p-1.5 text-sm '
    + 'hover:bg-gray-100 dark:hover:bg-gray-800'

function rowIcon(id: string): string {
  return addedIds.value.has(id) ? 'i-lucide-check' : 'i-lucide-plus'
}

function rowIconClass(id: string): string {
  return `mt-0.5 shrink-0 ${
    addedIds.value.has(id) ? 'text-primary-500' : 'text-gray-400'
  }`
}

const failureMessage: Record<CartLinkResult['reason'], string> = {
  ok: '',
  'no-vendor': 'These parts don\'t share a single storefront to open a cart on.',
  'unsupported-platform':
    'This vendor\'s store doesn\'t support building a cart from a link.',
  'no-variants':
    'None of these parts could be matched to something on the vendor\'s site.'
}

async function fetchPlan(): Promise<CartLinkResult | null> {
  try {
    return await $fetch<CartLinkResult>(
      `/api/orders/${props.order.id}/cart-link`
    )
  } catch {
    toast.add({
      title: 'Could not build the cart',
      description: `We couldn't reach ${vendorLabel.value} to look up these parts.`,
      color: 'error'
    })
    return null
  }
}

function reportShortfall(result: CartLinkResult) {
  if (result.excluded.length === 0) return
  toast.add({
    title: `Added ${result.included.length} of ${props.order.itemCount} parts`,
    description: `${result.excluded.map(item => item.partName).join(', ')} still need adding by hand.`,
    color: 'warning'
  })
}

async function openList() {
  if (loading.value) return
  loading.value = true
  try {
    const result = await fetchPlan()
    if (!result) return
    if (!result.addLinks?.length) {
      toast.add({
        title: 'Nothing to add to the cart',
        description: failureMessage[result.reason],
        color: 'warning'
      })
      return
    }
    plan.value = result
    addedIds.value = new Set()
    clearTimeout(revealTimer)
    listOpen.value = true
    reportShortfall(result)
  } finally {
    loading.value = false
  }
}

async function openCart() {
  if (loading.value) return
  // Open the tab up front: a window.open() that happens after an `await` has
  // lost the user gesture and gets caught by popup blockers.
  const tab = window.open('', '_blank')
  loading.value = true

  try {
    const result = await fetchPlan()
    if (!result) {
      tab?.close()
      return
    }
    if (!result.url) {
      tab?.close()
      toast.add({
        title: 'Nothing to add to the cart',
        description: failureMessage[result.reason],
        color: 'warning'
      })
      return
    }

    if (tab) tab.location.href = result.url
    // Popup blocked despite the pre-open — fall back to this tab.
    else window.location.href = result.url

    reportShortfall(result)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <UPopover v-if="visible && perItem" v-model:open="listOpen">
    <UButton
      size="xs"
      :variant="compact ? 'ghost' : 'soft'"
      color="primary"
      icon="i-lucide-shopping-cart"
      :loading="loading"
      :title="`Add these parts to your cart at ${vendorLabel}`"
      :label="compact ? undefined : 'Add parts'"
      @click.prevent="openList"
    />

    <template #content>
      <div class="w-80 p-3">
        <p class="text-xs text-gray-500">
          {{ vendorLabel }} adds one part at a time. Open each in turn — they
          build up in the same cart. A part that needs options chosen, or is
          out of stock, opens its own page instead.
        </p>

        <ul class="mt-2 space-y-1">
          <li
            v-for="link in plan?.addLinks ?? []"
            :key="link.id"
          >
            <!--
              Some vendors (Playing With Fusion) only add on a POST, so those
              rows submit a form rather than following a link. Both target the
              same named window so the buyer stays in one tab.
            -->
            <form
              v-if="link.postFields"
              :action="link.url"
              method="post"
              target="vendorcart"
              @submit="onAddSubmit(link.id)"
            >
              <input
                v-for="(value, name) in link.postFields"
                :key="name"
                type="hidden"
                :name="name"
                :value="value"
              >
              <button type="submit" :class="rowClass">
                <UIcon :name="rowIcon(link.id)" :class="rowIconClass(link.id)" />
                <span class="min-w-0 flex-1 text-left">
                  <span class="block truncate">{{ link.partName }}</span>
                  <span class="text-xs text-gray-500">&times;{{ link.quantity }}</span>
                </span>
              </button>
            </form>

            <a
              v-else
              :href="link.url"
              target="vendorcart"
              :class="rowClass"
              @click="addedIds.add(link.id)"
            >
              <UIcon :name="rowIcon(link.id)" :class="rowIconClass(link.id)" />
              <span class="min-w-0 flex-1">
                <span class="block truncate">{{ link.partName }}</span>
                <span class="text-xs text-gray-500">&times;{{ link.quantity }}</span>
              </span>
            </a>
          </li>
        </ul>

        <a
          v-if="plan?.cartUrl"
          :href="plan.cartUrl"
          target="vendorcart"
          class="mt-2 inline-flex items-center gap-1 text-xs text-primary-500 hover:underline"
        >
          <UIcon name="i-lucide-shopping-cart" />
          View cart at {{ vendorLabel }}
        </a>
      </div>
    </template>
  </UPopover>

  <UButton
    v-else-if="visible"
    size="xs"
    :variant="compact ? 'ghost' : 'soft'"
    color="primary"
    icon="i-lucide-shopping-cart"
    :loading="loading"
    :title="`Open a cart at ${vendorLabel} with these parts`"
    :label="compact ? undefined : 'Open cart'"
    @click="openCart"
  />
</template>
