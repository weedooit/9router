import { listOcrProviders, OcrConfigError, saveOcrProvider } from "@/lib/ocr/providers.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ providers: await listOcrProviders() }, { headers: { "Cache-Control": "no-store" } });
}

async function save(request, create) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Send a JSON provider configuration." }, { status: 415 });
  }
  let input;
  try { input = await request.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  try {
    return Response.json({ provider: await saveOcrProvider(input, create) }, { status: create ? 201 : 200 });
  } catch (error) {
    if (!(error instanceof OcrConfigError)) throw error;
    return Response.json({ error: error.message }, { status: error.status });
  }
}

export const POST = request => save(request, true);
export const PUT = request => save(request, false);
