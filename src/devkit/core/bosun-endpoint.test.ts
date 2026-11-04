import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createServer } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { bosunEndpoint } from "./bosun-endpoint.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bosun-endpoint-"));
const endpoint = path.join(scratch, "endpoint.json");

afterEach(() => {
  delete process.env.BOSUN_ENDPOINT;
  fs.rmSync(endpoint, { force: true });
});

const serve = async () => {
  const server = await createServer({
    root: scratch,
    configFile: false,
    logLevel: "silent",
    plugins: [bosunEndpoint()],
    server: { port: 0, host: "localhost" },
  });
  await server.listen();
  return server;
};

describe("bosunEndpoint", () => {
  it("writes the port Vite listens on, and its URL, to BOSUN_ENDPOINT", async () => {
    process.env.BOSUN_ENDPOINT = endpoint;
    const server = await serve();
    try {
      const address = server.httpServer?.address();
      const port = typeof address === "object" ? address?.port : undefined;
      expect(JSON.parse(fs.readFileSync(endpoint, "utf8"))).toEqual({
        port,
        url: `http://localhost:${String(port)}/`,
      });
    } finally {
      await server.close();
    }
  });

  it("writes nothing outside bosun", async () => {
    const server = await serve();
    await server.close();
    expect(fs.existsSync(endpoint)).toBe(false);
  });
});
