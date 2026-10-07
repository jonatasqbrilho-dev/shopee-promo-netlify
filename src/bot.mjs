import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const env = (key, fallback = "") => process.env[key] ?? fallback;

const SHOPEE_ENDPOINT =
  "https://open-api.affiliate.shopee.com.br/graphql";

const SENT_TTL_MS =
  7 * 24 * 60 * 60 * 1000;

const LOCK_TTL_MS =
  2 * 60 * 1000;

const STORE_NAME =
  "shopee-promo";

const FALLBACK_TEXT =
  "🔥 Oferta encontrada na Shopee!";

/* =========================================================
   UTILITÁRIOS
========================================================= */

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
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

// A API da Shopee devolve priceMin/priceMax
// já com o preço atual.
const priceOf = (product) =>
  number(product?.priceMin) ||
  number(product?.priceMax) ||
  0;

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
  const start = integer(
    env("BOT_START_HOUR", "8"),
    8
  );

  const end = integer(
    env("BOT_END_HOUR", "22"),
    22
  );

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
    const value = await store().get(key, {
      type: "json",
    });

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

  if (
    current &&
    number(current.expiresAt) > now
  ) {
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
    await setJSON("bot-lock", {
      lockedAt: 0,
      expiresAt: 0,
    });
  } catch (error) {
    console.error(
      "Erro ao liberar lock:",
      error
    );
  }
}

async function wasSent(itemId) {
  if (!itemId) {
    return false;
  }

  const data = await getJSON(
    `sent:${itemId}`
  );

  if (!data) {
    return false;
  }

  const sentAt = number(data.sentAt);

  if (!sentAt) {
    return false;
  }

  return (
    Date.now() - sentAt <= SENT_TTL_MS
  );
}

async function markSent(itemId) {
  if (!itemId) {
    return;
  }

  await setJSON(
    `sent:${itemId}`,
    {
      sentAt: Date.now(),
    }
  );
}

/* =========================================================
   SHOPEE API
========================================================= */

function shopeeCredentials() {
  const appId =
    env("SHOPEE_APP_ID") ||
    env("SHOPEE_APPID");

  const secret =
    env("SHOPEE_APP_SECRET") ||
    env("SHOPEE_SECRET");

  if (!appId || !secret) {
    throw new Error(
      "SHOPEE_APP_ID ou SHOPEE_APP_SECRET não configurado."
    );
  }

  return {
    appId: String(appId),
    secret: String(secret),
  };
}

async function shopeeRequest(query) {
  const {
    appId,
    secret,
  } = shopeeCredentials();

  const payload = JSON.stringify({
    query,
  });

  const timestamp =
    Math.floor(Date.now() / 1000);

  const signature = createHash("sha256")
    .update(
      appId +
        timestamp +
        payload +
        secret
    )
    .digest("hex");

  const response = await fetch(
    SHOPEE_ENDPOINT,
    {
      signal: AbortSignal.timeout(8000),
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        Authorization:
          `SHA256 Credential=${appId}, ` +
          `Timestamp=${timestamp}, ` +
          `Signature=${signature}`,
      },

      body: payload,
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Shopee retornou resposta inválida: ${text.slice(
        0,
        500
      )}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Shopee HTTP ${response.status}: ${JSON.stringify(
        data
      )}`
    );
  }

  if (data?.errors?.length) {
    throw new Error(
      `Shopee GraphQL: ${JSON.stringify(
        data.errors
      )}`
    );
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

  const sortType = integer(
    env("SHOPEE_SORT_TYPE", "2"),
    2
  );

  const page = integer(
    env("SHOPEE_PAGE", "1"),
    1
  );

  const limit = Math.min(
    Math.max(
      integer(
        env("SHOPEE_LIMIT", "20"),
        20
      ),
      1
    ),
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

  const data =
    await shopeeRequest(query);

  return (
    data?.data?.productOfferV2?.nodes ||
    []
  );
}

/* =========================================================
   LINK DE AFILIADO SHOPEE
========================================================= */

async function generateShopeeAffiliateLink(
  originUrl
) {
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

    const data =
      await shopeeRequest(query);

    const shortLink =
      data?.data
        ?.generateShortLink
        ?.shortLink;

    if (!shortLink) {
      throw new Error(
        "Shopee não retornou shortLink."
      );
    }

    return shortLink;
  } catch (error) {
    console.error(
      "Erro ao gerar link de afiliado Shopee:",
      error?.message || error
    );

    return "";
  }
}

/* =========================================================
   SHORT.IO
========================================================= */

async function createShortIoLink(
  originalUrl
) {
  if (!originalUrl) {
    return "";
  }

  const apiKey =
    env("SHORTIO_API_KEY");

  const domain =
    env("SHORTIO_DOMAIN");

  if (!apiKey) {
    console.error(
      "SHORTIO_API_KEY não configurado."
    );

    return "";
  }

  if (!domain) {
    console.error(
      "SHORTIO_DOMAIN não configurado."
    );

    return "";
  }

  try {
    const response = await fetch(
      "https://api.short.io/links",
      {
        method: "POST",

        signal:
          AbortSignal.timeout(8000),

        headers: {
          "Content-Type":
            "application/json",

          Authorization: apiKey,
        },

        body: JSON.stringify({
          originalURL: originalUrl,
          domain: domain,
        }),
      }
    );

    const text =
      await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Short.io retornou resposta inválida: ${text.slice(
          0,
          500
        )}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Short.io HTTP ${response.status}: ${JSON.stringify(
          data
        )}`
      );
    }

    const shortUrl =
      data?.secureShortURL ||
      data?.shortURL ||
      data?.shortUrl ||
      "";

    if (!shortUrl) {
      throw new Error(
        `Short.io não retornou o link curto: ${JSON.stringify(
          data
        )}`
      );
    }

    console.log(
      "Short.io criou:",
      shortUrl
    );

    return shortUrl;
  } catch (error) {
    console.error(
      "Erro ao criar link no Short.io:",
      error?.message || error
    );

    return "";
  }
}

