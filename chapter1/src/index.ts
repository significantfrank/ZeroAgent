import "dotenv/config";
import { runAbortControllerDemo } from "./abort-controller-demo";
import { runStoreDemo } from "./store-demo";
import { runStoreClientDemo } from "./store-client-demo";
import { runStructuredOutputDemo } from "./structured-output-demo";
import { runStreamDemo } from "./stream-demo";
import { runFunctionCallingDemo } from "./function-calling-demo";

const demo = process.argv[2] ?? "logging";
const userInput = process.argv[3];

async function main(): Promise<void> {
  switch (demo) {
    case "abort":
      await runAbortControllerDemo();
      break;
    case "store":
      await runStoreDemo();
      break;
    case "store-client":
      await runStoreClientDemo();
      break;
    case "structured":
      await runStructuredOutputDemo();
      break;
    case "stream":
      await runStreamDemo();
      break;
    case "calling":
      await runFunctionCallingDemo();
      break;
    default:
      console.error(`Unknown demo: ${demo}`);
      console.error("Usage: npm start -- [abort|logging|store|store-client|structured|stream|calling] [question]");
      process.exit(1);
  }
}

void main();
