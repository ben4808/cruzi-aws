const HOUR_MS = 60 * 60 * 1000;

export const RUN_DURATION_MS = 2 * HOUR_MS;
export const PAUSE_DURATION_MS = 1 * HOUR_MS;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getRunPhaseDeadline(): number {
  return Date.now() + RUN_DURATION_MS;
}

export function isRunPhaseActive(deadline: number): boolean {
  return Date.now() < deadline;
}

export async function pauseBetweenRunPhases(label: string): Promise<void> {
  console.log(`${label}: run phase complete; pausing for 1 hour...`);
  await sleep(PAUSE_DURATION_MS);
  console.log(`${label}: pause complete; resuming run phase...`);
}
