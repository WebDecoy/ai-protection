import {createServer} from 'node:http';
import {route} from './server.js';
const server=createServer(route);
server.requestTimeout=10000;server.headersTimeout=10000;
server.listen(8093,'127.0.0.1',()=>console.log('Owned synthetic MCP fixture on http://127.0.0.1:8093/mcp'));
