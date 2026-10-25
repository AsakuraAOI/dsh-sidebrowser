import { createHash } from 'node:crypto';

export const PACKAGES = {"dsh-sidebrowser":"侧边栏浏览器"};
export function packageFor(moduleName = '') { return Object.keys(PACKAGES).find(name => moduleName === name || moduleName.startsWith(`${name}/`)); }
export function plain(value) {
  if (value && typeof value.get === 'function') return plain(value.get());
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
  return value;
}
function labelOf(schema, fallback) {
  const description = schema.meta?.description;
  return typeof description === 'string' ? description : description?.zh || description?.['zh-CN'] || description?.[''] || description?.en || fallback;
}
export function getPath(value, path) { return path.reduce((v, key) => v?.[key], value); }
function changePath(value, path, replacement, remove) {
  let target = value;
  for (const key of path.slice(0,-1)) { if (!target[key] || typeof target[key] !== 'object') target[key] = {}; target = target[key]; }
  if (remove) delete target[path.at(-1)]; else target[path.at(-1)] = structuredClone(replacement);
}
export function fieldsFor(schema, value, base, override, path = [], inheritedSecret = false) {
  if(schema.meta?.hidden || schema.meta?.disabled)return [];
  const secret = inheritedSecret || schema.meta?.role === 'secret';
  if (schema.type === 'object' && schema.dict && !secret) {
    return Object.entries(schema.dict).flatMap(([key, field]) => fieldsFor(field, value, base, override, [...path,key], secret));
  }
  if (!path.length || schema.meta?.hidden || schema.meta?.disabled) return [];
  const actual = getPath(value,path), inherited = getPath(base,path);
  const sensitive = secret || (typeof actual === 'string' && /^(sk[-_]|Bearer\s)/i.test(actual)) || (/(password|secret|cookie|apiKey|token)$/i.test(path.at(-1)) && !/(File|Path|Ref|Env|Enabled)$/i.test(path.at(-1)));
  const choices = schema.type === 'union' && schema.list?.every(s=>s.type === 'const') ? schema.list.map(s=>s.value) : undefined;
  const kind = ['boolean','number','string'].includes(schema.type) ? schema.type : choices ? 'choice' : schema.type === 'array' && schema.inner?.type === 'string' ? 'strings' : 'json';
  const result = { path, label: labelOf(schema,path.at(-1)), kind, secret:sensitive, overridden: getPath(override,path) !== undefined, ...(choices ? { choices } : {}), minimum: schema.meta?.min, maximum: schema.meta?.max, step: schema.meta?.step };
  if (sensitive) result.configured = actual !== undefined && actual !== '';
  else { result.value = actual; result.base = inherited; }
  return [result];
}
export function revisionFor(entry) {
  return createHash('sha256').update(JSON.stringify([entry.options.name,entry.options.config || {},entry.fiber?.uid])).digest('hex');
}
export function configurableRows(editor) {
  return editor.configuration().filter(row=>packageFor(row.entry.options.name)).map(row=>{
    const {entry,inherited,override} = row, runtime=entry.fiber?.runtime, schema=runtime?.Config;
    const active=Boolean(entry.fiber && entry.fiber.state===2 && schema?.dict);
    return { entry, inherited, override, schema, active, packageName:packageFor(entry.options.name) };
  });
}
export function describeConfiguration(editor) {
  const rows=configurableRows(editor).map(({entry,inherited,override,schema,active,packageName})=>({
    id:entry.options.id, packageName, packageLabel:PACKAGES[packageName], moduleName:entry.options.name,
    label:entry.options.id, active, revision:revisionFor(entry),
    fields:active ? fieldsFor(schema,plain(entry.fiber.config),inherited,override) : [],
  }));
  return JSON.parse(JSON.stringify({packages:Object.entries(PACKAGES).map(([id,label])=>({id,label})),rows}));
}
export async function saveConfiguration(editor,{id,revision,changes}) {
  const row=configurableRows(editor).find(row=>row.entry.options.id===id);
  if (!row?.active) throw Object.assign(new Error('此组件未运行或没有可编辑配置；请先在插件页启用。'),{status:409});
  if (!Array.isArray(changes) || !changes.length || changes.length>200) throw Object.assign(new Error('没有有效的设置变更。'),{status:400});
  const allowed=new Map(fieldsFor(row.schema,plain(row.entry.fiber.config),row.inherited,row.override).map(f=>[JSON.stringify(f.path),f]));
  for(const op of changes){
    if(!Array.isArray(op.path) || op.path.some(p=>typeof p!=='string'||['__proto__','constructor','prototype'].includes(p)) || !allowed.has(JSON.stringify(op.path)) || !['set','reset'].includes(op.op)) throw Object.assign(new Error('不允许修改该配置字段。'),{status:400});
    if(allowed.get(JSON.stringify(op.path)).secret) throw Object.assign(new Error('密钥请通过 DSH 模型凭据设置管理。'),{status:400});
  }
  await editor.edit(row.entry,(raw,inherited)=>{
    if(revisionFor(row.entry)!==revision) throw Object.assign(new Error('配置已被其他页面更改，请刷新后再保存；草稿仍保留。'),{status:409});
    const next=structuredClone(raw);
    for(const op of changes){const value=op.op==='reset'?getPath(inherited,op.path):op.value;changePath(next,op.path,value,value===undefined);}
    return next;
  });
  return {saved:true};
}

export const SETTINGS_ROUTE = "/api/plugins/dsh-sidebrowser/settings";
export function createSettingsHandler(ctx) {
  return async request => {
    const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
    try {
      if(request.method==='GET')return json(describeConfiguration(ctx.configEditor));
      if(request.method!=='POST')return json({error:'不支持此方法。'},405);
      const url=new URL(request.url),origin=request.headers.get('origin');
      if(origin&&origin!==url.origin)return json({error:'拒绝跨站设置请求。'},403);
      if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'需要 JSON 请求。'},415);
      const reader=request.body?.getReader();let length=0;const chunks=[];
      if(!reader)return json({error:'缺少请求正文。'},400);
      try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>131072){await reader.cancel();return json({error:'设置请求过大。'},413);}chunks.push(value);}}finally{reader.releaseLock();}
      return json(await saveConfiguration(ctx.configEditor,JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    }catch(error){return json({error:error.message||'配置操作失败。'},error.status||400);}
  };
}
export function registerPluginSettings(ctx) {
  ctx.inject?.(['connection','configEditor'],owner=>{
    if(!owner.connection?.fetch||!owner.configEditor)return;
    const fetch=createSettingsHandler(owner);
    owner.effect(()=>owner.connection.fetch.register({path:SETTINGS_ROUTE,methods:['GET','POST'],requestBody:'buffered',fetch}));
  });
}
