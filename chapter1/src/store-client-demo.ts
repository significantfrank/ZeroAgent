import OpenAI from "openai";

type Message = {
    role: "user" | "assistant" | "system" | "developer";
    content: string;
};

export async function runStoreClientDemo(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error("Please set OPENAI_API_KEY in .env");
        process.exit(1);
    }

    const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const client = new OpenAI({ apiKey, baseURL });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    console.log("=".repeat(80));
    console.log("Client-managed Conversation Demo");
    console.log("=".repeat(80));
    console.log(`Endpoint: POST ${baseURL.replace(/\/$/, "")}/responses`);
    console.log(`Model:    ${model}`);

    const history: Message[] = [
        { role: "user", content: "我有三只猫。kitty, tom, and jerry." },
    ];

    const round1Body = {
        model,
        input: history,
        store: false,
    };

    console.log("\n>>> ROUND 1 REQUEST");
    console.log(JSON.stringify(round1Body, null, 2));

    const resp1 = await client.responses.create(round1Body);

    console.log("\n<<< ROUND 1 RESPONSE");
    console.log(JSON.stringify(resp1, null, 2));
    console.log(`\nRound 1 output_text: ${resp1.output_text}`);

    history.push({ role: "assistant", content: resp1.output_text });
    history.push({ role: "user", content: "它们分别叫什么名字？" });

    // 第二轮把之前的消息和新消息一起发送，由客户端维护上下文。
    const round2Body = {
        model,
        input: history,
        store: false,
    };

    console.log("\n>>> ROUND 2 REQUEST");
    console.log(JSON.stringify(round2Body, null, 2));

    const resp2 = await client.responses.create(round2Body);

    console.log("\n<<< ROUND 2 RESPONSE");
    console.log(`\nRound 2 output_text: ${resp2.output_text}`);
}