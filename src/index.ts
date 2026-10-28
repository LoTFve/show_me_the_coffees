#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { LocalStore } from "./store.js";
import { McpUpstream } from "./upstream.js";

const config = loadConfig();
const upstream = config.upstreamUrl ? McpUpstream.http(config.upstreamUrl, config.upstreamToken) : undefined;
const server = createServer({ config, store: new LocalStore(config.dataDir), upstream });
await server.connect(new StdioServerTransport());
