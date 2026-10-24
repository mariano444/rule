// Edge Function: payment-webhook
// Recibe la notificación de Galiopay, valida la firma HMAC y acredita la ficha.
// Doc: https://pay.galio.app/docs/api/introduccion (sección Webhooks)
//
// Desplegar SIN verificación JWT (Galiopay no manda token de Supabase):
//   supabase functions deploy payment-webhook --no-verify-jwt
//
// Variables de entorno:
//   GALIOPAY_WEBHOOK_SECRET  secreto "webhook_secret" de tu cuenta Galiopay (OBLIGATORIO).
//                            Hay que activar la firma HMAC en el backoffice de Galiopay.
//   GALIOPAY_SANDBOX         "true" para aceptar pagos de prueba (sandbox). En producción NO definir.
//
// Firma: header  X-GalioPay-Signature: v1=<hex>
//        HMAC-SHA256( secret, X-GalioPay-Timestamp + "." + cuerpo_crudo )

import { createClient } from "npm:@supabase/supabase-js@2";

const TOLERANCE_SECONDS = 5 * 60;

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const secret = Deno.env.get("GALIOPAY_WEBHOOK_SECRET");
  if (!secret) {
    console.error("GALIOPAY_WEBHOOK_SECRET no configurado: se rechaza el webhook");
    return new Response("not configured", { status: 500 });
  }

  const raw = await req.text();                       // cuerpo crudo, sin re-serializar
  const ts = req.headers.get("x-galiopay-timestamp") ?? "";
  const sigHeader = (req.headers.get("x-galiopay-signature") ?? "").trim().toLowerCase();
  const received = sigHeader.replace(/^v1=/, "");

  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!ts || !Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    return new Response("stale or missing timestamp", { status: 401 });
  }
  const expected = await hmacHex(secret, `${ts}.${raw}`);
  if (!received || !safeEqual(received, expected)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let p: any;
  try { p = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  // Solo nos interesan los pagos aprobados (los reembolsos se gestionan a mano).
  if (p?.status !== "approved") {
    if (p?.status === "refunded") console.warn("Reembolso recibido, revisar a mano:", p?.referenceId);
    return new Response("ignored", { status: 200 });
  }
  if (p.sandbox === true && Deno.env.get("GALIOPAY_SANDBOX") !== "true") {
    console.warn("Pago sandbox ignorado en producción:", p.referenceId);
    return new Response("sandbox ignored", { status: 200 });
  }
  if (p.currency && p.currency !== "ARS") return new Response("currency ignored", { status: 200 });

  const reference = String(p.referenceId ?? "");
  const amount = Number(p.amount);
  if (!reference || !Number.isFinite(amount)) return new Response("missing fields", { status: 400 });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // Idempotente: si el evento llega repetido, devuelve la misma ficha sin duplicarla.
  const { error } = await sb.rpc("mark_payment_paid", {
    p_reference: reference,
    p_provider_id: p.id ? String(p.id) : null,
    p_amount: amount,
  });

  if (error) {
    console.error("mark_payment_paid:", error.message);
    if (/monto_incorrecto|pago_inexistente/.test(error.message)) return new Response("rejected", { status: 200 });
    return new Response("error", { status: 500 }); // Galiopay reintenta
  }
  return new Response("ok", { status: 200 });
});
