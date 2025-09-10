/**
 * Simple service health checker using HEAD requests with timeout.
 * Allows injecting a custom fetch implementation for testing.
 */
export async function checkServiceHealth(
  url: string,
  timeout = 5000,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch as any
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetchImpl(url, { method: "HEAD", signal: controller.signal });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}
