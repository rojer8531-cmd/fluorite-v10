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
 * OCR robusto: 3 intentos con timeouts realistas (12s, 20s, 30s).
 * Gemini Vision suele tardar 5-15s; timeouts cortos hacían que abortara
 * antes de responder. Como se ejecuta en background (webhook ya ACK-eado
 * a los 1.5s), ampliar timeouts NO congela el bot.
 *
 * Garantías:
 *  - NUNCA lanza excepción (siempre devuelve OcrResult | null).
 *  - Cap total duro de 70s vía Promise.race — no puede quedar pendiente.
 *  - Si todo falla, devuelve null y el comprobante sigue al admin con
 *    etiqueta "OCR: sin lectura" (lo maneja formatOcrSummary).
 */
export async function ocrReceipt(bytes: ArrayBuffer, mime = "image/jpeg"): Promise<OcrResult | null> {
  try {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) {
      console.error("[ocr] missing LOVABLE_API_KEY");
      return null;
    }
    const b64 = Buffer.from(bytes).toString("base64");
    const dataUrl = `data:${mime};base64,${b64}`;

    const run = async (): Promise<OcrResult | null> => {
      const timeouts = [12_000, 20_000, 30_000];
      for (let i = 0; i < timeouts.length; i++) {
        try {
          console.log(`[ocr] attempt ${i + 1}/${timeouts.length} timeout=${timeouts[i]}ms`);
          const result = await ocrOnce(key, dataUrl, timeouts[i]);
          if (result) {
            console.log(`[ocr] success on attempt ${i + 1}`);
            return result;
          }
          console.log(`[ocr] attempt ${i + 1} null, retrying...`);
        } catch (e) {
          console.error(
            `[ocr] attempt ${i + 1} exception`,
            e instanceof Error ? e.message : String(e),
          );
        }
        if (i < timeouts.length - 1) {
          // Backoff exponencial suave: 500ms, 1200ms
          const delayMs = 500 * Math.pow(2, i);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      return null;
    };

    // Cap total duro: aunque los timeouts individuales sumen más, jamás
    // dejamos la promesa colgada más de 70s.
    const hardCap = new Promise<null>((resolve) => setTimeout(() => {
      console.error("[ocr] hard cap 70s reached, giving up");
      resolve(null);
    }, 70_000));

    return await Promise.race([run(), hardCap]);
  } catch (e) {
    // Última red de seguridad: jamás propagar.
    console.error("[ocr] unexpected top-level error", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Formatea el resumen OCR para el caption del admin.
 * Si OCR falló o no se ejecutó, etiqueta con <i>OCR: sin lectura</i>.
 */
export function formatOcrSummary(ocr: OcrResult | null, expectedUsd: number, expectedLocal?: number | null): string {
  if (!ocr) return `\n\n🤖 <b>Análisis IA:</b> <i>sin lectura (revisá la imagen manualmente)</i>`;
  const a = ocr.amount;
  let badge = "❓";
  let verdict = "revisión manual";
  if (ocr.is_payment === false) {
    badge = "⛔";
    verdict = "NO parece un comprobante de pago";
  } else if (a !== null) {
    const tolUsd = 2;
    const tolLocal = expectedLocal ? Math.max(2, expectedLocal * 0.03) : 0;
    if (Math.abs(a - expectedUsd) <= tolUsd) { badge = "✅"; verdict = "monto coincide (USD)"; }
    else if (expectedLocal && Math.abs(a - expectedLocal) <= tolLocal) { badge = "✅"; verdict = "monto coincide (moneda local)"; }
    else { badge = "⚠️"; verdict = "monto NO coincide con lo esperado"; }
  } else {
    verdict = "no se pudo leer el monto";
  }
  const lines: string[] = [`\n\n🤖 <b>Análisis IA</b> ${badge} <i>${verdict}</i>`];
  if (a !== null) lines.push(`• Monto detectado: <b>${a}</b>`);
  if (ocr.reference) lines.push(`• Referencia: <code>${ocr.reference}</code>`);
  if (ocr.date) lines.push(`• Fecha: ${ocr.date}`);
  if (ocr.recipient) lines.push(`• Destinatario: ${ocr.recipient}`);
  if (ocr.is_payment === true && a === null) lines.push(`• Detectado como comprobante, pero sin monto legible`);
  return lines.join("\n");
}
