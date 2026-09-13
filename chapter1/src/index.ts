import "dotenv/config";
import { runLoggingDemo } from "./logging-demo";
import { runStoreDemo } from "./store-demo";
import { runStreamDemo } from "./stream-demo";
import { runFunctionCallingDemo } from "./function-calling-demo";

const demo = process.argv[2] ?? "logging";
const userInput = process.argv[3];

async function main(): Promise<void> {
  switch (demo) {
    case "logging":
      await runLoggingDemo(userInput);
      break;
    case "store":
      await runStoreDemo();
      break;
    case "stream":
      await runStreamDemo();
      break;
    case "calling":
      await runFunctionCallingDemo();
      break;
    default:
      console.error(`Unknown demo: ${demo}`);
      console.error("Usage: npm start -- [logging|store|stream|calling] [question]");
      process.exit(1);
  }
}

void main();
