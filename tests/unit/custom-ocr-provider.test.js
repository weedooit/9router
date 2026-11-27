import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let admin, gateway, db, key, origin, server, directory, config;
const calls = [];
const raw = '{ "results" : [{"text":"TVA 7,010","confidence":0.990000000000000001}] }\n';
const jsonPage = '{ "result":{"lines":["TVA 7,010","Total 43,816"]},"usage":{"input_tokens":0,"output_tokens":12},"score":0.999999999999999999 }\n';
const pageBytes = Uint8Array.of(0, 170, 255, 12);
const adminRequest = body => new Request("http://gateway.test/api/provider-nodes/ocr", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

function request(model, token = key.key, header) {
  const body = new FormData();
  body.append("file", new Blob([pageBytes], { type: "image/png" }), "page.png");
  if (model) body.append("model", model);
  const headers = { Authorization: "Bearer " + token };
  if (header) headers["X-OCR-Model"] = header;
  return new Request("http://gateway.test/v1/ocr", { method: "POST", headers, body });
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "9router-custom-ocr-"));
  vi.stubEnv("DATA_DIR", directory);
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    const responses = { "/ocr": raw, "/ocr2": jsonPage, "/read": "Total 43,816\n", "/bad": "{}" };
    res.writeHead(Object.hasOwn(responses, req.url) ? 200 : 404);
    res.end(responses[req.url] || "");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  vi.stubEnv("OCRIA_API_URL", origin + "/ocr");
  admin = await import("@/app/api/provider-nodes/ocr/route.js");
  gateway = await import("@/app/api/v1/ocr/route.js");
  db = await import("@/lib/db/index.js");
  key = await db.createApiKey("TaxHacker fixture", "ocr-fixture");
  config = { id: "ocr-lab", name: "Invoice Lab", origin, auth: "x-api-key", apiKey: "upstream-fixture-key",
    models: [
      { id: "reader", endpoint: "/ocr2", requestFormat: "json", upstreamModel: "internal-v2",
        jsonTemplate: '{"name":"{{model}}","page":{"image":"{{base64}}","type":"{{mimeType}}"}}',
        responseFormat: "json-text", textPath: "result.lines" },
      { id: "printed", endpoint: "/read", requestFormat: "binary", responseFormat: "text" },
    ] };
  expect((await admin.POST(adminRequest(config))).status).toBe(201);
}, 30000);

afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  global._dbAdapter?.instance?.close();
  vi.unstubAllEnvs();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it("keeps the original OCRia ID, multipart upload and exact response bytes", async () => {
  const response = await gateway.POST(request(undefined));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(raw);
  const received = calls.at(-1);
  expect(received.url).toBe("/ocr");
  const form = await new Response(received.body, { headers: received.headers }).formData();
  expect(new Uint8Array(await form.get("file").arrayBuffer())).toEqual(pageBytes);
  expect(received.headers.authorization).toBeUndefined();
});

it("sends a nested JSON request to /ocr2 with the provider key and records real Usage", async () => {
  const id = "ocr-lab/reader";
  const response = await gateway.POST(request(id, key.key, id));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ results: [{ text: "TVA 7,010" }, { text: "Total 43,816" }], raw: jsonPage });
  const received = calls.at(-1);
  expect(received.url).toBe("/ocr2");
  expect(received.headers["x-api-key"]).toBe(config.apiKey);
  expect(received.headers.authorization).toBeUndefined();
  expect(JSON.parse(received.body)).toEqual({ name: "internal-v2", page: { image: Buffer.from(pageBytes).toString("base64"), type: "image/png" } });
  const { GET } = await import("@/app/api/usage/stats/route.js");
  for (const period of ["24h", "all"]) {
    const stats = await (await GET(new Request("http://gateway.test/api/usage/stats?period=" + period))).json();
    expect(stats.byProvider["ocr-lab"].requests).toBe(1);
    expect(Object.values(stats.byModel)).toContainEqual(expect.objectContaining({
      rawModel: "reader", provider: "Invoice Lab", requests: 1, promptTokens: 0, completionTokens: 12,
    }));
    expect(stats.recentRequests).toContainEqual(expect.objectContaining({ provider: "ocr-lab", model: "reader", promptTokens: 0, completionTokens: 12, ocr: { pages: 1, resultCount: 2 } }));
  }
  const live = await db.getActiveRequests();
  expect(live.recentRequests).toContainEqual(expect.objectContaining({ provider: "ocr-lab", model: "reader", promptTokens: 0, completionTokens: 12, ocr: { pages: 1, resultCount: 2 } }));
});

