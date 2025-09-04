/**
 * Simple service health checker using HEAD requests with timeout.
 * Allows injecting a custom fetch implementation for testing.
 */
export async function checkServiceHealth(
  url: string,
  timeout = 5000,
  fetchImpl: (input: string | URL, init?: any) => Promise<{ ok: boolean }>
    = (fetch as any)
): Promise<boolean> {
  try {
    const hasAbort = typeof (globalThis as any).AbortController !== "undefined";
    const controller = hasAbort ? new (globalThis as any).AbortController() : undefined;
    const timeoutId = setTimeout(() => controller?.abort?.(), timeout);

    const response = await fetchImpl(url, { method: "HEAD", signal: controller?.signal });

    clearTimeout(timeoutId);
    return !!(response && (response as any).ok);
  } catch {
    return false;
  }
}
