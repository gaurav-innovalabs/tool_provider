import "./src/config"; // validate env first — throws immediately on a missing/malformed required var
import { createServer } from "./src/server";

const server = createServer();
console.log(`listening on ${server.url}`);
console.log("trigger polling/delivery runs in a separate process — see worker.ts (`bun run worker`)");
