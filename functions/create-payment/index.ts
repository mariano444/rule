// Edge Function: create-payment
// Registra al jugador, crea un pago "pending" y un link de pago en Galiopay.
// Doc Galiopay: https://pay.galio.app/docs/api/paymentlink
// Desplegar con: supabase functions deploy create-payment --no-verify-jwt
//
// CONFIGURACIÓN: cada valor se lee primero de la variable de entorno (secrets) y,
// si no existe, de la tabla `settings` de la base de datos:
//   settings.galiopay_client_id   | GALIOPAY_CLIENT_ID    -> header x-client-id
//   settings.galiopay_api_key     | GALIOPAY_API_KEY      -> Authorization: Bearer
//   settings.webhook_token        | WEBHOOK_TOKEN         -> secreto en la URL del webhook
//   settings.return_url           | RETURN_URL            -> a dónde vuelve el jugador (tu sitio)
//   settings.galiopay_sandbox     | GALIOPAY_SANDBOX      -> "true" = links de prueba
//   ALLOWED_ORIGIN (env, opcional) -> dominio permitido para CORS

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type SB = any;

async function cfg(sb: SB, key: string, env: string): Promise<string | null> {
  const e = Deno.env.get(env);
  if (e) return e;
  const { data } = await sb.from("settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

class GalioError extends Error {
  constructor(public status: number, public detail: string) { super(`galiopay_http_${status}`); }
}

// Crea el link de pago por transferencia. Devuelve null si no hay credenciales.
async function createGaliopayLink(sb: SB, reference: string, price: number, origin: string | null) {
  const apiKey = await cfg(sb, "galiopay_api_key", "GALIOPAY_API_KEY");
  const clientId = await cfg(sb, "galiopay_client_id", "GALIOPAY_CLIENT_ID");
  if (!apiKey || !clientId) return null;

  const token = await cfg(sb, "webhook_token", "WEBHOOK_TOKEN");
  const base = `${Deno.env.get("SUPABASE_URL")}/functions/v1/payment-webhook`;
  const notificationUrl = token ? `${base}?k=${encodeURIComponent(token)}` : base;
  const ret = (await cfg(sb, "return_url", "RETURN_URL")) ?? origin;
  const sandbox = (await cfg(sb, "galiopay_sandbox", "GALIOPAY_SANDBOX")) === "true";

  const body: Record<string, unknown> = {
    items: [{ title: "Ficha de Mega Ruleta", quantity: 1, unitPrice: price, currencyId: "ARS" }],
    referenceId: reference,                // solo letras, números, _ y -
    notificationUrl,
    sandbox,
  };
  if (ret) body.backUrl = { success: `${ret}?pago=ok`, failure: `${ret}?pago=error` };

  const r = await fetch("https://pay.galio.app/api/payment-links", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "x-client-id": clientId },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error("galiopay create link:", r.status, text);
    throw new GalioError(r.status, text.slice(0, 300));
  }
  let d: { url?: string };
  try { d = JSON.parse(text); } catch { throw new GalioError(502, "respuesta no JSON"); }
  if (!d.url) throw new GalioError(502, "respuesta sin url");
  return { checkout_url: String(d.url) };                  // { url, proofToken, referenceId, sandbox }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "metodo_no_permitido" }, 405);

  try {
    const b = await req.json();
    const full_name = String(b.full_name ?? "").trim().slice(0, 80);
    const phone = String(b.phone ?? "").replace(/[^\d+]/g, "").slice(0, 20);

    if (
      full_name.length < 3 ||
      phone.replace(/\D/g, "").length < 8 ||
      b.adult !== true ||
      b.terms !== true
    ) return json({ error: "datos_invalidos" }, 400);

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    // Límite básico anti-abuso: máx. 5 pagos pendientes por teléfono en la última hora
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await sb
      .from("payments")
      .select("id, players!inner(phone)", { count: "exact", head: true })
      .eq("status", "pending")
      .gte("created_at", since)
      .eq("players.phone", phone);
    if ((count ?? 0) >= 5) return json({ error: "demasiados_intentos" }, 429);

    const { data: priceRow } = await sb.from("settings").select("value").eq("key", "spin_price").single();
    const price = Number(priceRow?.value ?? 10000);

    const now = new Date().toISOString();
    // Jugador existente (mismo teléfono y nombre) o nuevo. Sin email.
    let player: { id: string } | null = null;
    const { data: found } = await sb
      .from("players").select("id").eq("phone", phone).ilike("full_name", full_name).limit(1).maybeSingle();
    if (found) {
      player = found;
      await sb.from("players").update({ adult_confirmed_at: now, terms_accepted_at: now }).eq("id", found.id);
    } else {
      const { data: created, error: pErr } = await sb
        .from("players")
        .insert({ full_name, phone, adult_confirmed_at: now, terms_accepted_at: now })
        .select("id").single();
      if (pErr || !created) throw pErr ?? new Error("player");
      player = created;
    }

    const reference = crypto.randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase();
    const { error: payErr } = await sb.from("payments").insert({ reference, player_id: player.id, amount: price });
    if (payErr) throw payErr;

    try {
      const link = await createGaliopayLink(sb, reference, price, req.headers.get("origin"));
      if (link) {
        await sb.from("payments").update({ checkout_url: link.checkout_url }).eq("reference", reference);
        return json({ reference, price, checkout_url: link.checkout_url });
      }
    } catch (e) {
      await sb.from("payments").update({ status: "rejected" }).eq("reference", reference);
      if (e instanceof GalioError) return json({ error: "galiopay_error", status: e.status }, 502);
      throw e;
    }

    // Sin credenciales de Galiopay no se puede cobrar (el cobro es solo por Galiopay)
    await sb.from("payments").update({ status: "rejected" }).eq("reference", reference);
    return json({ error: "galiopay_no_configurado" }, 503);
  } catch (e) {
    console.error("create-payment:", e);
    return json({ error: "error_interno" }, 500);
  }
});
