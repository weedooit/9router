# OCR recipe image

POST /v1/ocr accepts an image in the multipart file field. Set OCRIA_API_URL to the private OCRia endpoint in the runtime environment. The route enforces the existing 9Router application-key model permissions for ocria/ocria-nano-1 and records one successful page in Usage. The response contains the original OCRia result object.

The Dokploy GitHub connection watches `codex/9router-ocr` and publishes `ghcr.io/weedooit/9router-ocr:recette`. The build services on VPS1 share the existing disposable KVM worker and the remote buildx builder `weedoo-ocr-vps1`. Dokploy records the checked-out commit in Deployments. The build log identifies the published OCI index digest. Runtime deployments consume the resulting digest separately.

To build from a checkout on an isolated builder, run from the repository root:

```sh
OCR_IMAGE_TAG=$(git rev-parse HEAD) docker compose -f deploy/ocr/compose.yaml build --builder weedoo-ocr-vps1 --push image
```