/* =========================================================
   GEMINI
========================================================= */

async function callGemini(
  model,
  apiKey,
  prompt,
  timeoutMs
) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);

  const generationConfig = {
    maxOutputTokens: 300,
  };

  if (!model.includes("lite")) {
    generationConfig.thinkingConfig = {
      thinkingLevel: "low",
    };
  }

  const response = await fetch(
    url,
    {
      signal:
        AbortSignal.timeout(timeoutMs),

      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "Você cria textos curtos para promoções de e-commerce em português do Brasil.",
            },
          ],
        },

        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],

        generationConfig,
      }),
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `HTTP ${response.status}: ${errorText.slice(
        0,
        300
      )}`
    );
  }

  const data =
    await response.json();

  const candidate =
    data?.candidates?.[0];

  const text = (
    candidate?.content?.parts ||
    []
  )
    .map(
      (part) =>
        part?.text || ""
    )
    .join("")
    .trim()
    .replace(
      /^[\"“]|[\"”]$/g,
      ""
    );

  if (!text) {
    throw new Error(
      `resposta vazia (finishReason: ${candidate?.finishReason})`
    );
  }

  return text;
}

async function callGroq(
  apiKey,
  model,
  prompt,
  timeoutMs
) {
  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      signal:
        AbortSignal.timeout(timeoutMs),

      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        Authorization:
          `Bearer ${apiKey}`,
      },

      body: JSON.stringify({
        model,

        temperature: 0.8,

        max_tokens: 200,

        messages: [
          {
            role: "system",

            content:
              "Você cria textos curtos para promoções de e-commerce em português do Brasil.",
          },

          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `HTTP ${response.status}: ${errorText.slice(
        0,
        300
      )}`
    );
  }

  const data =
    await response.json();

  const text = String(
    data?.choices?.[0]
      ?.message?.content || ""
  )
    .trim()
    .replace(
      /^[\"“]|[\"”]$/g,
      ""
    );

  if (!text) {
    throw new Error(
      "resposta vazia"
    );
  }

  return text;
}

async function generatePromoText(
  product,
  deadline = Infinity
) {
  const groqKey =
    env("GROQ_API_KEY");

  const geminiKey =
    env("GEMINI_API_KEY");

  const discount =
    Math.round(
      discountOf(product)
    );

  const productName =
    String(
      product?.productName || ""
    ).slice(0, 300);

  const price =
    moneyBRL(
      priceOf(product)
    );

  const rating =
    number(
      product?.ratingStar
    ).toFixed(1);

  const sales =
    integer(product?.sales);

  const prompt = `
Você é redator de um canal de ofertas no Telegram do Brasil. Escreva UMA frase curta que faça o leitor querer comprar agora.

Produto: ${productName}
Preço: ${price}
Desconto: ${discount}%
Avaliação: ${rating} de 5
Vendas: ${sales}

Regras:
- 1 frase (no máximo 2 curtas), até 130 caracteres;
- destaque UM benefício real desse tipo de produto, baseado só no nome (ex.: praticidade, economia, conforto);
- crie senso de urgência de forma honesta, como "aproveite enquanto está em oferta" ou "corre antes que acabe";
- se as vendas passarem de 1000, pode citar como prova social (ex.: "mais de 19 mil vendidos");
- NÃO invente: estoque, "últimas unidades", "só hoje", prazo, frete grátis, garantia, cupom ou qualquer dado que não esteja acima;
- NÃO repita o preço nem o desconto;
- NÃO corrija nem altere o nome do produto;
- tom animado e natural, com no máximo 2 emojis;
- sem link, sem hashtags, sem aspas;
- responda somente com a frase.

Se o produto for perigoso, ilegal, adulto ou inadequado para divulgação, responda apenas: PULAR
`;

  const attempts = [];

  if (groqKey) {
    const groqModel =
      env(
        "GROQ_MODEL",
        "llama-3.3-70b-versatile"
      );

    attempts.push({
      name:
        `groq/${groqModel}`,

      timeoutMs: 6000,

      run: (timeoutMs) =>
        callGroq(
          groqKey,
          groqModel,
          prompt,
          timeoutMs
        ),
    });
  }

  if (geminiKey) {
    const geminiModels = [
      env(
        "GEMINI_MODEL",
        "gemini-3.5-flash-lite"
      ),

      env(
        "GEMINI_FALLBACK_MODEL",
        "gemini-3.7-flash"
      ),
    ].filter(
      (m, i, arr) =>
        m &&
        arr.indexOf(m) === i
    );

    geminiModels.forEach(
      (model, index) => {
        attempts.push({
          name:
            `gemini/${model}`,

          timeoutMs:
            index === 0
              ? 7000
              : 9000,

          run: (timeoutMs) =>
            callGemini(
              model,
              geminiKey,
              prompt,
              timeoutMs
            ),
        });
      }
    );
  }

  if (!attempts.length) {
    console.error(
      "Nenhuma chave de IA configurada (GROQ_API_KEY ou GEMINI_API_KEY)."
    );

    return FALLBACK_TEXT;
  }

  for (
    let i = 0;
    i < attempts.length;
    i++
  ) {
    if (
      i > 0 &&
      Date.now() >
        deadline - 9000
    ) {
      break;
    }

    const attempt =
      attempts[i];

    try {
      const text =
        await attempt.run(
          attempt.timeoutMs
        );

      if (
        text.toUpperCase() ===
        "PULAR"
      ) {
        return "PULAR";
      }

      return text.slice(
        0,
        160
      );
    } catch (error) {
      console.error(
        `IA falhou (${attempt.name}):`,
        error?.message ||
          error
      );
    }
  }

  return FALLBACK_TEXT;
}

/* =========================================================
   TELEGRAM
========================================================= */

function telegramToken() {
  return (
    env("TELEGRAM_BOT_TOKEN") ||
    env("TELEGRAM_TOKEN")
  );
}

function telegramChatId() {
  return (
    env("TELEGRAM_CHAT_ID") ||
    env("TELEGRAM_CHANNEL_ID")
  );
}

async function telegramRequest(
  method,
  body
) {
  const token =
    telegramToken();

  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN não configurado."
    );
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify(body),
    }
  );

  const data =
    await response.json();

  if (
    !response.ok ||
    !data?.ok
  ) {
    throw new Error(
      `Telegram ${method}: ${JSON.stringify(
        data
      )}`
    );
  }

  return data;
}

