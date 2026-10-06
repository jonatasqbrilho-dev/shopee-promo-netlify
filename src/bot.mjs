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

// ---------------- IA (Gemini, plano gratuito) ----------------
const PROMPT_IA = `Você é redator de um grupo de promoções no Telegram (Brasil). Receberá os dados de um produto da Shopee e deve escrever UMA frase de efeito curta (até 90 caracteres), em português do Brasil, destacando um benefício real do produto ou incentivando a compra com base nos dados fornecidos (desconto, número de vendas, nota).

Regras:
- Use apenas informações dos dados recebidos. NUNCA invente estoque ("últimas unidades"), prazo ("só hoje", "termina hoje"), cupom, garantia ou características que o nome do produto não traga.
- Urgência só com base em dados reais, por exemplo: "Mais de 5 mil já compraram!" ou "40% de desconto para aproveitar".
- No máximo 1 emoji. Sem aspas, sem hashtags, sem preço.
- Tom animado e natural, sem exagero.
- Se o produto for impróprio para o grupo (conteúdo adulto, armas, remédios ou suplementos com promessa de saúde, produto falsificado ou réplica de marca), responda apenas: PULAR

Responda somente com a frase (ou PULAR).`;

async function analisarProduto(o) {
  const key = env("GEMINI_API_KEY");
  if (!key) return { frase: "" };
  try {
    const dados = [
      `Produto: ${o.productName}`,
      `Desconto: ${Math.round(Number(o.priceDiscountRate || 0))}%`,
      `Nota: ${o.ratingStar ? Number(o.ratingStar).toFixed(1) : "sem nota"}`,
      `Vendas: ${o.sales ?? 0}`,
      `Loja: ${o.shopName ?? ""}`,
    ].join("\n");
    const modelo = env("AI_MODEL", "gemini-2.5-flash-lite");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: PROMPT_IA }] },
          contents: [{ role: "user", parts: [{ text: dados }] }],
          generationConfig: {
            maxOutputTokens: 200,
            temperature: 0.8,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) throw new Error(`IA HTTP ${res.status}`);
    const data = await res.json();
    const texto = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? "")
      .trim()
      .replace(/^["“]+|["”]+$/g, "");
    if (/^PULAR/i.test(texto)) return { pular: true };
    return { frase: texto.slice(0, 160) };
  } catch (e) {
    console.error("IA falhou:", e.message);
    return { frase: "", erro: e.message };
  }
}

// ---------------- Telegram ----------------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const brl = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function legenda(o, link, frase) {
  const desc = Math.round(Number(o.priceDiscountRate || 0));
  const min = Number(o.priceMin), max = Number(o.priceMax);
  const preco = min === max ? brl(min) : `${brl(min)} a ${brl(max)}`;
  const linhas = [`🔥 <b>${esc(o.productName).slice(0, 120)}</b>`];
  if (frase) linhas.push(`<i>${esc(frase)}</i>`);
  linhas.push("");
  if (desc) linhas.push(`💥 <b>${desc}% OFF</b>`);
  linhas.push(`💰 Por apenas <b>${preco}</b>`);
  if (o.ratingStar) linhas.push(`⭐ ${Number(o.ratingStar).toFixed(1)}  |  🛒 ${o.sales ?? 0} vendidos`);
  linhas.push("", `🛍️ <a href="${link}">COMPRAR AGORA</a>`);
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

async function enviar(o, link, frase) {
  const text = legenda(o, link, frase);
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

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // pega 2 a mais para compensar produtos que a IA recusar
  const pool = ofertas
    .filter((o) => !sent[o.itemId] && Number(o.priceDiscountRate || 0) >= minDesc && o.imageUrl)
    .sort(() => Math.random() - 0.5)
    .slice(0, qtd + 2);

  // uma chamada por vez (respeita o limite do plano gratuito)
  const analises = [];
  let iaErro = "";
  for (const o of pool) {
    if (iaErro) { analises.push({ frase: "" }); continue; }
    const r = await analisarProduto(o);
    if (r.erro) iaErro = r.erro;
    analises.push(r);
    await pausa(500);
  }

  const pulados = [];
  const aprovadas = [];
  pool.forEach((o, i) => {
    if (analises[i].pular) {
      pulados.push(o.productName.slice(0, 50));
      sent[o.itemId] = Date.now(); // não reavaliar
    } else {
      aprovadas.push({ o, frase: analises[i].frase });
    }
  });
  const selecionadas = aprovadas.slice(0, qtd);

  const links = await Promise.all(selecionadas.map(({ o }) => linkCurto(o.offerLink || o.productLink)));
  const enviados = [];
  const erros = [];
  for (let i = 0; i < selecionadas.length; i++) {
    const { o, frase } = selecionadas[i];
    try {
      await enviar(o, links[i], frase);
      sent[o.itemId] = Date.now();
      enviados.push(o.productName.slice(0, 60));
      await pausa(1000);
    } catch (e) {
      console.error("falha ao enviar", o.itemId, e.message);
      erros.push(`${o.itemId}: ${e.message}`);
    }
  }
  await store.setJSON("sent", sent);
  return {
    keyword: kw || "geral",
    encontradas: ofertas.length,
    candidatas: selecionadas.length,
    enviados,
    pulados,
    iaErro: iaErro || undefined,
    erros,
  };
}
