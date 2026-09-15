import OpenAI from "openai";

type Order = {
    order_id: string;
    status: "paid" | "pending" | "cancelled";
    amount: number;
    currency: string;
};

function parseOrder(outputText: string): Order {
    const value: unknown = JSON.parse(outputText);

    if (typeof value !== "object" || value === null) {
        throw new Error("Structured output is not a JSON object");
    }

    const order = value as Record<string, unknown>;
    if (
        typeof order.order_id !== "string" ||
        !["paid", "pending", "cancelled"].includes(String(order.status)) ||
        typeof order.amount !== "number" ||
        typeof order.currency !== "string"
    ) {
        throw new Error("Structured output does not match the Order schema");
    }

    return {
        order_id: order.order_id,
        status: order.status as Order["status"],
        amount: order.amount,
        currency: order.currency,
    };
}

export async function runStructuredOutputDemo(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error("Please set OPENAI_API_KEY in .env");
        process.exit(1);
    }

    const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const client = new OpenAI({ apiKey, baseURL });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const orderSchema = {
        type: "object",
        properties: {
            order_id: { type: "string" },
            status: { type: "string", enum: ["paid", "pending", "cancelled"] },
            amount: { type: "number" },
            currency: { type: "string" },
        },
        required: ["order_id", "status", "amount", "currency"],
        additionalProperties: false,
    } as const;

    const requestBody = {
        model,
        input: "从这段文本提取订单信息：订单 A-1001 已支付，金额为 99.5 元。",
        text: {
            format: {
                type: "json_schema" as const,
                name: "order_info",
                strict: true,
                schema: orderSchema,
            },
        },
        store: false,
    };

    console.log("=".repeat(80));
    console.log("Structured Outputs Demo");
    console.log("=".repeat(80));
    console.log(`Endpoint: POST ${baseURL.replace(/\/$/, "")}/responses`);
    console.log(`Model:    ${model}`);
    console.log("\n>>> REQUEST");
    console.log(JSON.stringify(requestBody, null, 2));

    try {
        const response = await client.responses.create(requestBody);
        const order = parseOrder(response.output_text);

        console.log("\n<<< RESPONSE");
        console.log(`Raw output: ${response.output_text}`);
        console.log("\nParsed order:");
        console.log(JSON.stringify(order, null, 2));
    } catch (error) {
        console.error("\nStructured output failed:", error);
    }
}