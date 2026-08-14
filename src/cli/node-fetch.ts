import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { assertPublicIpAddress, type FetchImplementation } from "../shared/guarded-fetch.js";

export type ResolvedAddress = {
  address: string;
  family: number;
};

export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const resolveHost: HostResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

function publicLookup(resolve: HostResolver): LookupFunction {
  return (hostname, options, callback) => {
    void resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new Error(`DNS returned no addresses for ${hostname}.`), "", 0);
          return;
        }
        try {
          for (const address of addresses) {
            assertPublicIpAddress(address.address);
          }
        } catch (error) {
          callback(error instanceof Error ? error : new Error("DNS address was rejected."), "", 0);
          return;
        }

        if (options.all) {
          callback(null, [...addresses]);
          return;
        }
        const first = addresses[0];
        if (!first) {
          callback(new Error(`DNS returned no addresses for ${hostname}.`), "", 0);
          return;
        }
        callback(null, first.address, first.family);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error("DNS lookup failed."), "", 0);
      },
    );
  };
}

async function assertPublicHostname(hostname: string, resolve: HostResolver): Promise<void> {
  const addresses = await resolve(hostname);
  if (addresses.length === 0) {
    throw new Error(`DNS returned no addresses for ${hostname}.`);
  }
  for (const address of addresses) {
    assertPublicIpAddress(address.address);
  }
}

export function createNodeFetch(resolve: HostResolver = resolveHost): FetchImplementation {
  const dispatcher = new Agent({ connect: { lookup: publicLookup(resolve) } });
  return async (input, init) => {
    await assertPublicHostname(input.hostname, resolve);
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
      throw new Error("The Node fetch bridge only supports string request bodies.");
    }
    const response = await undiciFetch(input, {
      ...(init.method === undefined ? {} : { method: init.method }),
      headers: Object.fromEntries(new Headers(init.headers)),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
      ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
      ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
      dispatcher,
    });
    // Undici's web types are structurally equivalent at runtime but come from node:stream/web.
    return response as unknown as Response;
  };
}
