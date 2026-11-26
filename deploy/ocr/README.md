# OCR recipe image

In **Providers → Add OCR Compatible**, enter a provider name, a unique ID such as `ocr-lab`, its HTTP(S) origin, and its authentication method (Bearer, X-API-Key or none). The **OCR Providers** section lists each saved provider on a scanner card. Click a card to edit its models. The dashboard masks saved provider keys. Add one or more models. For each model enter its own endpoint path and choose its request and response formats.

- **Multipart form** sends the image in your chosen field. Set an upstream model name to include the `model` field.
- **JSON template** supports nested objects and arrays. For example, `{"model":"{{model}}","page":{"image":"{{base64}}"}}`. Placeholders occupy a whole string value. Other variables are `{{dataUrl}}`, `{{mimeType}}` and `{{filename}}`.
- **Binary image** sends the file body and its media type.
- **OCR results JSON** returns the original UTF-8 JSON bytes, including whitespace and decimal precision. Each entry in `results` must have a string `text`.
- **Text from a JSON field** selects a string or an array of strings using a path such as `result.text` or `pages.0.lines`. **Plain text** reads the complete response. Both return a TaxHacker-compatible `results` array and preserve the upstream text in `raw`.

TaxHacker uses its application key with `GET /v1/ocr` to list permitted models and `POST /v1/ocr` to submit a multipart `file`. Select the model via the `model` field or `X-OCR-Model` (both must agree when supplied). For example, selecting `ocr-lab/reader` can call the provider's `/ocr2`. Successful pages appear in **Usage** under their provider and model, with zero LLM tokens.

An existing `OCRIA_API_URL` automatically supplies the editable default `ocria/ocria-nano-1`. Its configured URL and native response format work with existing clients. Once saved in Providers, the stored configuration takes precedence over the environment default.

The Dokploy GitHub connection watches `codex/9router-ocr` and publishes `ghcr.io/weedooit/9router-ocr:recette`. The build services on VPS1 share the existing disposable KVM worker and the remote buildx builder `weedoo-ocr-vps1`. Dokploy records the checked-out commit in Deployments. The build log identifies the published OCI index digest. Runtime deployments consume the resulting digest separately.

To build from a checkout on an isolated builder, run from the repository root:

```sh
OCR_IMAGE_TAG=$(git rev-parse HEAD) docker compose -f deploy/ocr/compose.yaml build --builder weedoo-ocr-vps1 --push image
```