async function sendTelegramPhoto(
  imageUrl,
  caption
) {
  const chatId =
    telegramChatId();

  if (!chatId) {
    throw new Error(
      "TELEGRAM_CHAT_ID não configurado."
    );
  }

  if (
    imageUrl &&
    /^https?:\/\//i.test(
      imageUrl
    )
  ) {
    try {
      return await telegramRequest(
        "sendPhoto",
        {
          chat_id: chatId,
          photo: imageUrl,
          caption,
          parse_mode: "HTML",
        }
      );
    } catch (error) {
      console.error(
        "sendPhoto falhou:",
        error
      );
    }
  }

  return telegramRequest(
    "sendMessage",
    {
      chat_id: chatId,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }
  );
}

/* =========================================================
   FORMATAÇÃO DA PROMOÇÃO
========================================================= */

function formatPromotion(
  product,
  promoText,
  link
) {
  const name =
    escapeHtml(
      String(
        product?.productName ||
          "Oferta Shopee"
      ).slice(0, 100)
    );

  const min =
    priceOf(product);

  const max =
    number(
      product?.priceMax
    );

  const priceLabel =
    max > min && min > 0
      ? "a partir de "
      : "";

  const discount =
    Math.round(
      discountOf(product)
    );

  const rating =
    number(
      product?.ratingStar
    );

  const sales =
    integer(
      product?.sales
    );

  const lines = [];

  if (promoText) {
    lines.push(
      `🔥 <b>${escapeHtml(
        promoText
      )}</b>`
    );

    lines.push("");
  }

  lines.push(
    `🛍️ <b>${name}</b>`
  );

  lines.push("");

  if (min > 0) {
    lines.push(
      `💰 ${priceLabel}<b>${moneyBRL(
        min
      )}</b>`
    );
  }

  if (discount > 0) {
    lines.push(
      `🏷️ <b>${discount}% OFF</b>`
    );
  }

  if (rating > 0) {
    lines.push(
      `⭐ ${rating.toFixed(
        1
      )} de 5`
    );
  }

  if (sales > 0) {
    lines.push(
      `🛒 ${sales.toLocaleString(
        "pt-BR"
      )} vendidos`
    );
  }

  if (link) {
    lines.push("");
    lines.push("👉 <b>COMPRE AQUI:</b>");
    lines.push(escapeHtml(link));
  }

  return lines.join("\n");
}

