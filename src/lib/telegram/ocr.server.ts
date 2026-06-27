// OCR de comprobantes vía Lovable AI Gateway (Gemini Flash con visión).
// Best-effort: si falla, devuelve null y el comprobante sigue su flujo normal.
// CRÍTICO: Estos timeouts NO deben exceder el webhook timeout de Telegram (1.5s ACK).
// Se ejecuta de forma NO-BLOCKING en background para no congelar el bot.
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

async function ocrOnce(
  key: string,
  dataUrl: string,
  timeoutMs: number,
): Promise<OcrResult | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
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
              "Sos un verificador de comprobantes de pago bancario / billetera digital (Nequi, Daviplata, Bancolombia, Zelle, PayPal, transferencias, depósitos, etc). Respondé SOLO con JSON con los campos: is_payment (boolean), amount (número sin símbolos), reference (string del número de operación/referencia), date (YYYY-MM-DD si es posible), recipient (nombre del destinatario o número de cuenta visible). Reglas para is_payment: marcá true si la imagen muestra señales claras de un movimiento de dinero exitoso: monto + fecha/hora + (referencia/comprobante/operación/transacción) o un banner de 'Transferencia exitosa', 'Pago realizado', 'Comprobante de pago', etc. No exijas que TODOS los datos estén presentes — si dudás pero hay monto + fecha o monto + referencia, marcá true. Si es un screenshot de cuenta, extracto o balance sin movimiento de dinero claro, marcá false. Si es una factura o recibo de compra/servicio sin dinero entrante/saliente, false.",
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
      const body = await res.text().catch(() => "");
      console.error("[ocr] gateway", res.status, body.slice(0, 100));
      // 429/5xx → reintentar
      if (res.status === 429 || res.status >= 500) throw new Error(`retry:${res.status}`);
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
    // Log de error pero no lanzar: best-effort
    if (e instanceof Error) {
      console.error("[ocr] ocrOnce error:", e.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OCR agresivo: 3 intentos con timeouts muy cortos (3s, 5s, 8s).
 * Máximo 16 segundos totales. Si falla todo, devuelve null.
 * NUNCA bloquea el Event Loop más de lo necesario.
 * Ejecutada en BACKGROUND: el bot responde inmediatamente al usuario.
 */
export async function ocrReceipt(bytes: ArrayBuffer, mime = "image/jpeg"): Promise<OcrResult | null> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) {
    console.error("[ocr] missing LOVABLE_API_KEY");
    return null;
  }
  const b64 = Buffer.from(bytes).toString("base64");
  const dataUrl = `data:${mime};base64,${b64}`;

  // Timeouts AGRESIVOS: 3s → 5s → 8s = 16s máximo total (+ 500ms entre intentos = ~17s máx)
  // MUCHO más rápido que los 75s anteriores que bloqueaba TODO.
  const timeouts = [3_000, 5_000, 8_000];
  let lastErr: unknown = null;
  
  for (let i = 0; i < timeouts.length; i++) {
    try {
      console.log(`[ocr] attempt ${i + 1}/${timeouts.length} with ${timeouts[i]}ms timeout`);
      const result = await ocrOnce(key, dataUrl, timeouts[i]);
      if (result) {
        console.log(`[ocr] success on attempt ${i + 1}`);
        return result;
      }
      // Null significa error recoverable, intentar de nuevo
      console.log(`[ocr] attempt ${i + 1} returned null, retrying...`);
    } catch (e) {
      lastErr = e;
      console.error(`[ocr] attempt ${i + 1} caught exception`, e instanceof Error ? e.message : String(e));
      // Si es retry-able (429/5xx), esperar antes de reintentar
      if (i < timeouts.length - 1) {
        const delayMs = 200 * (i + 1);
        console.log(`[ocr] waiting ${delayMs}ms before retry...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  
  console.error("[ocr] all 3 attempts exhausted, returning null");
  return null;
}

/**
 * Formatea el resumen OCR para el caption del admin.
 * Si OCR falló o no se ejecutó, etiqueta con <i>OCR: sin lectura</i>.
 */
export function formatOcrSummary(ocr: OcrResult | null, expectedUsd: number, expectedLocal?: number | null): string {
  if (!ocr) return `\n<i>OCR: sin lectura</i>`;
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
  const parts = [`${badge} OCR`];
  if (a !== null) parts.push(`${a}`);
  if (ocr.reference) parts.push(`ref ${ocr.reference}`);
  if (ocr.date) parts.push(`${ocr.date}`);
  return `\n<i>${parts.join(" · ")}</i>`;
}
