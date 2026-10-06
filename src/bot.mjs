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
