import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const env = (key, fallback = "") => process.env[key] ?? fallback;

const SHOPEE_ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql";
const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 2 * 60 * 1000;
const STORE_NAME = "shopee-promo";
const FALLBACK_TEXT = "🔥 Oferta encontrada na Shopee!";

/* =========================================================
   UTILITÁRIOS
========================================================= */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const number = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const integer = (value, fallback = 0) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const moneyBRL = (value) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(number(value));

// A API da Shopee devolve priceMin/priceMax já com o preço atual.
const priceOf = (product) =>
  number(product?.priceMin) || number(product?.priceMax) || 0;

const discountOf = (product) => {
  const direct = number(product?.priceDiscountRate);
  if (direct > 0) {
    return direct;
  }
  return 0;
};

const productUrl = (product) =>
  product?.productLink ||
  product?.productUrl ||
  product?.offerLink ||
  product?.link ||
  "";

const keywords = () =>
  env(
    "SHOPEE_KEYWORDS",
    "eletronicos,casa,cozinha,ferramentas,celular,beleza,ofertas"
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const brasilHour = () => {
  const now = new Date();
  return Number(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Fortaleza",
      hour: "2-digit",
      hour12: false,
    }).format(now)
  );
};

const withinSchedule = () => {
  const start = integer(env("BOT_START_HOUR", "8"), 8);
  const end = integer(env("BOT_END_HOUR", "22"), 22);
  const hour = brasilHour();

  if (start === end) {
    return true;
  }
  if (start < end) {
    return hour >= start && hour < end;
  }
  return hour >= start || hour < end;
};

/* =========================================================
   NETLIFY BLOBS
========================================================= */

const store = () =>
  getStore({
    name: STORE_NAME,
    consistency: "strong",
  });

async function getJSON(key, fallback = null) {
  try {
    const value = await store().get(key, { type: "json" });
    return value ?? fallback;
  } catch (error) {
    console.error("Erro ao ler Blob:", error);
    return fallback;
  }
}

async function setJSON(key, value) {
  await store().setJSON(key, value);
}

async function acquireLock() {
  const key = "bot-lock";
  const current = await getJSON(key);
  const now = Date.now();

  if (current && number(current.expiresAt) > now) {
    return false;
  }

  await setJSON(key, {
    lockedAt: now,
    expiresAt: now + LOCK_TTL_MS,
  });

  return true;
}

async function releaseLock() {
  try {
    await setJSON("bot-lock", { lockedAt: 0, expiresAt: 0 });
  } catch (error) {
    console.error("Erro ao liberar lock:", error);
  }
}

async function wasSent(itemId) {
  if (!itemId) {
    return false;
  }

  const data = await getJSON(`sent:${itemId}`);
  if (!data) {
    return false;
  }

  const sentAt = number(data.sentAt);
  if (!sentAt) {
    return false;
  }

  return Date.now() - sentAt <= SENT_TTL_MS;
}

async function markSent(itemId) {
  if (!itemId) {
    return;
  }
  await setJSON(`sent:${itemId}`, { sentAt: Date.now() });
}

/* =========================================================
   SHOPEE API
========================================================= */

function shopeeCredentials() {
  const appId = env("SHOPEE_APP_ID") || env("SHOPEE_APPID");
  const secret = env("SHOPEE_APP_SECRET") || env("SHOPEE_SECRET");

  if (!appId || !secret) {
    throw new Error("SHOPEE_APP_ID ou SHOPEE_APP_SECRET não configurado.");
  }

  return { appId: String(appId), secret: String(secret) };
}

