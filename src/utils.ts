export const NOOP = () => {};
export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns the current time formatted to match Panda EV charger firmware behavior:
 * sends Vientiane local time (UTC+7) with a `Z` suffix, which is a known firmware bug
 * on deployed PANDA-EV chargers.
 *
 * The CSMS `parseChargerTimestamp()` is designed to handle this pattern — it strips the
 * `Z`, appends `+07:00`, and re-interprets the bare datetime as Vientiane local time.
 *
 * Using `new Date().toISOString()` (proper UTC+Z) in the VCP would cause `parseChargerTimestamp`
 * to subtract 7 h from the stored timestamp, resulting in a start/stop time that is 7 h behind.
 *
 * Example: at 02:17 VTE (= 19:17 UTC), this returns "2026-05-24T02:17:26.826Z" (VTE local + Z),
 * which CSMS correctly stores as 2026-05-23T19:17:26Z UTC → displays as 02:17 VTE.
 */
export const vcpTimestamp = (): string => {
  const VTE_OFFSET_MS = 7 * 60 * 60 * 1000;
  return new Date(Date.now() + VTE_OFFSET_MS).toISOString();
};
