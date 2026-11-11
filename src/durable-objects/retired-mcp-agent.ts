import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.d";

/**
 * The MCP server used to run inside this Durable Object. It is stateless now, so nothing
 * routes here; the class stays bound until a `deleted_classes` migration removes it,
 * because that migration permanently deletes the old MCP session storage.
 */
export class MahoragaMcpAgent extends DurableObject<Env> {}