async function shopeeRequest(query) {
  const { appId, secret } = shopeeCredentials();
  const payload = JSON.stringify({ query });
  const timestamp = Math.floor(Date.now() / 1000);

  const signature = createHash("sha256")
    .update(appId + timestamp + payload + secret)
    .digest("hex");

  const response = await fetch(SHOPEE_ENDPOINT, {
    signal: AbortSignal.timeout(8000),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        `SHA256 Credential=${appId}, ` +
        `Timestamp=${timestamp}, ` +
        `Signature=${signature}`,
    },
    body: payload,
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Shopee retornou resposta inválida: ${text.slice(0, 500)}`
    );
  }

  if (!response.ok) {
    throw new Error(`Shopee HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  if (data?.errors?.length) {
    throw new Error(`Shopee GraphQL: ${JSON.stringify(data.errors)}`);
  }

  return data;
}

/* =========================================================
   BUSCAR OFERTAS
========================================================= */

async function searchOffers(keyword) {
  const safeKeyword = String(keyword)
    .replaceAll("\\", "")
    .replaceAll('"', '\\"');

  const sortType = integer(env("SHOPEE_SORT_TYPE", "2"), 2);
  const page = integer(env("SHOPEE_PAGE", "1"), 1);
  const limit = Math.min(
    Math.max(integer(env("SHOPEE_LIMIT", "20"), 20), 1),
    50
  );

  const query = `
    {
      productOfferV2(
        keyword: "${safeKeyword}"
        sortType: ${sortType}
        page: ${page}
        limit: ${limit}
      ) {
        nodes {
          itemId
          productName
          productLink
          offerLink
          imageUrl
          priceMin
          priceMax
          priceDiscountRate
          ratingStar
          sales
          shopName
          commissionRate
          commission
        }
      }
    }
  `;

  const data = await shopeeRequest(query);
  return data?.data?.productOfferV2?.nodes || [];
}

/* =========================================================
   SHORT LINK
========================================================= */

async function generateShortLink(originUrl) {
  if (!originUrl) {
    return "";
  }

  try {
    const safeUrl = String(originUrl)
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');

    const query = `
      mutation {
        generateShortLink(
          input: {
            originUrl: "${safeUrl}"
          }
        ) {
          shortLink
        }
      }
    `;

    const data = await shopeeRequest(query);
    return data?.data?.generateShortLink?.shortLink || originUrl;
  } catch (error) {
    console.error("Erro ao gerar short link:", error);
    return originUrl;
  }
}

/* =========================================================
   GEMINI
========================================================= */

async function generatePromoText(product) {
  const apiKey = env("GEMINI_API_KEY");

  if (!apiKey) {
    console.error("GEMINI_API_KEY não configurada.");
    return FALLBACK_TEXT;
  }

  const model = env("GEMINI_MODEL", "gemini-3.5-flash-lite");
  const discount = Math.round(discountOf(product));
  const productName = String(product?.productName || "").slice(0, 300);
  const price = moneyBRL(priceOf(product));

  const prompt = `
Crie uma chamada curta e chamativa em português do Brasil para uma oferta da Shopee.

Produto: ${productName}
Preço: ${price}
Desconto: ${discount}%

Regras:
- máximo de 90 caracteres;
- não invente informações;
- não diga "últimas unidades", "frete grátis" ou "menor preço";
- pode usar 1 ou 2 emojis;
- seja natural e vendedor;
- não coloque link nem hashtags;
- responda somente com a frase, sem aspas.

Se o produto for perigoso, ilegal, adulto ou inadequado para divulgação, responda apenas: PULAR
`;

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: "Você cria textos curtos para promoções de e-commerce em português do Brasil.",
            },
          ],
        },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 300,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Gemini HTTP:", response.status, errorText);
      return FALLBACK_TEXT;
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];

    const text = (candidate?.content?.parts || [])
      .map((part) => part?.text || "")
      .join("")
      .trim()
      .replace(/^["“]|["”]$/g, "");

    if (!text) {
      console.error(
        "Gemini sem texto. finishReason:",
        candidate?.finishReason,
        JSON.stringify(data?.promptFeedback || {})
      );
      return FALLBACK_TEXT;
    }

    if (text.toUpperCase() === "PULAR") {
      return "PULAR";
    }

    return text.slice(0, 120);
  } catch (error) {
    console.error("Erro Gemini:", error);
    return FALLBACK_TEXT;
  }
}

