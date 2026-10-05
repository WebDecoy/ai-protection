import type {IncomingMessage, ServerResponse} from 'node:http';
// WEBDECOY:MCP_IMPORT
export function route(req: IncomingMessage, res: ServerResponse) {
// WEBDECOY:MCP_ROUTE
 if(req.url==='/health'){res.end('fixture healthy');return;}
 res.writeHead(404);res.end('not found');
}
