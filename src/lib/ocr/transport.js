// The client always sends a page to /v1/ocr. Only this adapter knows the provider's wire format.
export async function readLimited(message, limit) {
  if (Number(message.headers.get("content-length")) > limit) throw new RangeError("Body too large");
  const reader = message.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new RangeError("Body too large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    reader.releaseLock();
  }
}

export async function upstreamRequest(provider, model, file, signal) {
  const headers = {};
  if (provider.auth === "bearer") headers.Authorization = "Bearer " + provider.apiKey;
  if (provider.auth === "x-api-key") headers["X-API-Key"] = provider.apiKey;
  let body;
  if (model.requestFormat === "multipart") {
    const form = new FormData();
    form.append(model.fileField, file, file.name);
    if (model.upstreamModel) form.append("model", model.upstreamModel);
    // The gateway transport uses a different undici version than Node’s FormData.
    const encoded = new Response(form);
    headers["Content-Type"] = encoded.headers.get("content-type");
    body = await encoded.arrayBuffer();
  } else if (model.requestFormat === "binary") {
    headers["Content-Type"] = file.type || "application/octet-stream";
    body = file;
  } else {
    const b64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const mime = file.type || "application/octet-stream";
    const values = { "{{base64}}": b64, "{{dataUrl}}": "data:" + mime + ";base64," + b64,
      "{{model}}": model.upstreamModel || model.id, "{{mimeType}}": mime, "{{filename}}": file.name };
    const payload = JSON.parse(model.jsonTemplate, (key, value) =>
      typeof value === "string" && Object.hasOwn(values, value) ? values[value] : value);
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }
  return fetch(new URL(model.endpoint, provider.origin), { method: "POST", headers, body, signal, strictTls: true, redirect: "error" });
}

export function pageResponse(model, raw) {
  const source = raw.toString("utf8");
  const json = model.responseFormat === "text" ? null : JSON.parse(source);
  let resultCount;
  let payload;
  if (model.responseFormat === "results") {
    const page = json;
    if (!Array.isArray(page?.results) || !page.results.every(row => typeof row?.text === "string")) {
      throw new Error("Missing OCR results");
    }
    resultCount = page.results.length;
    payload = raw;
  } else {
    let text = source;
    if (model.responseFormat === "json-text") {
      text = json;
      for (const key of model.textPath.split(".")) {
        if (text == null || !Object.hasOwn(text, key)) throw new Error("Missing OCR text");
        text = text[key];
      }
    }
    const lines = Array.isArray(text) ? text : [text];
    if (!lines.every(line => typeof line === "string")) throw new Error("Invalid OCR text");
    resultCount = lines.length;
    payload = JSON.stringify({ results: lines.map(line => ({ text: line })), raw: source });
  }
  const tokens = {};
  const usage = json?.usage;
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  const output = usage?.completion_tokens ?? usage?.output_tokens;
  if (Number.isSafeInteger(input) && input >= 0) tokens.prompt_tokens = input;
  if (Number.isSafeInteger(output) && output >= 0) tokens.completion_tokens = output;
  const response = new Response(payload, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  return { response, resultCount, tokens };
}