/* =========================================================
   TELEGRAM
========================================================= */

function telegramToken() {
  return env("TELEGRAM_BOT_TOKEN") || env("TELEGRAM_TOKEN");
}

function telegramChatId() {
  return env("TELEGRAM_CHAT_ID") || env("TELEGRAM_CHANNEL_ID");
}

async function telegramRequest(method, body) {
  const token = telegramToken();

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN não configurado.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();

  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function sendTelegramPhoto(imageUrl, caption) {
  const chatId = telegramChatId();

  if (!chatId) {
    throw new Error("TELEGRAM_CHAT_ID não configurado.");
  }

  if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
    try {
      return await telegramRequest("sendPhoto", {
        chat_id: chatId,
        photo: imageUrl,
        caption,
        parse_mode: "HTML",
      });
    } catch (error) {
      console.error("sendPhoto falhou:", error);
    }
  }

  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  });
}

/* =========================================================
   FORMATAÇÃO DA PROMOÇÃO
========================================================= */

function formatPromotion(product, promoText, link) {
  const name = escapeHtml(
    String(product?.productName || "Oferta Shopee").slice(0, 150)
  );

  const min = priceOf(product);
  const max = number(product?.priceMax);

  const price =
    max > min && min > 0
      ? `a partir de ${moneyBRL(min)}`
      : moneyBRL(min);

  const discount = Math.round(discountOf(product));
  const rating = number(product?.ratingStar);
  const sales = integer(product?.sales);

  const lines = [];

  if (promoText) {
    lines.push(escapeHtml(promoText));
    lines.push("");
  }

  lines.push(`🛍️ <b>${name}</b>`);

  if (min > 0) {
    lines.push(`💰 <b>${price}</b>`);
  }

  if (discount > 0) {
    lines.push(`🔥 <b>${discount}% OFF</b>`);
  }

  if (rating > 0) {
    lines.push(`⭐ ${rating.toFixed(1)}`);
  }

  if (sales > 0) {
    lines.push(`🛒 ${sales.toLocaleString("pt-BR")} vendas`);
  }

  if (link) {
    lines.push("");
    lines.push(`👉 <a href="${escapeHtml(link)}">COMPRAR NA SHOPEE</a>`);
  }

  return lines.join("\n");
}

/* =========================================================
   ESCOLHA DAS OFERTAS
========================================================= */

function scoreProduct(product) {
  const discount = discountOf(product);
  const sales = integer(product?.sales);
  const rating = number(product?.ratingStar);

  return discount * 10 + Math.log10(sales + 1) * 8 + rating * 3;
}

function normalizeProduct(product) {
  return {
    ...product,
    itemId:
      product?.itemId ??
      product?.productId ??
      product?.offerId ??
      product?.productName,
    productName: product?.productName || "Produto Shopee",
    priceMin: number(product?.priceMin),
    priceMax: number(product?.priceMax),
    priceDiscountRate: number(product?.priceDiscountRate),
    ratingStar: number(product?.ratingStar),
    sales: integer(product?.sales),
  };
}

/* =========================================================
   ESTADO DO BOT
========================================================= */

async function getBotState() {
  return getJSON("bot-state", {
    keywordIndex: 0,
    lastRun: null,
    published: 0,
  });
}

async function saveBotState(state) {
  await setJSON("bot-state", state);
}

/* =========================================================
   EXECUÇÃO PRINCIPAL
========================================================= */

