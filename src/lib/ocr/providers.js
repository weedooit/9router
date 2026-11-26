import { getAdapter } from "@/lib/db/driver.js";
import { newOcrModel } from "@/shared/ocrFormats.js";

export const legacyModelId = "ocria/ocria-nano-1";
const scope = "ocrProviders";
const slug = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const own = (object, key) => Object.hasOwn(object, key);

export class OcrConfigError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function requireValue(condition, message) {
  if (!condition) throw new OcrConfigError(message);
}

function readOrigin(value) {
  let url;
  try { url = new URL(value); } catch {}
  requireValue(url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
    url.pathname === "/" && !url.search && !url.hash, "Enter an HTTP(S) server origin. Set the path on each model.");
  return url.origin;
}

function readModel(input, origin) {
  requireValue(input && typeof input.id === "string" && slug.test(input.id), "Enter a valid model ID.");
  const { id, endpoint, requestFormat, responseFormat } = input;
  requireValue(typeof endpoint === "string" && /^\/(?!\/)/.test(endpoint) && !/[\\#\s]/.test(endpoint) &&
    new URL(endpoint, origin).origin === origin, "Each endpoint must be a path on the provider server.");
  requireValue(["multipart", "json", "binary"].includes(requestFormat), "Choose a supported request format.");
  requireValue(["results", "json-text", "text"].includes(responseFormat), "Choose a supported response format.");
  const model = { id, endpoint, requestFormat, responseFormat };
  if (requestFormat !== "binary") {
    requireValue(typeof (input.upstreamModel ?? "") === "string", "Invalid upstream model.");
    model.upstreamModel = (input.upstreamModel || "").trim();
  }
  if (requestFormat === "multipart") {
    requireValue(typeof input.fileField === "string" && /^[\w.-]+$/.test(input.fileField) &&
      !(model.upstreamModel && input.fileField === "model"), "Enter a distinct image field name.");
    model.fileField = input.fileField;
  }
  if (requestFormat === "json") {
    let template;
    let hasImage = false;
    if (typeof input.jsonTemplate === "string" && input.jsonTemplate.length <= 16384) {
      try {
        template = JSON.parse(input.jsonTemplate, (key, value) => {
          if (value === "{{base64}}" || value === "{{dataUrl}}") hasImage = true;
          return value;
        });
      } catch {}
    }
    requireValue(template && typeof template === "object" && hasImage,
      "The JSON template must include {{base64}} or {{dataUrl}} as a string value.");
    model.jsonTemplate = input.jsonTemplate;
  }
  if (responseFormat === "json-text") {
    requireValue(typeof input.textPath === "string" && /^[\w-]+(?:\.[\w-]+)*$/.test(input.textPath),
      "Enter a dotted path to a string or an array of strings.");
    model.textPath = input.textPath;
  }
  return model;
}

function legacyProvider() {
  const endpoint = process.env.OCRIA_API_URL;
  if (!endpoint || !URL.canParse(endpoint)) return null;
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) return null;
  return { id: "ocria", name: "OCRia", origin: url.origin, auth: "none", apiKey: "",
    models: [{ ...newOcrModel(), id: "ocria-nano-1", endpoint: url.pathname + url.search,
      upstreamModel: legacyModelId }] };
}

export function publicProvider({ apiKey, ...provider }) {
  return { ...provider, hasKey: Boolean(apiKey) };
}

function fromDb(db, id) {
  const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [scope, id]);
  return row ? JSON.parse(row.value) : id === "ocria" ? legacyProvider() : null;
}

export async function listOcrProviders() {
  const db = await getAdapter();
  const providers = db.all("SELECT value FROM kv WHERE scope = ? ORDER BY key", [scope])
    .map(row => JSON.parse(row.value));
  if (!providers.some(p => p.id === "ocria")) {
    const legacy = legacyProvider();
    if (legacy) providers.unshift(legacy);
  }
  return providers.map(publicProvider);
}

export async function findOcrModel(qualifiedId) {
  const parts = qualifiedId.split("/");
  if (parts.length !== 2) return null;
  const provider = fromDb(await getAdapter(), parts[0]);
  const model = provider?.models.find(item => item.id === parts[1]);
  return model ? { provider, model } : null;
}

export async function saveOcrProvider(input, create) {
  const db = await getAdapter();
  return db.transaction(() => writeOcrProvider(db, input, create));
}

export function writeOcrProvider(db, input, create) {
  requireValue(input && typeof input.id === "string" &&
    (input.id === "ocria" || (input.id.startsWith("ocr-") && slug.test(input.id.slice(4)))),
    "Choose a provider ID starting with ocr-.");
  const old = fromDb(db, input.id);
  if (create && old) throw new OcrConfigError("Provider ID already exists.", 409);
  if (create === false && !old) throw new OcrConfigError("Unknown provider.", 404);
  requireValue(typeof input.name === "string" && input.name.trim().length > 0, "Enter a provider name.");
  const origin = readOrigin(input.origin);
  const auth = input.auth;
  requireValue(["none", "bearer", "x-api-key"].includes(auth), "Choose an authentication method.");
  const suppliedKey = own(input, "apiKey");
  let apiKey = "";
  if (auth !== "none") {
    requireValue(suppliedKey || old?.origin === origin, "Enter a new key for this server.");
    apiKey = suppliedKey ? input.apiKey : old?.apiKey;
    requireValue(typeof apiKey === "string" && apiKey.trim() && !/[^\x21-\x7e]/.test(apiKey), "Enter a valid provider key.");
  }
  requireValue(Array.isArray(input.models) && input.models.length > 0, "Add at least one model.");
  const models = input.models.map(model => readModel(model, origin));
  requireValue(new Set(models.map(m => m.id)).size === models.length, "Model IDs must be unique within the provider.");
  if (input.id === "ocria") requireValue(models.some(m => m.id === "ocria-nano-1"), "Keep the OCRia Nano model ID.");
  const provider = { id: input.id, name: input.name.trim(), origin, auth, apiKey, models };
  db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
    [scope, provider.id, JSON.stringify(provider)]);
  return publicProvider(provider);
}
