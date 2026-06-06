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
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3_500);
  try {
    const b64 = Buffer.from(bytes).toString("base64");
    const dataUrl = `data:${mime};base64,${b64}`;
    const res = await fetch(GATEWAY, {
      method: "POST",
      signal: ac.signal,
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
              "Analizás imágenes para detectar comprobantes de pago/transferencias bancarias. Respondé SOLO con JSON con campos: is_payment (boolean, true si la imagen es claramente un comprobante de transferencia, depósito o pago electrónico), amount (número, sin símbolos), reference (string del número de referencia/operación), date (YYYY-MM-DD si es posible), recipient (string con el nombre o cuenta del destinatario del pago si se ve). Usá null si no encontrás algo. Si la imagen NO es un comprobante de pago (foto cualquiera, captura no relacionada, meme, etc) poné is_payment=false.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Analizá la imagen y extraé los datos." },
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
    let parsed: { amount?: unknown; reference?: unknown; date?: unknown; is_payment?: unknown; recipient?: unknown };
    try {
      parsed = JSON.parse(txt);
    } catch {
      return null;
    }
    return {
      amount: toNumber(parsed.amount),
      reference: parsed.reference ? String(parsed.reference).slice(0, 60) : null,
      date: parsed.date ? String(parsed.date).slice(0, 30) : null,
      is_payment: typeof parsed.is_payment === "boolean" ? parsed.is_payment : null,
      recipient: parsed.recipient ? String(parsed.recipient).slice(0, 80) : null,
    };
  } catch (e) {
    console.error("[ocr] err", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Devuelve un resumen ya formateado para insertar en el caption del admin. */
export function formatOcrSummary(ocr: OcrResult | null, expectedUsd: number, expectedLocal?: number | null): string {
  if (!ocr) return `\n\n<b>OCR</b>  ·  no se pudo leer`;
  const a = ocr.amount;
  let badge = "❓";
  if (ocr.is_payment === false) badge = "⛔";
  else if (a !== null) {
    const tolUsd = 2;
    const tolLocal = expectedLocal ? Math.max(2, expectedLocal * 0.03) : 0;
    if (Math.abs(a - expectedUsd) <= tolUsd) badge = "✅";
    else if (expectedLocal && Math.abs(a - expectedLocal) <= tolLocal) badge = "✅";
    else badge = "⚠️";
  }
  return (
    `\n\n<b>OCR</b>  ${badge}\n` +
    `Pago     ${ocr.is_payment === false ? "NO parece pago" : ocr.is_payment === true ? "sí" : "—"}\n` +
    `Monto    ${a ?? "—"}\n` +
    `Ref      ${ocr.reference ?? "—"}\n` +
    `Destino  ${ocr.recipient ?? "—"}\n` +
    `Fecha    ${ocr.date ?? "—"}`
  );
}