it("routes a second model of the same provider to its own binary/plain-text endpoint", async () => {
  const response = await gateway.POST(request("ocr-lab/printed"));
  expect(await response.json()).toEqual({ results: [{ text: "Total 43,816\n" }], raw: "Total 43,816\n" });
  expect(calls.at(-1).url).toBe("/read");
  expect(calls.at(-1).body).toEqual(Buffer.from(pageBytes));
});

it("lists only allowed models for restricted keys and denies other requests before dispatch", async () => {
  const restricted = await db.createApiKey("Restricted", "ocr-key2");
  await db.updateApiKey(restricted.id, { access: { restricted: true, allow: ["ocr-lab/reader"] } });
  const list = await (await gateway.GET(request(undefined, restricted.key))).json();
  expect(list.data.map(m => m.id)).toEqual(["ocr-lab/reader"]);
  const before = calls.length;
  expect((await gateway.POST(request("ocr-lab/printed", restricted.key))).status).toBe(403);
  expect((await gateway.POST(request("ocr-lab/reader", key.key, "ocr-lab/printed"))).status).toBe(400);
  expect((await gateway.POST(request("ocr-lab/missing"))).status).toBe(404);
  expect((await gateway.POST(request("ocr-lab/reader", "invalid"))).status).toBe(401);
  expect(calls).toHaveLength(before);
});

it("masks credentials, preserves a saved key on edit and refuses redirects to a new origin with that key", async () => {
  const providers = await (await admin.GET()).json();
  const saved = providers.providers.find(p => p.id === "ocr-lab");
  expect(saved.hasKey).toBe(true);
  expect(JSON.stringify(providers)).not.toContain(config.apiKey);
  expect((await admin.POST(adminRequest(config))).status).toBe(409);
  expect((await admin.PUT(adminRequest({ ...saved, origin: "https://example.invalid" }))).status).toBe(400);
  const badModel = { ...saved.models[0], endpoint: "//example.invalid/read" };
  expect((await admin.PUT(adminRequest({ ...saved, models: [badModel] }))).status).toBe(400);
  const updated = await admin.PUT(adminRequest({ ...saved, models: [...saved.models, { ...saved.models[0], id: "broken", endpoint: "/bad" }] }));
  expect(updated.status).toBe(200);
  expect((await gateway.POST(request("ocr-lab/broken"))).status).toBe(502);
  expect(calls.at(-1).headers["x-api-key"]).toBe(config.apiKey);
  expect((await db.getUsageHistory()).some(row => row.model === "broken")).toBe(false);
});

it("restores provider models and credentials from a database backup", async () => {
  const backup = await db.exportDb();
  expect(backup.ocrProviders.map(p => p.id)).toContain("ocr-lab");
  await db.importDb({ ...backup, ocrProviders: [] });
  expect((await gateway.POST(request("ocr-lab/reader"))).status).toBe(404);
  await db.importDb(backup);
  expect((await gateway.POST(request("ocr-lab/reader"))).status).toBe(200);
  expect(calls.at(-1).headers["x-api-key"]).toBe(config.apiKey);
});

it("counts simultaneous pages separately even if their usage timestamps match", async () => {
  const entry = { provider: "ocr-lab", model: "parallel", apiKey: key.key, endpoint: "/v1/ocr",
    timestamp: new Date().toISOString(), tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "ok" };
  await Promise.all([db.saveRequestUsage({ ...entry }), db.saveRequestUsage({ ...entry })]);
  expect((await db.getUsageHistory()).filter(row => row.model === "parallel")).toHaveLength(2);
});

it("keeps unmetered pages visible and distinguishes older placeholder zeros from reported zeros", async () => {
  const response = await gateway.POST(request("ocria/ocria-nano-1"));
  expect(await response.text()).toBe(raw);
  await db.saveRequestUsage({ provider: "ocr-old", model: "legacy", endpoint: "/v1/ocr",
    tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "ok" });
  for (const snapshot of [await db.getUsageStats("all"), await db.getActiveRequests()]) {
    expect(snapshot.recentRequests).toContainEqual(expect.objectContaining({
      provider: "ocria", promptTokens: null, completionTokens: null, ocr: { pages: 1, resultCount: 1 },
    }));
    expect(snapshot.recentRequests).toContainEqual(expect.objectContaining({
      provider: "ocr-old", promptTokens: null, completionTokens: null, ocr: { pages: 1, resultCount: null },
    }));
  }
});
