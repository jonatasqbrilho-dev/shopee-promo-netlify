import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const env = (key, fallback = "") =>
  process.env[key] ?? fallback;

const SHOPEE_ENDPOINT =
  "https://open-api.affiliate.shopee.com.br/graphql";

const SENT_TTL_MS =
  7 * 24 * 60 * 60 * 1000;

const LOCK_TTL_MS =
  10 * 60 * 1000;

// ============================================================
// UTILITÁRIOS
// ============================================================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function moedaBRL(value) {
  const numero = Number(value || 0);

  return numero.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

// ============================================================
// SHOPEE
// ============================================================

async function shopee(query) {
  const appId = env("SHOPEE_APP_ID");
  const secret = env("SHOPEE_SECRET");

  if (!appId) {
    throw new Error("SHOPEE_APP_ID não configurado.");
  }

  if (!secret) {
    throw new Error("SHOPEE_SECRET não configurado.");
  }

  const payload = JSON.stringify({
    query,
  });

  const timestamp =
    Math.floor(Date.now() / 1000).toString();

  const signature = createHash("sha256")
    .update(
      `${appId}${timestamp}${payload}${secret}`
    )
    .digest("hex");

  const response = await fetch(
    SHOPEE_ENDPOINT,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",

        Authorization:
          `SHA256 Credential=${appId}, Timestamp=${timestamp}, Sig5nature=${signature}`,
      },

      body: payload,

      signal:
        AbortSignal.timeout(15000),
    }
  );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Shopee HTTP ${response.status}: ${text.slice(
        0,
        500
      )}`
    );
  }

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      "Shopee retornou JSON inválido."
    );
  }

  if (json.errors) {
    throw new Error(
      `Shopee GraphQL: ${JSON.stringify(
        json.errors
      ).slice(0, 1000)}`
    );
  }

  return json.data;
}

// ============================================================
// BUSCA OFERTAS
// ============================================================

async function buscarOfertas(
  keyword,
  page = 1,
  limit = 50
) {
  const keywordArgument = keyword
    ? `keyword: ${JSON.stringify(keyword)},`
    : "";

  const sortType = Number(
    env("SORT_TYPE", "2")
  );

  const query = `
    {
      productOfferV2(
        ${keywordArgument}
        sortType: ${sortType},
        page: ${page},
        limit: ${limit}
      ) {
        nodes {
          itemId
          productName
          imageUrl
          priceMin
          priceMax
          priceDiscountRate
          ratingStar
          sales
          shopName
          offerLink
          productLink
        }
      }
    }
  `;

  const data =
    await shopee(query);

  return (
    data?.productOfferV2?.nodes ??
    []
  );
}

// ============================================================
// LINK DE AFILIADO
// ============================================================

async function gerarLinkCurto(url) {
  if (!url) {
    return "";
  }

  try {
    const subId = env(
      "SUB_ID",
      "telegram"
    );

    const query = `
      mutation {
        generateShortLink(
          input: {
            originUrl: ${JSON.stringify(url)},
            subIds: [
              ${JSON.stringify(subId)}
            ]
          }
        ) {
          shortLink
        }
      }
    `;

    const data =
      await shopee(query);

    return (
      data?.generateShortLink?.shortLink ||
      url
    );
  } catch (error) {
    console.error(
      "Erro ao gerar link curto:",
      error.message
    );

    return url;
  }
}

// ============================================================
// GEMINI
// ============================================================

const PROMPT_IA = `
Você é redator de um grupo de promoções no Telegram no Brasil.

Receberá informações reais de um produto da Shopee.

Crie UMA frase curta e chamativa para acompanhar a promoção.

REGRAS:

- No máximo 90 caracteres.
- Português do Brasil.
- Use somente os dados recebidos.
- Nunca invente informações.
- Nunca invente estoque.
- Nunca invente prazo.
- Nunca invente cupom.
- Nunca invente garantia.
- Nunca invente características.
- Pode mencionar desconto.
- Pode mencionar número de vendas.
- Pode mencionar avaliação.
- Pode mencionar benefício que esteja claramente no nome do produto.
- No máximo 1 emoji.
- Não coloque preço.
- Não use hashtags.
- Não use aspas.
- Tom animado e natural.
- Não seja exagerado.

Se o produto for inadequado, responda somente:

PULAR

Produtos inadequados incluem:
- armas;
- conteúdo adulto;
- medicamentos;
- suplementos com promessa de saúde;
- produtos falsificados;
- réplicas de marcas.

Responda SOMENTE com a frase ou PULAR.
`;

let ultimoModeloFuncionando = "";

async function analisarProduto(produto) {
  const apiKey =
    env("GEMINI_API_KEY");

  if (!apiKey) {
    return {
      frase: "",
      erro:
        "GEMINI_API_KEY não configurada.",
    };
  }

  const dados = [
    `Produto: ${produto.productName}`,
    ``Desconto: ${Math.round(
  Number(
    produto.priceDiscountRate || 0
  )
)}%`,