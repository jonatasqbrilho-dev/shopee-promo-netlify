import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const env = (k, d = "") => process.env[k] ?? d;
const SENT_TTL_MS = 7 * 86400 * 1000;
const ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql";

// ---------------- Shopee ----------------
async function shopee(query) {
  const appId = env("SHOPEE_APP_ID");
  const secret = env("SHOPEE_SECRET");
  const payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = createHash("sha256").update(`${appId}${ts}${payload}${secret}`).digest("hex");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${signature}`,
    },
    body: payload,
  });
  if (!res.ok) throw new Error(`Shopee HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Shopee: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function buscarOfertas(keyword, page = 1, limit = 50) {
  const kw = keyword ? `keyword: ${JSON.stringify(keyword)},` : "";
  const sort = Number(env("SORT_TYPE", "2"));
  const data = await shopee(`{
    productOfferV2(${kw} sortType: ${sort}, page: ${page}, limit: ${limit}) {
      nodes { itemId productName imageUrl priceMin priceMax priceDiscountRate
              ratingStar sales shopName offerLink productLink }
    }
  }`);
  return data.productOfferV2.nodes;
}

async function linkCurto(url) {
  try {
    const subId = env("SUB_ID", "telegram");
    const data = await shopee(`mutation {
      generateShortLink(input: { originUrl: ${JSON.stringify(url)}, subIds: [${JSON.stringify(subId)}] }) { shortLink }
    }`);
    return data.generateShortLink.shortLink;
  } catch {
    return url;
  }
}

// ---------------- Telegram ----------------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const brl = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function legenda(o, link) {
  const desc = Math.round(Number(o.priceDiscountRate || 0));
  const min = Number(o.priceMin), max = Number(o.priceMax);
  const preco = min === max ? brl(min) : `${brl(min)} a ${brl(max)}`;
  const linhas = [`🔥 <b>${esc(o.productName).slice(0, 120)}</b>`, ""];
  if (desc) linhas.push(`💥 <b>${desc}% OFF</b>`);
  linhas.push(`💰 Por apenas <b>${preco}</b>`);
  if (o.ratingStar) linhas.push(`⭐ ${Number(o.ratingStar).toFixed(1)}  |  🛒 ${o.sales ?? 0} vendidos`);
  linhas.push("", `🛍️ <a href="${link}">COMPRAR AGORA</a>`, "", "⚠️ <i>Preço sujeito a alteração a qualquer momento.</i>");
  return linhas.join("\n");
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env("TELEGRAM_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env("TELEGRAM_CHAT_ID"), parse_mode: "HTML", ...body }),
  });
  if (!res.ok) throw new Error(`Telegram ${method} ${res.status}: ${await res.text()}`);
}

async function enviar(o, link) {
  const text = legenda(o, link);
  try {
    await tg("sendPhoto", { photo: o.imageUrl, caption: text });
  } catch {
    await tg("sendMessage", { text });
  }
}

// ---------------- Principal ----------------
function horaFortaleza() {
  const h = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/Fortaleza" })
    .format(new Date());
  return Number(h) % 24;
}

export async function runBot({ force = false } = {}) {
  const inicio = Number(env("START_HOUR", "8"));
  const fim = Number(env("END_HOUR", "22"));
  const h = horaFortaleza();
  if (!force && (h < inicio || h >= fim)) return { skipped: `fora do horário (${h}h)` };

  const store = getStore("shopee-bot");
  let sent = (await store.get("sent", { type: "json" })) ?? {};
  const limite = Date.now() - SENT_TTL_MS;
  sent = Object.fromEntries(Object.entries(sent).filter(([, t]) => t > limite));

  const keywords = env("KEYWORDS").split(",").map((k) => k.trim()).filter(Boolean);
  const kw = keywords.length ? keywords[Math.floor(Math.random() * keywords.length)] : "";
  const minDesc = Number(env("MIN_DISCOUNT", "20"));
  const qtd = Number(env("POSTS_PER_CYCLE", "3"));

  const ofertas = await buscarOfertas(kw, 1 + Math.floor(Math.random() * 3));
  const candidatas = ofertas
    .filter((o) => !sent[o.itemId] && Number(o.priceDiscountRate || 0) >= minDesc && o.imageUrl)
    .sort(() => Math.random() - 0.5)
    .slice(0, qtd);

  const links = await Promise.all(candidatas.map((o) => linkCurto(o.offerLink || o.productLink)));
  const enviados = [];
  const erros = [];
  for (let i = 0; i < candidatas.length; i++) {
    try {
      await enviar(candidatas[i], links[i]);
      sent[candidatas[i].itemId] = Date.now();
      enviados.push(candidatas[i].productName.slice(0, 60));
      await new Promise((r) => setTimeout(r, 1000));
    } catch (e) {
      console.error("falha ao enviar", candidatas[i].itemId, e.message);
      erros.push(`${candidatas[i].itemId}: ${e.message}`);
    }
  }
  await store.setJSON("sent", sent);
  return { keyword: kw || "geral", encontradas: ofertas.length, candidatas: candidatas.length, enviados, erros };
}
