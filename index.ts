// Edge Function: create-payment
// Registra al jugador, crea un pago "pending" y devuelve cómo pagar.
//
// Variables de entorno (supabase secrets set ...):
//   GALIOPAY_API_KEY, GALIOPAY_CLIENT_ID  -> si ambas existen, se cobra con Galiopay (POST /api/payment-links)
//   GALIOPAY_SANDBOX    "true" para crear links de prueba (sandbox)
//   WEBHOOK_URL         (opcional) default: <SUPABASE_URL>/functions/v1/payment-webhook
//   RETURN_URL          URL a la que vuelve el jugador (tu sitio)
//   TRANSFER_ALIAS, TRANSFER_CBU, TRANSFER_HOLDER   -> modo manual (si no hay credenciales de Galiopay)
//   ALLOWED_ORIGIN      dominio de tu sitio (ej. https://miruleta.com.ar)
// Doc Galiopay: https://pay.galio.app/docs/api/paymentlink
// Desplegar con: supabase functions deploy create-payment --no-verify-jwt
// (las claves "sb_publishable_..." no son JWT; la función valida los datos por su cuenta)

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------------------------------------------------------------------
// GALIOPAY — crea un link de pago por transferencia.
// Auth: Authorization: Bearer <API_KEY> + x-client-id: <CLIENT_ID>
// El pago se confirma por webhook (ver payment-webhook).
// ---------------------------------------------------------------------
async function createGaliopayCheckout(reference: string, price: number) {
  const apiKey = Deno.env.get("GALIOPAY_API_KEY")!;
  const clientId = Deno.env.get("GALIOPAY_CLIENT_ID")!;
  const webhookUrl = Deno.env.get("WEBHOOK_URL") ?? `${Deno.env.get("SUPABASE_URL")}/functions/v1/payment-webhook`;
  const ret = Deno.env.get("RETURN_URL");

  const body: Record<string, unknown> = {
    items: [{ title: "Ficha de Mega Ruleta", quantity: 1, unitPrice: price, currencyId: "ARS" }],
    referenceId: reference,          // solo letras, números, _ y -
    notificationUrl: webhookUrl,
    sandbox: Deno.env.get("GALIOPAY_SANDBOX") === "true",
  };
  if (ret) body.backUrl = { success: `${ret}?pago=ok`, failure: `${ret}?pago=error` };

  const r = await fetch("https://pay.galio.app/api/payment-links", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "x-client-id": clientId },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.error("galiopay create link:", r.status, await r.text());
    throw new Error(`galiopay_http_${r.status}`);
  }
  const d = await r.json();               // { url, proofToken, referenceId, sandbox }
  if (!d.url) throw new Error("galiopay_sin_url");
  return { checkout_url: String(d.url) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "metodo_no_permitido" }, 405);

  try {
    const b = await req.json();
    const full_name = String(b.full_name ?? "").trim().slice(0, 80);
    const phone = String(b.phone ?? "").replace(/[^\d+]/g, "").slice(0, 20);
    const email = String(b.email ?? "").trim().toLowerCase().slice(0, 120);

    if (
      full_name.length < 3 ||
      phone.replace(/\D/g, "").length < 8 ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
      b.adult !== true ||
      b.terms !== true
    ) return json({ error: "datos_invalidos" }, 400);

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    // Límite básico anti-abuso: máx. 5 pagos pendientes por email en la última hora
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await sb
      .from("payments")
      .select("id, players!inner(email)", { count: "exact", head: true })
      .eq("status", "pending")
      .gte("created_at", since)
      .eq("players.email", email);
    if ((count ?? 0) >= 5) return json({ error: "demasiados_intentos" }, 429);

    const { data: priceRow } = await sb.from("settings").select("value").eq("key", "spin_price").single();
    const price = Number(priceRow?.value ?? 10000);

    const now = new Date().toISOString();
    const { data: player, error: pErr } = await sb
      .from("players")
      .upsert({ full_name, phone, email, adult_confirmed_at: now, terms_accepted_at: now }, { onConflict: "email" })
      .select("id")
      .single();
    if (pErr || !player) throw pErr ?? new Error("player");

    const reference = crypto.randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase();
    const { error: payErr } = await sb
      .from("payments")
      .insert({ reference, player_id: player.id, amount: price });
    if (payErr) throw payErr;

    const useGaliopay = !!Deno.env.get("GALIOPAY_API_KEY") && !!Deno.env.get("GALIOPAY_CLIENT_ID");
    if (useGaliopay) {
      const co = await createGaliopayCheckout(reference, price);
      await sb.from("payments").update({ checkout_url: co.checkout_url }).eq("reference", reference);
      return json({ reference, price, checkout_url: co.checkout_url });
    }

    return json({
      reference,
      price,
      transfer: {
        alias: Deno.env.get("TRANSFER_ALIAS") ?? "",
        cbu: Deno.env.get("TRANSFER_CBU") ?? "",
        holder: Deno.env.get("TRANSFER_HOLDER") ?? "",
      },
    });
  } catch (e) {
    console.error("create-payment:", e);
    return json({ error: "error_interno" }, 500);
  }
});
