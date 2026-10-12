import {
  BATCH_DAY,
  BATCH_CUTOFF_DAY,
  WAT_OFFSET_HOURS,
  VOLUME_BASE_YEAR,
} from "./ijsds2.constants.js";

// All journal-calendar math is done in WAT (UTC+1) explicitly, so it is identical on a
// UTC server, a Lagos laptop and a London browser.

const WAT_MS = WAT_OFFSET_HOURS * 3600 * 1000;

/** 28th 00:00 WAT of (year, month 1-12) as a UTC instant. */
export const releaseInstant = (year, month) =>
  new Date(Date.UTC(year, month - 1, BATCH_DAY, 0, 0, 0) - WAT_MS);

/** 27th 23:59:59.999 WAT of (year, month 1-12) as a UTC instant. */
export const cutoffInstant = (year, month) =>
  new Date(Date.UTC(year, month - 1, BATCH_CUTOFF_DAY, 23, 59, 59, 999) - WAT_MS);

export const getCycle = (now = new Date()) => {
  const wat = new Date(now.getTime() + WAT_MS); // read UTC fields of this as WAT wall-clock
  let year = wat.getUTCFullYear();
  let month = wat.getUTCMonth() + 1;

  // Once this month's release instant has passed, the next batch is next month's.
  if (now >= releaseInstant(year, month)) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  const release = releaseInstant(year, month);
  return {
    targetYear: year,
    targetMonth: month,
    cutoffAt: cutoffInstant(year, month),
    releaseAt: release,
    isCutoffPassed: now > cutoffInstant(year, month),
    daysUntilRelease: Math.max(0, Math.ceil((release - now) / 86400000)),
  };
};

export const volumeIssueFor = (year, month) => ({
  volume: Math.max(1, year - VOLUME_BASE_YEAR),
  issue: month,
});

/**
 * The cycle a batch run should publish. On/after the 28th (WAT) it is the current month
 * (the scheduled run fires at exactly 00:00 WAT, when getCycle() has already rolled to
 * next month); before the 28th it is the upcoming release (manual/early run).
 */
export const getBatchTarget = (now = new Date()) => {
  const wat = new Date(now.getTime() + WAT_MS);
  if (wat.getUTCDate() >= BATCH_DAY) return { year: wat.getUTCFullYear(), month: wat.getUTCMonth() + 1 };
  const c = getCycle(now);
  return { year: c.targetYear, month: c.targetMonth };
};
