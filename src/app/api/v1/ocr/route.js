import { isValidApiKey } from "@/sse/services/auth.js";
import { enforceKeyAccessResolved, extractClientApiKey, getKeyAccessContext } from "@/sse/services/keyAccess.js";
import { saveRequestUsage } from "@/lib/usageDb.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const provider = "ocria";
const model = "ocria-nano-1";
const id = `${provider}/${model}`;
const maxBytes = 64 * 1024 * 1024;

function error(message, status) {
  return Response.json({ error: { message } }, { status });
}

async function checkAccess(request) {
  const key = extractClientApiKey(request);
  if (!key || !(await isValidApiKey(key))) return error("A valid API key is required", 401);
  const access = await getKeyAccessContext(request);
  return enforceKeyAccessResolved(access, id, provider, model);
}

export async function GET(request) {
  const denied = await checkAccess(request);
  if (denied) return denied;
  const data = process.env.OCRIA_API_URL
    ? [{ id, object: "model", name: "OCRia-nano-1", owned_by: provider }]
    : [];
  return Response.json({ object: "list", data }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  const denied = await checkAccess(request);
  if (denied) return denied;
  const requestedModel = request.headers.get("X-OCR-Model");
  if (requestedModel && requestedModel !== id) return error("Unknown OCR model", 404);
  const upstream = process.env.OCRIA_API_URL;
  if (!upstream) return error("OCRia is not configured", 503);

  const type = request.headers.get("content-type") || "";
  if (!/^multipart\/form-data\s*;/i.test(type) || !request.body) {
    return error("Send a multipart image in the file field", 400);
  }
  if (Number(request.headers.get("content-length")) > maxBytes) {
    return error("Image exceeds the OCR server limit", 413);
  }

  let rawPage;
  try {
    const response = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": type },
      body: request.body,
      duplex: "half",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(110000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return error("OCRia could not read the image", response.status < 500 ? response.status : 502);
    }
    rawPage = await response.arrayBuffer();
    const page = JSON.parse(new TextDecoder().decode(rawPage));
    if (!Array.isArray(page?.results)) return error("Unexpected OCRia response", 502);
  } catch {
    return error("OCRia could not complete the page", 502);
  }

  // OCRia processes pages without LLM tokens. Record one completed page in gateway Usage.
  await saveRequestUsage({
    provider, model, apiKey: extractClientApiKey(request), endpoint: "/v1/ocr",
    tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "ok",
  });
  return new Response(rawPage, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
