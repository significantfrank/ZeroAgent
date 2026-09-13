import OpenAI from "openai";

export async function runStoreDemo(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Please set OPENAI_API_KEY in .env");
    process.exit(1);
  }

  const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

  const client = new OpenAI({ apiKey, baseURL });

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  console.log("=".repeat(80));
  console.log("Store & previous_response_id Demo");
  console.log("=".repeat(80));
  console.log(`Endpoint: POST ${baseURL.replace(/\/$/, "")}/responses`);
  console.log(`Model:    ${model}`);

  // 第一轮：store=true 存储，才能拿到 id 用于后续
  const round1Body = {
    model,
    input: "我有三只猫。kitty, tom, and jerry.",
    store: true,
  };

  console.log("\n>>> ROUND 1 REQUEST");
  console.log(JSON.stringify(round1Body, null, 2));

  const resp1 = await client.responses.create(round1Body);

  console.log("\n<<< ROUND 1 RESPONSE");
  //console.log(JSON.stringify(resp1, null, 2));
  console.log(`\nRound 1 output_text: ${resp1.output_text}`);
  console.log(`Round 1 id:          ${resp1.id}`);

  // 第二轮：直接传入上一轮的 id，模型自动记住上下文
  const round2Body = {
    model,
    previous_response_id: resp1.id,
    input: "它们分别叫什么名字？",
  };

  console.log("\n>>> ROUND 2 REQUEST");
  console.log(JSON.stringify(round2Body, null, 2));

  const resp2 = await client.responses.create(round2Body);

  console.log("\n<<< ROUND 2 RESPONSE");
 // console.log(JSON.stringify(resp2, null, 2));
  console.log(`\nRound 2 output_text: ${resp2.output_text}`);
}
