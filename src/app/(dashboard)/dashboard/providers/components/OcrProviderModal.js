"use client";

import { useId, useState } from "react";
import { Button, Input, Modal, Select } from "@/shared/components";
import { newOcrModel } from "@/shared/ocrFormats.js";

const options = entries => entries.map(([value, label]) => ({ value, label }));
const authOptions = options([["bearer", "Bearer token"], ["x-api-key", "X-API-Key"], ["none", "No authentication"]]);
const requestOptions = options([["multipart", "Multipart form"], ["json", "JSON template"], ["binary", "Binary image"]]);
const responseOptions = options([["results", "OCR results JSON (pass through)"], ["json-text", "Text from a JSON field"], ["text", "Plain text"]]);

function ModelFields({ model, onChange, onRemove, fixedId }) {
  const base = useId();
  const field = key => ({ id: base + key, value: model[key] ?? "",
    onChange: event => onChange({ ...model, [key]: event.target.value }) });
  return (
    <fieldset className="grid gap-3 rounded-xl border border-border p-4">
      <legend className="px-1 text-sm font-semibold">{model.id || "New model"}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Model ID" {...field("id")} disabled={fixedId} placeholder="invoice-reader" required />
        <Input label="Endpoint path" {...field("endpoint")} placeholder="/ocr2" required />
        <Select label="Request format" aria-label="Request format" {...field("requestFormat")} options={requestOptions} />
        <Select label="Response format" aria-label="Response format" {...field("responseFormat")} options={responseOptions} />
        {model.requestFormat === "multipart" && <Input label="Image field" {...field("fileField")} required />}
        {model.requestFormat !== "binary" && <Input label="Upstream model (optional)" {...field("upstreamModel")} />}
      </div>
      {model.requestFormat === "json" && (
        <div className="grid gap-1">
          <label htmlFor={base + "jsonTemplate"} className="text-sm font-medium">JSON request template</label>
          <textarea {...field("jsonTemplate")} required rows={5} className="rounded-lg bg-surface-2 p-3 font-mono text-sm" />
          <p className="text-xs text-text-muted">Use a placeholder as a complete string value. Available values are
            {" {{base64}}, {{dataUrl}}, {{model}}, {{mimeType}} and {{filename}}."}</p>
        </div>
      )}
      {model.responseFormat === "json-text" && <Input label="Response text path" {...field("textPath")}
        placeholder="result.text" hint="Use dots for nested fields and array indices, for example pages.0.text." required />}
      {onRemove && <Button type="button" size="sm" variant="ghost" className="justify-self-end" onClick={onRemove}>Remove model</Button>}
    </fieldset>
  );
}

export default function OcrProviderModal({ existing, onClose, onSaved }) {
  const [provider, setProvider] = useState(() => existing ? {
    ...existing, models: existing.models.map(model => ({ ...newOcrModel(), ...model })),
  } : {
    id: "ocr-", name: "", origin: "", auth: "bearer", models: [newOcrModel()],
  });
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const field = name => ({ id: "ocr-provider-" + name, value: provider[name],
    onChange: event => setProvider({ ...provider, [name]: event.target.value }) });
  const setModels = models => setProvider({ ...provider, models });
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/provider-nodes/ocr", {
        method: existing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...provider, ...(key ? { apiKey: key } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save provider.");
      onSaved(result.provider);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal isOpen onClose={onClose} title={existing ? "Edit OCR provider" : "Add OCR Compatible"} size="xl">
      <form className="grid gap-4" onSubmit={save}>
        <Input label="Provider name" {...field("name")} required />
        <Input label="Provider ID" {...field("id")} disabled={Boolean(existing)} hint="Use a unique prefix such as ocr-lab." required />
        <Input label="Server origin" type="url" {...field("origin")} placeholder="https://ocr.example.com" required />
        <Select label="Authentication" aria-label="Authentication" {...field("auth")} options={authOptions} />
        {provider.auth !== "none" && <Input id="ocr-provider-key" label="Provider API key" type="password" autoComplete="new-password"
          value={key} onChange={event => setKey(event.target.value)} required={!existing?.hasKey || provider.origin !== existing.origin}
          placeholder={existing?.hasKey ? "Leave blank to keep the saved key" : ""} />}
        {provider.models.map((model, index) => {
          const fixed = provider.id === "ocria" && model.id === "ocria-nano-1";
          return <ModelFields key={index} model={model} fixedId={fixed}
            onChange={next => setModels(provider.models.map((m, i) => i === index ? next : m))}
            onRemove={!fixed && provider.models.length > 1 ? () => setModels(provider.models.filter((_, i) => i !== index)) : null} />;
        })}
        <Button type="button" variant="outline" icon="add" onClick={() => setModels([...provider.models, newOcrModel()])}>Add model</Button>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Save provider</Button>
        </div>
      </form>
    </Modal>
  );
}
