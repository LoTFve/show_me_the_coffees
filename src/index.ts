#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { LocalStore } from "./store.js";
import { McpUpstream } from "./upstream.js";

const config = loadConfig();
const server = createServer({
  config,
  store: new LocalStore(config.dataDir),
  connect: (token) => McpUpstream.http(config.upstreamUrl, token),
});
await server.connect(new StdioServerTransport());
