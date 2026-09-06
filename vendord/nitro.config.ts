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
    // Both are midnight in New York -- 04:00 UTC under EDT, 05:00 under EST --
    // and the `nightly` task drops whichever one isn't. See the note there for
    // why this isn't done by setting TZ on the process.
    '0 4 * * *': 'nightly',
    '0 5 * * *': 'nightly'
  }
})
