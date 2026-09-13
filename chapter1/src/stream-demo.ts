import OpenAI from "openai";

export async function runStreamDemo(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Please set OPENAI_API_KEY in .env");
    process.exit(1);
  }

  const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const client = new OpenAI({ apiKey, baseURL });
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const body = {
    model,
    input: "What is 17 * 24? Explain your reasoning step by step.",
    reasoning: { effort: "high" as const },
  };

  console.log("=".repeat(80));
  console.log("Streaming Demo");
  console.log("=".repeat(80));
  console.log(`Endpoint: POST ${baseURL.replace(/\/$/, "")}/responses`);
  console.log(`(Note: reasoning effort requires a reasoning-capable model)`);

  console.log("\n>>> REQUEST");
  console.log(JSON.stringify({ ...body, stream: true }, null, 2));

  console.log("\n<<< STREAM EVENTS");

  let reasoningText = "";
  let outputText = "";
  let completedUsage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;
  let inReasoning = false;
  let inOutput = false;

  try {
    const stream = await client.responses.create({ ...body, stream: true as const });

    for await (const event of stream) {
      switch (event.type) {
        case "response.created":
          console.log(`[${event.type}]`);
          break;
        case "response.reasoning_text.delta":
          if (!inReasoning) {
            console.log("\n[reasoning]");
            inReasoning = true;
          }
          reasoningText += event.delta;
          process.stdout.write(event.delta);
          break;
        case "response.output_text.delta":
          if (!inOutput) {
            console.log("\n\n[output]");
            inOutput = true;
          }
          outputText += event.delta;
          process.stdout.write(event.delta);
          break;
        case "response.completed":
          completedUsage = event.response.usage;
          console.log(`\n\n[${event.type}]`);
          break;
        default:
          break;
      }
    }
  } catch (error) {
    console.error("\n[Stream Error]:", error);
  }

  console.log("\n--- Summary ---");
  if (reasoningText) {
    console.log(`Reasoning: ${reasoningText}`);
  }
  console.log(`\nOutput text: ${outputText}`);

  if (completedUsage) {
    console.log(`\nUsage:`);
    console.log(`  Input tokens:   ${completedUsage.input_tokens}`);
    console.log(`  Output tokens:  ${completedUsage.output_tokens}`);
    console.log(`  Total tokens:   ${completedUsage.total_tokens}`);
  }
}
