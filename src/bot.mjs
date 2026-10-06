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

let modeloOk = "";

async function analisarProduto(o) {
  const key = env("GEMINI_API_KEY");
  if (!key) return { frase: "", erro: "GEMINI_API_KEY não configurada" };

  const dados = [
    `Produto: ${o.productName}`,
    `Desconto: ${Math.round(Number(o.priceDiscountRate || 0))}%`,
    `Nota: ${o.ratingStar ? Number(o.ratingStar).toFixed(1) : "sem nota"}`,
    `Vendas: ${o.sales ?? 0}`,
    `Loja: ${o.shopName ?? ""}`,
  ].join("\n");

  const modelos = [
    modeloOk,
    env("AI_MODEL"),
    "gemini-flash-lite-latest",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
  ].filter((m, i, a) => m && a.indexOf(m) === i);

  let ultimoErro = "";
  for (const modelo of modelos) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: PROMPT_IA }] },
            contents: [{ role: "user", parts: [{ text: dados }] }],
            generationConfig: { maxOutputTokens: 400, temperature: 0.8 },
          }),
          signal: AbortSignal.timeout(6000),
        }
      );
      if (res.status === 404 || res.status === 400) {
        const corpo = (await res.text()).replace(/\s+/g, " ").slice(0, 120);
        ultimoErro = `${modelo}: HTTP ${res.status} ${corpo}`;
        continue; // tenta o próximo modelo
      }
      if (!res.ok) throw new Error(`${modelo}: HTTP ${res.status}`);
      const data = await res.json();
      const texto = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("")
        .trim()
        .replace(/^["“]+|["”]+$/g, "");
      modeloOk = modelo;
      if (/^PULAR/i.test(texto)) return { pular: true };
      return { frase: texto.slice(0, 160) };
    } catch (e) {
      console.error("IA falhou:", e.message);
      return { frase: "", erro: e.message };
    }
  }
  return { frase: "", erro: `nenhum modelo funcionou (${ultimoErro})` };
}

// ---------------- Telegram ----------------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const brl = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function legenda(o, link, frase) {
  const desc = Math.round(Number(o.priceDiscountRate || 0));
  const min =
