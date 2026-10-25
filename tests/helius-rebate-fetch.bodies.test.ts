import { expect, test } from "bun:test";
import { createRebateAwareFetch } from "../src/utils/helius-rebate-fetch";

const HELIUS = "https://mainnet.helius-rpc.com/?api-key=badge";

function spyFetch() {
  const urls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    urls.push(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    return { ok: true } as Response;
  }) as typeof fetch;
  return { fakeFetch, urls };
}

test("an unparseable request body is forwarded untouched", async () => {
  const { fakeFetch, urls } = spyFetch();
  const rebateFetch = createRebateAwareFetch(fakeFetch, "RebateAddr");

  await rebateFetch(HELIUS, { body: "this is {not json" });

  expect(urls).toEqual([HELIUS]);
});

test("a Request whose body was already consumed is forwarded without a rebate", async () => {
  const { fakeFetch, urls } = spyFetch();
  const rebateFetch = createRebateAwareFetch(fakeFetch, "RebateAddr");
  const request = new Request(HELIUS, {
    method: "POST",
    body: JSON.stringify({ method: "sendTransaction" }),
  });
  await request.text();

  await rebateFetch(request);

  // The body can no longer be inspected, so the method is unknown.
  expect(urls).toEqual([request.url]);
  expect(urls[0]).not.toContain("rebate-address");
});