/* =========================================================
   ESCOLHA DAS OFERTAS
========================================================= */

function scoreProduct(product) {
  const discount =
    discountOf(product);

  const sales =
    integer(product?.sales);

  const rating =
    number(
      product?.ratingStar
    );

  return (
    discount * 10 +
    Math.log10(
      sales + 1
    ) * 8 +
    rating * 3
  );
}

function normalizeProduct(
  product
) {
  return {
    ...product,

    itemId:
      product?.itemId ??
      product?.productId ??
      product?.offerId ??
      product?.productName,

    productName:
      product?.productName ||
      "Produto Shopee",

    priceMin:
      number(
        product?.priceMin
      ),

    priceMax:
      number(
        product?.priceMax
      ),

    priceDiscountRate:
      number(
        product?.priceDiscountRate
      ),

    ratingStar:
      number(
        product?.ratingStar
      ),

    sales:
      integer(
        product?.sales
      ),
  };
}

/* =========================================================
   ESTADO DO BOT
========================================================= */

async function getBotState() {
  return getJSON(
    "bot-state",
    {
      keywordIndex: 0,
      lastRun: null,
      published: 0,
    }
  );
}

async function saveBotState(
  state
) {
  await setJSON(
    "bot-state",
    state
  );
}

/* =========================================================
   EXECUÇÃO PRINCIPAL
========================================================= */

