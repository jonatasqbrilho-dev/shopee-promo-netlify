import { runBot } from "../../src/bot.mjs";

export default async (request) => {
  const url = new URL(request.url);

  const triggerKey = Netlify.env.get("TRIGGER_KEY");
  const suppliedKey = url.searchParams.get("key");

  if (!triggerKey || suppliedKey !== triggerKey) {
    return new Response("não autorizado", { status: 401 });
  }

  try {
    const out = await runBot({ force: true });

    return Response.json(out);
  } catch (error) {
    console.error("run-now error:", error);

    return Response.json(
      {
        ok: false,
        erro: error?.message || String(error),
      },
      { status: 500 }
    );
  }
};