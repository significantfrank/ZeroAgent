import OpenAI from "openai";

export async function runAbortControllerDemo(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error("Please set OPENAI_API_KEY in .env");
        process.exit(1);
    }

    const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const client = new OpenAI({ apiKey, baseURL });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const controller = new AbortController();
    const abortAfterMs = 1_500;
    let outputText = "";

    const requestBody = {
        model,
        input: "写一篇较长的文章，介绍人工智能的发展历史、当前应用和未来挑战。",
        stream: true as const,
        store: false,
    };

    console.log("=".repeat(80));
    console.log("AbortController Demo");
    console.log("=".repeat(80));
    console.log(`Endpoint: POST ${baseURL.replace(/\/$/, "")}/responses`);
    console.log(`Model:    ${model}`);
    console.log(`Abort after: ${abortAfterMs} ms`);
    console.log("\n>>> REQUEST");
    console.log(JSON.stringify(requestBody, null, 2));
    console.log("\n<<< STREAM");

    const abortTimer = setTimeout(() => {
        console.log("\n\n[AbortController] Cancelling the request...");
        controller.abort();
    }, abortAfterMs);

    try {
        const stream = await client.responses.create(requestBody, {
            signal: controller.signal,
        });

        for await (const event of stream) {
            if (event.type === "response.output_text.delta") {
                outputText += event.delta;
                process.stdout.write(event.delta);
            }
        }

        if (controller.signal.aborted) {
            console.log("\nRequest was cancelled by AbortController.");
            console.log(`Received ${outputText.length} characters before cancellation.`);
        } else {
            console.log("\n\nRequest completed before it was cancelled.");
        }
    } catch (error) {
        if (controller.signal.aborted) {
            console.log("\nRequest was cancelled by AbortController.");
            console.log(`Received ${outputText.length} characters before cancellation.`);
        } else {
            console.error("\nRequest failed:", error);
        }
    } finally {
        clearTimeout(abortTimer);
    }
}