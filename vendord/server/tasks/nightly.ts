import { defineTask, runTask } from "nitropack/runtime";

// Midnight Eastern, without depending on what timezone the host is in.
//
// Nitro schedules with croner and hands it nothing but the expression --
// `new Cron(expr, handler)` in nitropack/dist/runtime/internal/task.mjs -- so
// there is no zone to pass and croner reads the host's local time. The obvious
// fix, TZ=America/New_York on the vendord process, is the wrong one here: every
// timestamp column in this schema is `timestamp without time zone`, and
// node-postgres serializes a Date using the process's local offset, so vendord
// would start writing timestamps hours off from what the app writes and reads.
// Nothing would error; the data would just quietly disagree.
//
// The first attempt fired at 04:00 and 05:00 UTC -- midnight Eastern under EDT
// and EST -- and dropped whichever wasn't midnight. That was correct only
// while the host stayed on UTC, an assumption nothing enforced and nothing
// would have reported breaking: on a workstation already set to Eastern those
// same expressions mean 4am and 5am local, and the task simply never ran at
// midnight. So wake hourly and decide here. 23 no-op wake-ups a day cost one
// Intl call each, and the schedule is now correct on any host, in any zone,
// across both DST transitions.
function easternHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hourCycle: "h23",
  }).format(now);
  // h23 gives 0-23, but be defensive: some ICU builds report midnight as 24.
  return Number(hour) % 24;
}

export default defineTask({
  meta: {
    name: "nightly",
    description: "Run the scrape at midnight Eastern, whatever the host clock",
  },
  async run() {
    const hour = easternHour(new Date());
    if (hour !== 0) {
      // Logged rather than silent so that "the scheduler is alive" stays
      // answerable from the log alone -- a quiet night and a scheduler that
      // never started look identical otherwise.
      console.log(`nightly: ${hour}:00 in New York, not midnight; skipping`);
      return { result: { skipped: true, easternHour: hour } };
    }
    console.log("nightly: midnight in New York, starting scrape");
    const { result } = await runTask("scrape");
    return { result };
  },
});
