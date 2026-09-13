import OpenAI from "openai";

export async function runLoggingDemo(userInputArg?: string): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Please set OPENAI_API_KEY in .env");
    process.exit(1);
  }

  const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

  const client = new OpenAI({ apiKey, baseURL });

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const userInput = userInputArg || "What is the capital of France? Reply in one sentence.";

  console.log("=".repeat(80));
  console.log("OpenAI Responses API Inspector");
  console.log("=".repeat(80));

  const requestBody = {
    model,
    input: userInput,
  };

  console.log("\n>>> REQUEST");
  console.log(`Endpoint: POST ${baseURL.replace(/\/$/, "")}/responses`);
  console.log("Body:");
  console.log(JSON.stringify(requestBody, null, 2));

  const response = await client.responses.create(requestBody);

  console.log("\n<<< RESPONSE");
  console.log(JSON.stringify(response, null, 2));

  console.log("\n--- Summary ---");
  console.log(`ID:          ${response.id}`);
  console.log(`Model:       ${response.model}`);
  console.log(`Object:      ${response.object}`);
  console.log(`Status:      ${response.status ?? "N/A"}`);
  console.log(`Created:     ${new Date(response.created_at * 1000).toISOString()}`);
  console.log(`Output Text: ${response.output_text}`);

  if (response.usage) {
    console.log(`\nUsage:`);
    console.log(`  Input tokens:   ${response.usage.input_tokens}`);
    console.log(`  Output tokens:  ${response.usage.output_tokens}`);
    console.log(`  Total tokens:   ${response.usage.total_tokens}`);
    if (response.usage.input_tokens_details) {
      console.log(`  Input details:  ${JSON.stringify(response.usage.input_tokens_details)}`);
    }
    if (response.usage.output_tokens_details) {
      console.log(`  Output details: ${JSON.stringify(response.usage.output_tokens_details)}`);
    }
  }
}
