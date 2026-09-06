import { defineNitroConfig } from 'nitropack/config'

// https://nitro.build/config
export default defineNitroConfig({
  compatibilityDate: 'latest',
  srcDir: 'server',
  imports: false,
  experimental: {
    tasks: true
  },
  scheduledTasks: {
    // Hourly, because croner reads the *host's* local time and this expression
    // cannot name a zone. `nightly` runs the scrape only on the wake-up that
    // lands at midnight in New York and returns immediately on the other 23.
    // See the note there.
    '0 * * * *': 'nightly'
  }
})
