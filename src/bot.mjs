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
