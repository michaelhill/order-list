<script setup>
useHead({
  meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
  link: [{ rel: 'icon', href: '/favicon.ico' }],
  htmlAttrs: {
    lang: 'en'
  }
})

const title = 'Innovators Parts'
const description
  = 'Manage and track your FRC team orders efficiently with Innovators Parts.'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description
})
</script>

<template>
  <div>
    <UHeader>
      <template #left>
        <NuxtLink
          class="font-bold font-display text-2xl sm:text-3xl [@media(max-width:360px)]:text-xl text-blue-950 dark:text-white flex justify-center items-center gap-2 whitespace-nowrap"
          to="/"
        >Innovators <span class="md:inline hidden">Parts</span></NuxtLink>
        <!-- lg, not sm, because that is where UHeader hides its own menu
             button. Anything narrower shows the button, so the links belong in
             the menu behind it -- showing both is what pushed the header past
             the screen (390px was 205px over, and 768px 87px over, which was
             already broken before this). -->
        <div class="ml-4 hidden items-center lg:flex">
          <UButton
            to="/search"
            icon="i-lucide-search"
            variant="ghost"
            color="neutral"
          >
            <span class="hidden md:block">Search Parts</span>
          </UButton>
          <UButton
            to="/price-changes"
            icon="i-lucide-trending-down"
            variant="ghost"
            color="neutral"
          >
            <span class="hidden md:block">Price Changes</span>
          </UButton>
        </div>
      </template>

      <template #right>
        <div class="flex items-center gap-2">
          <ProfileMenu />
          <UColorModeButton class="hidden lg:inline-flex" />
        </div>
      </template>

      <!-- The mobile menu. UHeader renders its toggle regardless, so without
           this the button opened a blank panel. -->
      <template #body>
        <nav class="flex flex-col gap-1">
          <UButton
            to="/search"
            icon="i-lucide-search"
            variant="ghost"
            color="neutral"
            block
            class="justify-start"
            label="Search Parts"
          />
          <UButton
            to="/price-changes"
            icon="i-lucide-trending-down"
            variant="ghost"
            color="neutral"
            block
            class="justify-start"
            label="Price Changes"
          />
          <UButton
            to="/docs"
            icon="i-lucide-book-open"
            variant="ghost"
            color="neutral"
            block
            class="justify-start"
            label="Documentation"
          />
          <USeparator class="my-2" />
          <div class="flex items-center justify-between px-2.5 py-1">
            <span class="text-sm text-muted">Theme</span>
            <UColorModeButton />
          </div>
        </nav>
      </template>
    </UHeader>

    <UMain>
      <slot />
    </UMain>

    <USeparator />

    <UFooter>
      <template #left>
        <p class="text-sm text-muted">
          Innovators Parts — Powered by
          <ULink
            to="https://github.com/frctools/order-list"
            target="_blank"
            class="underline underline-offset-2"
          >FRCTools</ULink>, built by Graham Howard
          • © {{ new Date().getFullYear() }}
        </p>
      </template>

      <!-- Wraps rather than overflows: three buttons in one row is 19px too
           wide for a 320px screen. -->
      <template #right>
        <div class="flex flex-wrap items-center justify-center gap-1">
          <UButton
            to="/docs"
            icon="i-lucide-book-open"
            aria-label="Documentation"
            color="neutral"
            variant="ghost"
          >
            Documentation
          </UButton>
          <UButton
            to="https://www.buymeacoffee.com/grahamsh"
            target="_blank"
            icon="i-lucide-heart"
            aria-label="Support FRCTools"
            class="text-pink-500"
            variant="ghost"
            label="Support FRCTools"
          />
          <UButton
            to="https://github.com/frctools/order-list"
            target="_blank"
            icon="i-simple-icons-github"
            aria-label="GitHub"
            color="neutral"
            variant="ghost"
          />
        </div>
      </template>
    </UFooter>
  </div>
</template>
