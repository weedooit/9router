import { isValidApiKey } from "@/sse/services/auth.js";
import { enforceKeyAccessResolved, extractClientApiKey, getKeyAccessContext } from "@/sse/services/keyAccess.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { findOcrModel, legacyModelId, listOcrProviders } from "@/lib/ocr/providers.js";
import { pageResponse, readLimited, upstreamRequest } from "@/lib/ocr/transport.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const maxBytes = 64 * 1024 * 1024;
const error = (message, status) => Response.json({ error: { message } }, { status });

async function authenticate(request) {
  const key = extractClientApiKey(request);
  return key && (await isValidApiKey(key)) ? key : null;
}

export async function GET(request) {
  if (!await authenticate(request)) return error("A valid API key is required", 401);
  const access = await getKeyAccessContext(request);
  const data = [];
  for (const provider of await listOcrProviders()) {
    for (const model of provider.models) {
      const id = provider.id + "/" + model.id;
      if (!await enforceKeyAccessResolved(access, id, provider.id, model.id)) {
        data.push({ id, object: "model", name: model.id, owned_by: provider.id });
      }
    }
  }
  return Response.json({ object: "list", data }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  const apiKey = await authenticate(request);
  if (!apiKey) return error("A valid API key is required", 401);
  const type = request.headers.get("content-type") || "";
  if (!/^multipart\/form-data\s*;/i.test(type)) return error("Send a multipart image in the file field", 400);
  let form;
  try {
    const bytes = await readLimited(request, maxBytes);
    form = await new Response(bytes, { headers: { "Content-Type": type } }).formData();
  } catch (cause) {
    if (cause instanceof RangeError) return error("Image exceeds the OCR server limit", 413);
    return error("Invalid multipart image", 400);
  }
  const file = form.get("file");
  if (!(file instanceof Blob) || !file.size) return error("Missing image in file field", 400);
  const header = request.headers.get("X-OCR-Model");
  const field = form.get("model");
  if ((field !== null && typeof field !== "string") || (header && field && header !== field)) {
    return error("Conflicting or invalid OCR model", 400);
  }
  const id = header || field || legacyModelId;
  const [providerId, modelId] = id.split("/");
  const denied = await enforceKeyAccessResolved(await getKeyAccessContext(request), id, providerId, modelId);
  if (denied) return denied;
  const target = await findOcrModel(id);
  if (!target) return error("Unknown or unconfigured OCR model", id === legacyModelId ? 503 : 404);
  const { provider, model } = target;

  let page;
  try {
    const response = await upstreamRequest(provider, model, file,
      AbortSignal.any([request.signal, AbortSignal.timeout(110000)]));
    if (!response.ok) {
      await response.body?.cancel();
      return error("OCR provider could not read the image", response.status >= 400 && response.status < 500 ? response.status : 502);
    }
    page = pageResponse(model, await readLimited(response, maxBytes));
  } catch {
    return error("OCR provider failed or returned an unexpected page format", 502);
  }
  await saveRequestUsage({ provider: provider.id, model: model.id, apiKey, endpoint: "/v1/ocr",
    tokens: page.tokens, meta: { ocr: { resultCount: page.resultCount } }, status: "ok" });
  return page.response;
}
