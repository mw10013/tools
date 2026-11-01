/**
 * Whether a port binds right now, by binding it. Cross-platform: Node's `net`,
 * no `lsof`.
 *
 * @module
 */
import * as net from "node:net";

import * as Effect from "effect/Effect";

import { type Port } from "./domain.ts";

/**
 * Each address is probed on its own: binding the wildcard can succeed while
 * another program holds the port on loopback only, and `localhost` resolves to
 * either loopback address.
 */
const PROBE_HOSTS = ["127.0.0.1", "::1", "0.0.0.0", "::"] as const;

const bindsOn = (port: Port, host: string) =>
  Effect.callback<boolean>((resume) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES")
        resume(Effect.succeed(false));
      // An address the machine lacks (IPv6 off) cannot conflict.
      else if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT")
        resume(Effect.succeed(true));
      else resume(Effect.die(error));
    });
    server.listen({ port, host, ipv6Only: host === "::" }, () => {
      server.close(() => resume(Effect.succeed(true)));
    });
    return Effect.sync(() => server.close());
  });

/** True when every probe address binds `port`. */
export const isBindable = Effect.fn("Probe.isBindable")(function* (port: Port) {
  for (const host of PROBE_HOSTS)
    if (!(yield* bindsOn(port, host))) return false;
  return true;
});
