import { getStore } from "@netlify/blobs";

const STORE_NAME = "shopee-promo";

export default async (request, context) => {
  const id = String(context.params?.id || "").trim();

  if (!/^[A-Za-z0-9_-]{6,32}$/.test(id)) {
    return new Response("Link inválido", { status: 404 });
  }

  try {
    const store = getStore({
      name: STORE_NAME,
      consistency: "strong",
    });

    const target = await store.get(`redirect:${id}`, { type: "json" });
    const url = String(target?.url || "");

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }

    const host = parsed?.hostname || "";
    const isShopee =
      parsed?.protocol === "https:" &&
      /(^|\.)shopee\.com\.br$/i.test(host);

    if (!isShopee) {
      return new Response("Link não encontrado", { status: 404 });
    }

    return Response.redirect(parsed.toString(), 302);
  } catch (error) {
    console.error("Erro no redirect:", error);
    return new Response("Erro ao abrir o link", { status: 500 });
  }
};

export const config = {
  path: "/r/:id",
};
