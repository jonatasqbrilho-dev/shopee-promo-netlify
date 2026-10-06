import { runBot } from "../../src/bot.mjs";

export default async () => {
  try {
    const result = await runBot({ force: false });

    console.log(
      "scheduled run result:",
      JSON.stringify(result)
    );
  } catch (error) {
    console.error(
      "scheduled run error:",
      error
    );

    throw error;
  }
};

export const config = {
  schedule: "*/30 * * * *",
};