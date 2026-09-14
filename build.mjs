import { mkdir, copyFile } from "node:fs/promises";

await mkdir("dist/server", { recursive: true });
await copyFile("src/worker.js", "dist/server/index.js");
console.log("Built dist/server/index.js");
