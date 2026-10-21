/**
 * A demo MCP server for trying MCP in CodeConClave on your own computer.
 *
 *   node ../node_modules/tsx/dist/cli.mjs src/scripts/mcp-demo-server.ts   (from backend/)
 *
 * It speaks the real MCP protocol (Streamable HTTP) and offers four notes
 * tools: echo (read-only), create_note (asks first), delete_all (changes data,
 * always asks) and inject (returns text that tries to hijack the AI, to show the
 * Injection Shield). Nothing is stored; it is for local testing only and only
 * listens on 127.0.0.1. Port: MCP_DEMO_PORT (default 8765).
 */
import { startFakeMcpServer } from '../modules/mcp/testutil.js';

const port = Number(process.env.MCP_DEMO_PORT ?? 8765);
const server = await startFakeMcpServer({ port, sse: true }).catch((err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is busy. Set MCP_DEMO_PORT to another port.` : err.message);
  process.exit(1);
});

console.log('CodeConClave demo MCP server is running.');
console.log(`  URL to paste in Settings → Customize → MCP servers:  ${server.url}`);
console.log('  Tools: echo (read-only), create_note (asks first), delete_all (always asks), inject (Injection Shield demo)');
console.log('  Press Ctrl+C to stop.');

const stop = () => void server.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
