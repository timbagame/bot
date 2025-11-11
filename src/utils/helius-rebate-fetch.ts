const HELIUS_HOSTNAME_PATTERN = /(^|\.)helius-rpc\.com$/i;
const BODY_DECODER = new TextDecoder();

const REQUEST_INIT_KEYS = [
  "body",
  "cache",
  "credentials",
  "headers",
  "integrity",
  "keepalive",
  "method",
  "mode",
  "priority",
  "redirect",
  "referrer",
  "referrerPolicy",
  "signal",
  "window",
  "duplex",
] as const;

type FetchInit = RequestInit | BunFetchRequestInit;

function isHeliusHostname(hostname: string): boolean {
  return HELIUS_HOSTNAME_PATTERN.test(hostname);
}

function normalizeBody(body: unknown): string | undefined {
  if (typeof body === "string") {
    return body;
  }

  if (body instanceof Uint8Array) {
    return BODY_DECODER.decode(body);
  }

  if (body instanceof ArrayBuffer) {
    return BODY_DECODER.decode(new Uint8Array(body));
  }

  return undefined;
}

function extractRpcMethod(body: unknown): string | undefined {
  const normalized = normalizeBody(body);
  if (!normalized) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && typeof parsed.method === "string") {
      return parsed.method;
    }
  } catch {
    // Ignore invalid JSON
  }

  return undefined;
}

export function createRebateAwareFetch(
  baseFetch: typeof fetch,
  rebateAddress?: string,
): typeof fetch {
  const normalizedRebate = rebateAddress?.trim();
  if (!normalizedRebate) {
    return baseFetch;
  }

  const rebateFetch = (async (
    input: string | URL | Request,
    init?: RequestInit | BunFetchRequestInit,
  ) => {
    let rpcMethod = extractRpcMethod(init?.body);
    if (!rpcMethod && input instanceof Request) {
      try {
        rpcMethod = extractRpcMethod(await input.clone().text());
      } catch {
        // Ignore body parsing failures; the request may be streaming-only.
      }
    }
    let requestInput: RequestInfo = input instanceof URL ? input.toString() : input;
    let requestInit: FetchInit | undefined = init;
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (rpcMethod === "sendTransaction" && rawUrl) {
      const url = new URL(rawUrl);
      if (isHeliusHostname(url.hostname)) {
        url.searchParams.set("rebate-address", normalizedRebate);
        if (input instanceof Request) {
          requestInput = cloneRequestWithUpdatedUrl(input, url, init);
          requestInit = undefined;
        } else {
          requestInput = url.toString();
        }
      }
    }

    return baseFetch(requestInput, requestInit);
  }) as typeof fetch;

  rebateFetch.preconnect = baseFetch.preconnect;
  return rebateFetch;
}

function cloneRequestWithUpdatedUrl(
  request: Request,
  url: URL,
  overrideInit?: FetchInit,
): Request {
  const mergedInit: Record<string, unknown> = {
    method: request.method,
    headers: new Headers(request.headers),
    body: request.body,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  };

  const requestAsAny = request as unknown as Record<string, unknown>;
  for (const key of [
    "cache",
    "credentials",
    "integrity",
    "keepalive",
    "mode",
    "priority",
    "window",
  ]) {
    const value = requestAsAny[key];
    if (value !== undefined) {
      mergedInit[key] = value;
    }
  }

  if (overrideInit) {
    const overrideAsAny = overrideInit as Record<string, unknown>;
    for (const key of REQUEST_INIT_KEYS) {
      if (key in overrideAsAny) {
        mergedInit[key] = overrideAsAny[key];
      }
    }
  }

  return new Request(url.toString(), mergedInit as RequestInit);
}
