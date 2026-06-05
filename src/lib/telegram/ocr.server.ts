// OCR de comprobantes vía Lovable AI Gateway (Gemini Flash con visión).
// Best-effort: si falla, devuelve null y el comprobante sigue su flujo normal.
const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

export interface OcrResult {
  amount: number | null;
  reference: string | null;
  date: string | null;
  is_payment: boolean | null;
  recipient: string | null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export async function ocrReceipt(bytes: ArrayBuffer, mime = "image/jpeg"): Promise<OcrResult | null> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return null;
  try {
    const b64 = Buffer.from(bytes).toString("base64");
    const dataUrl = `data:${mime};base64,${b64}`;
    const res = await fetch(GATEWAY, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "Extraés datos de comprobantes de pago. Respondé SOLO con JSON con campos: amount (número, sin símbolos), reference (string del número de referencia/operación), date (YYYY-MM-DD si es posible). Usá null si no encontrás algo.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extraé monto, referencia y fecha." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      console.error("[ocr] gateway", res.status, await res.text().catch(() => ""));
      return null;
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const txt = j?.choices?.[0]?.message?.content;
    if (!txt) return null;
    let parsed: { amount?: unknown; reference?: unknown; date?: unknown };
    try {
      parsed = JSON.parse(txt);
    } catch {
      return null;
    }
    return {
      amount: toNumber(parsed.amount),
      reference: parsed.reference ? String(parsed.reference).slice(0, 60) : null,
      date: parsed.date ? String(parsed.date).slice(0, 30) : null,
    };
  } catch (e) {
    console.error("[ocr] err", e);
    return null;
  }
}

/** Devuelve un resumen ya formateado para insertar en el caption del admin. */
export function formatOcrSummary(ocr: OcrResult | null, expectedUsd: number, expectedLocal?: number | null): string {
  if (!ocr) return `\n\n<b>OCR</b>  ·  no se pudo leer`;
  const a = ocr.amount;
  let badge = "❓";
  if (a !== null) {
    const tolUsd = 2;
    const tolLocal = expectedLocal ? Math.max(2, expectedLocal * 0.03) : 0;
    if (Math.abs(a - expectedUsd) <= tolUsd) badge = "✅";
    else if (expectedLocal && Math.abs(a - expectedLocal) <= tolLocal) badge = "✅";
    else badge = "⚠️";
  }
  return (
    `\n\n<b>OCR</b>  ${badge}\n` +
    `Monto    ${a ?? "—"}\n` +
    `Ref      ${ocr.reference ?? "—"}\n` +
    `Fecha    ${ocr.date ?? "—"}`
  );
}
