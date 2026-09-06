import { defineTask, runTask } from "nitropack/runtime";

// Midnight Eastern, without moving the process off UTC.
//
// Nitro schedules with croner and gives it nothing but the expression --
// `new Cron(expr, handler)` in nitropack/dist/runtime/internal/task.mjs -- so
// there is no timezone to pass and croner reads local time. The obvious fix,
// setting TZ=America/New_York on the vendord process, is the wrong one here:
// every timestamp column in this schema is `timestamp without time zone`, and
// node-postgres serializes a Date using the process's local offset, so vendord
// would start writing timestamps four or five hours off from what the app
// writes and reads. Nothing would error; the data would just quietly disagree.
//
// So the schedule fires twice, at 04:00 and 05:00 UTC -- midnight Eastern under
// EDT and under EST respectively -- and this task drops whichever of the two is
// not actually midnight there. That tracks the DST transitions on its own,
// because Intl does.
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
    description: "Run the scrape at midnight Eastern, whatever UTC offset",
  },
  async run() {
    const hour = easternHour(new Date());
    if (hour !== 0) {
      // The other half of the pair. Not an error, and not worth a log line
      // every night, but say something so a silent night is distinguishable
      // from a scheduler that never fired.
      console.log(`Skipping nightly scrape: ${hour}:00 in New York, not 00:00`);
      return { result: { skipped: true, easternHour: hour } };
    }
    const { result } = await runTask("scrape");
    return { result };
  },
});
