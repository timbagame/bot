/**
 * Format a duration in seconds to a compact string.
 * Examples: 10s, 45m, 1h 20m, 3d
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return "0s";

  // Round to nearest integer for seconds
  const totalSeconds = Math.round(seconds);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);

  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;

  if (totalHours < 24) {
    if (remainingMinutes > 0) {
      return `${totalHours}h ${remainingMinutes}m`;
    }
    return `${totalHours}h`;
  }

  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d`;
}
