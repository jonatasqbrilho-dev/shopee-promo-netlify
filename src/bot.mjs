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

async function
