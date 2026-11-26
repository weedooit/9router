import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/sse/services/auth.js", () => ({ isValidApiKey: vi.fn() }));
vi.mock("@/sse/services/keyAccess.js", () => ({
  extractClientApiKey: request => request.headers.get("Authorization")?.slice(7),
  getKeyAccessContext: vi.fn(),
  enforceKeyAccessResolved: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));

import { POST } from "../../src/app/api/v1/ocr/route.js";
import { isValidApiKey } from "@/sse/services/auth.js";
import { enforceKeyAccessResolved } from "@/sse/services/keyAccess.js";
import { saveRequestUsage } from "@/lib/usageDb.js";

function page(key) {
  const body = new FormData();
  body.append("file", new Blob(["fixture"]), "page.png");
  return new Request("http://gateway.invalid/v1/ocr", {
    method: "POST", body, headers: key ? { Authorization: "Bearer " + key } : {},
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("OCRIA_API_URL", "http://ocria.invalid/ocr");
  vi.stubGlobal("fetch", vi.fn());
  isValidApiKey.mockResolvedValue(true);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("returns the upstream JSON bytes and records one completed page", async () => {
  const original = '{ "results": [ {"text":"7,010","confidence":0.990000000000000001} ] }\n';
  fetch.mockResolvedValue(new Response(original));
  const response = await POST(page("test-key"));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(original);
  expect(fetch.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  expect(saveRequestUsage).toHaveBeenCalledTimes(1);
  expect(saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
    provider: "ocria", model: "ocria-nano-1", endpoint: "/v1/ocr", apiKey: "test-key",
  }));
});

it("enforces the application key and model permissions before forwarding", async () => {
  expect((await POST(page())).status).toBe(401);
  enforceKeyAccessResolved.mockResolvedValue(new Response(null, { status: 403 }));
  expect((await POST(page("test-key"))).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  expect(saveRequestUsage).not.toHaveBeenCalled();
});

it("does not count a failed or malformed upstream response", async () => {
  fetch.mockResolvedValueOnce(new Response(null, { status: 500 })).mockResolvedValueOnce(new Response("{}"));
  expect((await POST(page("test-key"))).status).toBe(502);
  expect((await POST(page("test-key"))).status).toBe(502);
  expect(saveRequestUsage).not.toHaveBeenCalled();
});
