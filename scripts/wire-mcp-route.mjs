import {lstat,readFile,realpath,open,rename,unlink} from 'node:fs/promises';
import {resolve,relative,dirname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const importMarker='// WEBDECOY:MCP_IMPORT';
const routeMarker='// WEBDECOY:MCP_ROUTE';
const binding='webdecoyProtectedMCPHandler';
async function selected(root,name){
 if(typeof name!=='string'||!name.endsWith('.ts')||!/^[A-Za-z0-9_./-]+$/.test(name))throw Error('Select a relative TypeScript file');
 const path=resolve(root,name),rel=relative(root,path);
 if(resolve(name)===name||rel==='..'||rel.startsWith('..'+sep))throw Error('File must be inside the project');
 let part=root;for(const component of rel.split(sep)){part=resolve(part,component);if((await lstat(part)).isSymbolicLink())throw Error('Symlink paths unsupported');}
 const stat=await lstat(path);if(!stat.isFile()||stat.size>65536)throw Error('Expected a bounded regular file');
 return {path,rel,mode:stat.mode&0o777,text:await readFile(path,'utf8')};
}
function count(text,part){return text.split(part).length-1;}
export async function wireMCPRoute({command,project,routeFile,handlerFile}){
 if(!['plan','apply','rollback'].includes(command))throw Error('Use plan, apply or rollback');
 const root=await realpath(project),route=await selected(root,routeFile),handler=await selected(root,handlerFile);
 if(route.path===handler.path)throw Error('Route and handler must differ');
 if(route.text.includes('\r'))throw Error('This preview supports LF files; preserve CRLF files manually');
 let module=relative(dirname(route.path),handler.path).split(sep).join('/').replace(/\.ts$/,'.js');if(!module.startsWith('.'))module='./'+module;
 const importBlock=`// WEBDECOY:MCP_IMPORT_BEGIN\nimport {protectedMCPHandler as ${binding}} from '${module}';\n// WEBDECOY:MCP_IMPORT_END`;
 const routeBlock=`// WEBDECOY:MCP_ROUTE_BEGIN\nif (req.url?.split('?')[0] === '/mcp' || req.url?.split('?')[0] === '/.well-known/oauth-protected-resource/mcp') {\n  void ${binding}(req, res);\n  return;\n}\n// WEBDECOY:MCP_ROUTE_END`;
 const fresh=count(route.text,importMarker+'\n')===1&&count(route.text,routeMarker+'\n')===1&&route.text.split('\n').includes(importMarker)&&route.text.split('\n').includes(routeMarker)&&!route.text.includes(binding)&&!route.text.includes('WEBDECOY:MCP_IMPORT_BEGIN')&&!route.text.includes('WEBDECOY:MCP_ROUTE_BEGIN');
 const installed=count(route.text,importBlock)===1&&count(route.text,routeBlock)===1&&count(route.text,'WEBDECOY:MCP_IMPORT')===2&&count(route.text,'WEBDECOY:MCP_ROUTE')===2;
 if(!fresh&&!installed)throw Error('Expected exactly one pair of empty line markers or unchanged generated blocks; preserve edits manually');
 const next=command==='rollback'?(installed?route.text.replace(importBlock,importMarker).replace(routeBlock,routeMarker):route.text):(fresh?route.text.replace(importMarker,importBlock).replace(routeMarker,routeBlock):route.text);
 const report={schema:1,command,selectedRoute:route.rel,selectedHandler:handler.rel,paths:['/mcp','/.well-known/oauth-protected-resource/mcp'],coverage:'not_verified',remediation:'Compile and run local route and synthetic action checks. Markers require a Node request callback named req/res; alternate handlers remain uncovered.'};
 if(command==='plan')return {...report,status:installed?'already_wired':'proposed',changes:installed?[]:[{replace:importMarker,with:importBlock},{replace:routeMarker,with:routeBlock}]};
 if(next===route.text)return {...report,status:'unchanged'};
 const temp=route.path+'.webdecoy-'+randomUUID();
 try{
  const file=await open(temp,'wx',route.mode);try{await file.chmod(route.mode);await file.writeFile(next);await file.sync();}finally{await file.close();}
  const current=await selected(root,routeFile);
  if(current.text!==route.text)throw Error('Route changed during operation; retry plan');
  await rename(temp,route.path);
 }finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 return {...report,status:command==='rollback'?'unwired':'wired'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const [command,project,routeFile,handlerFile,...extra]=process.argv.slice(2);if(extra.length)throw Error('Unexpected arguments');console.log(JSON.stringify(await wireMCPRoute({command,project,routeFile,handlerFile}),null,2));}
 catch(e){console.error(`MCP wiring stopped: ${e.code??e.message}`);process.exitCode=1;}
}
