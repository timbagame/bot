import type { FetchLike } from "../types";

/**
 * Simple service health checker using HEAD requests with timeout.
 * Allows injecting a custom fetch implementation for testing.
 */
export async function checkServiceHealth(
  url: string,
  timeout = 5000,
  fetchImpl: FetchLike = fetch as any,
): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetchImpl(url, { method: "HEAD", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
