import OpenAI from "openai";

interface WeatherArgs {
  city: string;
}

function mockGetWeather(city: string): string {
  const weather: Record<string, { temperature_c: number; condition: string }> = {
    "new york": { temperature_c: 22, condition: "sunny" },
    "tokyo": { temperature_c: 18, condition: "cloudy" },
  };
  const data = weather[city.toLowerCase()] ?? { temperature_c: 20, condition: "clear" };
  return JSON.stringify({ city, ...data });
}

export async function runFunctionCallingDemo(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Please set OPENAI_API_KEY in .env");
    process.exit(1);
  }

  const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const client = new OpenAI({ apiKey, baseURL });
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const tools = [
    {
      type: "function" as const,
      name: "get_weather",
      description: "Get the current weather for a given city",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "The name of the city" },
        },
        required: ["city"],
        additionalProperties: false,
      },
      strict: true,
    },
  ];

  const question = "What's the weather like in New York and Tokyo right now?";

  console.log("=".repeat(80));
  console.log("Parallel Function Calling Demo");
  console.log("=".repeat(80));
  console.log(`Endpoint: POST ${baseURL.replace(/\/$/, "")}/responses`);

  // 第一轮：模型可能发起多个并行工具调用。使用 store: false，避免依赖服务端会话存储。
  const round1Body = { model, input: question, tools, parallel_tool_calls: true, store: false };
  console.log("\n>>> ROUND 1 REQUEST");
  console.log(JSON.stringify(round1Body, null, 2));

  const resp1 = await client.responses.create(round1Body);

  console.log("\n<<< ROUND 1 RESPONSE");
  console.log(JSON.stringify(resp1, null, 2));

  const toolCalls = resp1.output.filter((item) => item.type === "function_call");

  if (toolCalls.length === 0) {
    console.log("\nNo tool calls were made.");
    return;
  }

  console.log(`\nModel made ${toolCalls.length} tool call(s) in parallel:`);
  for (const call of toolCalls) {
    console.log(`  - ${call.name}(${call.arguments})`);
  }

  // 执行工具，把结果作为 function_call_output 返回
  const toolOutputs = toolCalls.map((call) => {
    const args = JSON.parse(call.arguments) as WeatherArgs;
    const output = mockGetWeather(args.city);
    console.log(`  -> ${call.name}(${call.arguments}) => ${output}`);
    return {
      type: "function_call_output" as const,
      call_id: call.call_id,
      output,
    };
  });

  const replayedToolCalls = toolCalls.map((call) => ({
    type: "function_call" as const,
    call_id: call.call_id,
    name: call.name,
    arguments: call.arguments,
  }));

  // 第二轮：客户端带上原始 function_call 和工具输出，完整重建上下文。
  const round2Body = {
    model,
    input: [
      { role: "user" as const, content: question },
      ...replayedToolCalls,
      ...toolOutputs,
    ],
    tools,
  };

  console.log("\n>>> ROUND 2 REQUEST");
  console.log(JSON.stringify(round2Body, null, 2));

  const resp2 = await client.responses.create(round2Body);

  console.log("\n<<< ROUND 2 RESPONSE");
  console.log(JSON.stringify(resp2, null, 2));
  console.log(`\nFinal output: ${resp2.output_text}`);
}
