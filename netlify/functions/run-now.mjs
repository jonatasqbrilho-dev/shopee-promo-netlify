import { runBot } from "../../src/bot.mjs";

// Teste manual: /.netlify/functions/run-now?key=SUA_TRIGGER_KEY   (ignora o horário)
export default async (req) => {
  const url = new URL(req.url);
  if (!process.env.TRIGGER_KEY || url.searchParams.get("key") !== process.env.TRIGGER_KEY) {
    return new Response("não autorizado", { status: 401 });
  }
  try {
    const out = await runBot({ force: true });
    return Response.json(out);
  } catch (e) {
    return Response.json({ erro: e.message }, { status: 500 });
  }
};
