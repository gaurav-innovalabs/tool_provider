import "./src/config"; // validate env first, same as index.ts/worker.ts
import { startMcpServer } from "./src/mcp/server";

// No console.log here on purpose — stdout is the MCP transport itself (StdioServerTransport). Anything
// printed to stdout that isn't a JSON-RPC message breaks the protocol. Use console.error if a startup log
// is ever needed (stderr is safe, MCP clients typically surface it as server logs).
await startMcpServer();
