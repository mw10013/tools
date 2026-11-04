/**
 * A Vite plugin that publishes the dev server to bosun: once Vite listens, it writes
 * `{ port, url }` to the file `BOSUN_ENDPOINT` names, so `bosun start` knows where the server
 * answers and Vite keeps choosing its own port. Outside bosun (`BOSUN_ENDPOINT` unset, as under
 * Vitest) it does nothing.
 *
 * @module
 */
import { writeFileSync } from "node:fs";

import type { Plugin } from "vite";

export const bosunEndpoint = (): Plugin => ({
  name: "devkit:bosun-endpoint",
  apply: "serve",
  configureServer(server) {
    const file = process.env.BOSUN_ENDPOINT;
    if (file === undefined || server.httpServer === null) return;
    const httpServer = server.httpServer;
    httpServer.once("listening", () => {
      const address = httpServer.address();
      if (address === null || typeof address === "string") return;
      writeFileSync(
        file,
        JSON.stringify({
          port: address.port,
          url: `http://localhost:${String(address.port)}/`,
        }),
      );
    });
  },
});
