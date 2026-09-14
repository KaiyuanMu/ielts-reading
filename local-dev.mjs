import worker from "./src/worker.js";
import { createServer } from "node:http";

const server = createServer(async (req, res) => {
  const url = `http://127.0.0.1:8787${req.url}`;
  const request = new Request(url, { method: req.method, headers: req.headers });
  const response = await worker.fetch(request, {}, {});
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(8787, "127.0.0.1", () => {
  console.log("IELTS vocab online preview: http://127.0.0.1:8787");
});
