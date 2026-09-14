/**
 * Pacing utility to manage request rates and delays.
 */

/**
 * Basic sleep function that returns a promise which resolves after ms milliseconds.
 * @param ms milliseconds to sleep
 */
export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Returns a random delay between min and max milliseconds.
 * Useful for jittering requests to avoid looking like a bot.
 * @param min minimum milliseconds
 * @param max maximum milliseconds
 */
export const randomDelay = (min: number, max: number): Promise<void> => {
  const ms = Math.floor(Math.random() * (max - min + 1) + min);
  return sleep(ms);
};

/**
 * Pace a loop with a fixed or jittered delay.
 * Default jitter is 20% of the delay.
 * @param delayMs base delay in milliseconds
 * @param jitter factor (0 to 1) for randomization
 */
export const pace = async (
  delayMs: number = 500,
  jitter: number = 0.2,
): Promise<void> => {
  const min = delayMs * (1 - jitter);
  const max = delayMs * (1 + jitter);
  await randomDelay(min, max);
};