export async function runBot({
  force = false,
} = {}) {
  if (
    !force &&
    !withinSchedule()
  ) {
    return {
      ok: true,
      skipped: true,
      reason:
        "Fora do horário configurado.",
    };
  }

  const locked =
    await acquireLock();

  if (!locked) {
    return {
      ok: true,
      skipped: true,
      reason:
        "Outra execução do bot está em andamento.",
    };
  }

  try {
    const minDiscount =
      number(
        env(
          "MIN_DISCOUNT",
          "20"
        ),
        20
      );

    const postsPerCycle =
      Math.max(
        1,
        Math.min(
          integer(
            env(
              "POSTS_PER_CYCLE",
              "1"
            ),
            1
          ),
          10
        )
      );

    const list =
      keywords();

    if (!list.length) {
      throw new Error(
        "Nenhuma palavra-chave configurada."
      );
    }

    const state =
      await getBotState();

    let keywordIndex =
      integer(
        state.keywordIndex,
        0
      );

    if (
      keywordIndex >=
      list.length
    ) {
      keywordIndex = 0;
    }

    const startedAt =
      Date.now();

    const deadline =
      startedAt + 22000;

    const candidates = [];

    const searches =
      Math.min(
        list.length,
        Math.max(
          integer(
            env(
              "SEARCHES_PER_CYCLE",
              "2"
            ),
            2
          ),
          1
        )
      );

    const keywordsToSearch =
      [];

    for (
      let i = 0;
      i < searches;
      i++
    ) {
      keywordsToSearch.push(
        list[
          (keywordIndex + i) %
            list.length
        ]
      );
    }

    const results =
      await Promise.all(
        keywordsToSearch.map(
          async (keyword) => {
            try {
              return await searchOffers(
                keyword
              );
            } catch (error) {
              console.error(
                `Erro pesquisando "${keyword}":`,
                error
              );

              return [];
            }
          }
        )
      );

    for (
      const products of results
    ) {
      for (
        const raw of products
      ) {
        const product =
          normalizeProduct(
            raw
          );

        if (!product.itemId) {
          continue;
        }

        if (
          discountOf(
            product
          ) < minDiscount
        ) {
          continue;
        }

        candidates.push(
          product
        );
      }
    }

    const unique =
      new Map();

    for (
      const product of candidates
    ) {
      const id =
        String(
          product.itemId
        );

      if (
        !unique.has(id)
      ) {
        unique.set(
          id,
          product
        );
      }
    }

    const sorted =
      Array.from(
        unique.values()
      ).sort(
        (a, b) =>
          scoreProduct(b) -
          scoreProduct(a)
      );

    const published = [];

    for (
      const product of sorted
    ) {
      if (
        published.length >=
        postsPerCycle
      ) {
        break;
      }

      if (
        Date.now() >
        deadline
      ) {
        console.error(
          "Tempo limite do ciclo atingido, encerrando."
        );

        break;
      }

      if (
        await wasSent(
          product.itemId
        )
      ) {
        continue;
      }

      const promoText =
        await generatePromoText(
          product,
          deadline
        );

      if (
        promoText.toUpperCase() ===
        "PULAR"
      ) {
        continue;
      }

      /* =====================================================
         LINK DO PRODUTO
      ===================================================== */

      const originalLink =
        productUrl(
          product
        );

      if (!originalLink) {
        continue;
      }

      /* =====================================================
         1. LINK DE AFILIADO SHOPEE
      ===================================================== */

      const affiliateLink =
        await generateShopeeAffiliateLink(
          originalLink
        );

      if (!affiliateLink) {
        console.error(
          "Não foi possível gerar o link de afiliado."
        );

        continue;
      }

      /* =====================================================
         2. LINK CURTO SHORT.IO
      ===================================================== */

      const shortLink =
        await createShortIoLink(
          affiliateLink
        );

      if (!shortLink) {
        console.error(
          "Não foi possível gerar o link curto no Short.io."
        );

        continue;
      }

      /* =====================================================
         3. MONTAR PROMOÇÃO
      ===================================================== */

      const caption =
        formatPromotion(
          product,
          promoText,
          shortLink
        );

      try {
        await sendTelegramPhoto(
          product.imageUrl,
          caption
        );

        await markSent(
          product.itemId
        );

        published.push({
          itemId:
            product.itemId,

          productName:
            product.productName,

          discount:
            discountOf(
              product
            ),

          link:
            shortLink,
        });

        await sleep(
          integer(
            env(
              "POST_DELAY_MS",
              "500"
            ),
            500
          )
        );
      } catch (error) {
        console.error(
          "Erro publicando produto:",
          error
        );
      }
    }

    const newIndex =
      (keywordIndex +
        searches) %
      list.length;

    await saveBotState({
      keywordIndex:
        newIndex,

      lastRun:
        new Date().toISOString(),

      published:
        published.length,
    });

    return {
      ok: true,
      force,

      searched:
        searches,

      candidates:
        sorted.length,

      published:
        published.length,

      products:
        published,
    };
  } finally {
    await releaseLock();
  }
}

/* =========================================================
   NETLIFY FUNCTION
========================================================= */

export default async function handler(
  request
) {
  try {
    if (
      request.method !== "GET" &&
      request.method !== "POST"
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Método não permitido.",
        },
        405
      );
    }

    const url =
      new URL(
        request.url
      );

    const force =
      url.searchParams.get(
        "force"
      ) === "1";

    if (force) {
      const triggerKey =
        env(
          "TRIGGER_KEY"
        );

      const suppliedKey =
        url.searchParams.get(
          "key"
        );

      if (
        !triggerKey ||
        suppliedKey !==
          triggerKey
      ) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Chave inválida.",
          },
          401
        );
      }
    }

    const result =
      await runBot({
        force,
      });

    return jsonResponse(
      result,
      result.ok
        ? 200
        : 500
    );
  } catch (error) {
    console.error(
      "Erro geral do bot:",
      error
    );

    return jsonResponse(
      {
        ok: false,
        error:
          error?.message ||
          String(error),
      },
      500
    );
  }
}