export async function runBot({ force = false } = {}) {
  if (!force && !withinSchedule()) {
    return {
      ok: true,
      skipped: true,
      reason: "Fora do horário configurado.",
    };
  }

  const locked = await acquireLock();

  if (!locked) {
    return {
      ok: true,
      skipped: true,
      reason: "Outra execução do bot está em andamento.",
    };
  }

  try {
    const minDiscount = number(env("MIN_DISCOUNT", "20"), 20);

    const postsPerCycle = Math.max(
      1,
      Math.min(integer(env("POSTS_PER_CYCLE", "1"), 1), 10)
    );

    const list = keywords();

    if (!list.length) {
      throw new Error("Nenhuma palavra-chave configurada.");
    }

    const state = await getBotState();
    let keywordIndex = integer(state.keywordIndex, 0);

    if (keywordIndex >= list.length) {
      keywordIndex = 0;
    }

    const startedAt = Date.now();
    const deadline = startedAt + 22000;

    const candidates = [];
    const searches = Math.min(
      list.length,
      Math.max(integer(env("SEARCHES_PER_CYCLE", "2"), 2), 1)
    );

    const keywordsToSearch = [];
    for (let i = 0; i < searches; i++) {
      keywordsToSearch.push(list[(keywordIndex + i) % list.length]);
    }

    const results = await Promise.all(
      keywordsToSearch.map(async (keyword) => {
        try {
          return await searchOffers(keyword);
        } catch (error) {
          console.error(`Erro pesquisando "${keyword}":`, error);
          return [];
        }
      })
    );

    for (const products of results) {
      for (const raw of products) {
        const product = normalizeProduct(raw);

        if (!product.itemId) {
          continue;
        }

        if (discountOf(product) < minDiscount) {
          continue;
        }

        candidates.push(product);
      }
    }

    const unique = new Map();

    for (const product of candidates) {
      const id = String(product.itemId);
      if (!unique.has(id)) {
        unique.set(id, product);
      }
    }

    const sorted = Array.from(unique.values()).sort(
      (a, b) => scoreProduct(b) - scoreProduct(a)
    );

    const published = [];

    for (const product of sorted) {
      if (published.length >= postsPerCycle) {
        break;
      }

      if (Date.now() > deadline) {
        console.error("Tempo limite do ciclo atingido, encerrando.");
        break;
      }

      if (await wasSent(product.itemId)) {
        continue;
      }

      const promoText = await generatePromoText(product);

      if (promoText.toUpperCase() === "PULAR") {
        continue;
      }

      const originalLink = productUrl(product);

      if (!originalLink) {
        continue;
      }

      const shortLink = await generateShortLink(originalLink);
      const caption = formatPromotion(product, promoText, shortLink);

      try {
        await sendTelegramPhoto(product.imageUrl, caption);
        await markSent(product.itemId);

        published.push({
          itemId: product.itemId,
          productName: product.productName,
          discount: discountOf(product),
          link: shortLink || originalLink,
        });

        await sleep(integer(env("POST_DELAY_MS", "500"), 500));
      } catch (error) {
        console.error("Erro publicando produto:", error);
      }
    }

    const newIndex = (keywordIndex + searches) % list.length;

    await saveBotState({
      keywordIndex: newIndex,
      lastRun: new Date().toISOString(),
      published: published.length,
    });

    return {
      ok: true,
      force,
      searched: searches,
      candidates: sorted.length,
      published: published.length,
      products: published,
    };
  } finally {
    await releaseLock();
  }
}

/* =========================================================
   NETLIFY FUNCTION
========================================================= */

export default async function handler(request) {
  try {
    if (request.method !== "GET" && request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Método não permitido." }, 405);
    }

    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";

    if (force) {
      const triggerKey = env("TRIGGER_KEY");
      const suppliedKey = url.searchParams.get("key");

      if (!triggerKey || suppliedKey !== triggerKey) {
        return jsonResponse({ ok: false, error: "Chave inválida." }, 401);
      }
    }

    const result = await runBot({ force });
    return jsonResponse(result, result.ok ? 200 : 500);
  } catch (error) {
    console.error("Erro geral do bot:", error);

    return jsonResponse(
      { ok: false, error: error?.message || String(error) },
      500
    );
  }
}
