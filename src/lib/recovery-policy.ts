export const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_WINDOW_MS = 120_000;
export function planRecoveryAttempt(previous: number[], now: number) {
  const attempts = previous.filter((time) => time <= now && now - time < RECOVERY_WINDOW_MS);
  if (attempts.length >= MAX_RECOVERY_ATTEMPTS) return null;
  return { attempts, attempt: attempts.length + 1, delay: [1_000, 2_000, 5_000][attempts.length] };
}
