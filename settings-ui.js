// Embedded in this package's browser bundle; no separate settings plugin.
function decoratePluginPage(registration,options){
  const original=registration.factory;
  return {...registration,factory(require){
    const base=original(require),React=require('react'),h=React.createElement;
    const css=`.dpp-page{color:var(--dsw-alias-label-primary);font:inherit;max-width:760px}.dpp-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:16px;margin:12px 0}.dpp-card h3{margin:0 0 10px;font-size:15px}.dpp-muted{font-size:13px;color:var(--dsw-alias-label-secondary);line-height:1.6}.dpp-field{display:grid;grid-template-columns:minmax(160px,1fr) minmax(200px,1.5fr);gap:16px;margin:15px 0;align-items:start}.dpp-field label{font-size:13px;line-height:1.5;overflow-wrap:anywhere}.dpp-field small{display:block;color:var(--dsw-alias-label-secondary);font-size:11px}.dpp-input{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:7px 9px;background:var(--dsw-alias-background-base);color:inherit;font:inherit;font-size:13px}.dpp-field input[type=checkbox]{width:18px;height:18px;accent-color:var(--dsw-alias-label-primary)}.dpp-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}.dpp-button{background:var(--dsw-alias-background-base);border:1px solid var(--dsw-alias-border-l2);color:inherit;border-radius:6px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}.dpp-button:disabled{opacity:.45;cursor:default}.dpp-button:focus-visible,.dpp-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.dpp-reset{font-size:11px;padding:2px 6px;margin-top:5px}.dpp-error{color:var(--dsw-alias-state-error,#a12622);white-space:pre-wrap}.dpp-status{font-size:13px}.dpp-qr{max-width:260px;width:100%;background:white;border-radius:6px}.dpp-hint{margin-top:15px}@media(max-width:580px){.dpp-field{grid-template-columns:1fr;gap:6px}.dpp-card{padding:12px}}`;
    async function api(route,body,signal){
      const response=await fetch(route,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal});
      const data=await response.json();if(!response.ok)throw new Error(data.error||`操作失败（${response.status}）`);return data;
    }
    function inputValue(field){return field.kind==='strings'?(field.value||[]).join('\n'):field.kind==='json'?JSON.stringify(field.value??null,null,2):field.value??'';}
    function typed(field,value){
      if(field.kind==='number'){if(String(value).trim()===''||!Number.isFinite(Number(value)))throw new Error(`${field.label} 需要有效数字。`);return Number(value);}
      if(field.kind==='strings')return String(value).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
      if(field.kind==='json'){try{return JSON.parse(value);}catch{throw new Error(`${field.label} 的 JSON 格式不正确。`);}}
      if(field.kind==='choice')return field.choices.find(x=>String(x)===String(value));return value;
    }
    function Card({row,reload}){
      const [changes,setChanges]=React.useState({}),[busy,setBusy]=React.useState(false),[message,setMessage]=React.useState(''),[error,setError]=React.useState('');
      async function save(){setBusy(true);setError('');setMessage('');try{
        const ops=Object.values(changes).map(op=>op.op==='set'?{...op,value:typed(row.fields.find(f=>JSON.stringify(f.path)===JSON.stringify(op.path)),op.value)}:op);
        await api(options.route,{id:row.id,revision:row.revision,changes:ops});setChanges({});await reload();setMessage('已保存并应用');
      }catch(e){setError(e.message);}finally{setBusy(false);}}
      const title=options.titles?.[row.id]||row.id;
      return h('section',{className:'dpp-card','data-plugin-settings-entry':row.id},h('h3',null,title),!row.active?h('p',{className:'dpp-muted'},'组件未运行，请先开启此组件。'):h(React.Fragment,null,
        row.fields.map(field=>{
          const key=JSON.stringify(field.path),op=changes[key],value=op?.op==='set'?op.value:op?.op==='reset'?(field.kind==='strings'?(field.base||[]).join('\n'):field.kind==='json'?JSON.stringify(field.base??null,null,2):field.base??''):inputValue(field),id=`dpp-${options.name}-${row.id}-${field.path.join('-')}`;
          const edit=value=>{setMessage('');setChanges(s=>({...s,[key]:{op:'set',path:field.path,value}}));};
          const common={id,className:'dpp-input',disabled:busy,onChange:e=>edit(field.kind==='boolean'?e.target.checked:e.target.value)};
          const control=field.secret?h('p',{className:'dpp-muted'},field.configured?'凭据已配置；通过模型凭据管理修改。':'未配置凭据；通过模型凭据管理设置。'):field.kind==='boolean'?h('input',{...common,type:'checkbox',checked:Boolean(value)}):field.kind==='choice'?h('select',{...common,value},field.choices.map(choice=>h('option',{key:String(choice),value:String(choice)},String(choice)))):['strings','json'].includes(field.kind)?h('textarea',{...common,value,rows:3}):h('input',{...common,type:field.kind==='number'?'number':'text',value,min:field.minimum,max:field.maximum,step:field.step||'any'});
          return h('div',{className:'dpp-field',key},h('label',{htmlFor:id},field.label,field.kind==='strings'?h('small',null,'每行一项'):field.kind==='json'?h('small',null,'JSON 格式'):null),h('div',null,control,!field.secret?h('button',{className:'dpp-button dpp-reset',disabled:busy,onClick:()=>setChanges(s=>({...s,[key]:{op:'reset',path:field.path}}))},op?.op==='reset'?'待恢复默认':'恢复默认'):null));
        }),h('div',{className:'dpp-actions'},h('button',{className:'dpp-button',disabled:busy||!Object.keys(changes).length,onClick:save},busy?'保存中…':'保存'),h('button',{className:'dpp-button',disabled:busy||!Object.keys(changes).length,onClick:()=>{setChanges({});setError('');setMessage('');}},'放弃更改'),message?h('span',{className:'dpp-status',role:'status'},message):null),error?h('p',{className:'dpp-error',role:'alert'},error):null));
    }
    /* ACCOUNT_UI */
    function Page({only}){
      const [data,setData]=React.useState(null),[error,setError]=React.useState('');
      const reload=React.useCallback(async signal=>{const next=await api(options.route,undefined,signal);setData(next);setError('');},[]);
      React.useEffect(()=>{const abort=new AbortController();reload(abort.signal).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return()=>abort.abort();},[]);
      const rows=(data?.rows||[]).filter(row=>!only||row.id===only);
      return h('div',{className:'dpp-page','data-plugin-own-settings':options.name},h('p',{className:'dpp-muted'},'配置由本插件管理，保存后通过 DSH 配置编辑器应用。'),error?h('p',{className:'dpp-error',role:'alert'},error):null,!data&&!error?h('p',null,'正在读取配置…'):null,
        options.account&&!only&&typeof BilibiliAccount==='function'?h(BilibiliAccount,{autoMonitor:rows.find(r=>r.id==='bilibili-account')?.fields.find(f=>f.path[0]==='autoMonitor')?.value!==false}):null,
        rows.map(row=>h(Card,{key:row.id,row,reload})),data&&!rows.length?h('p',{className:'dpp-muted'},'该插件没有独立的运行参数；功能选项在插件自身界面中管理。'):null);
    }
    function install(ctx){
      if(!document.head||!ctx.slots?.inject||!ctx.slots?.register||typeof h!=='function')return;
      const style=document.createElement('style');style.textContent=css;document.head.appendChild(style);ctx.effect(()=>()=>style.remove());
      const slot=(key,Component)=>ctx.slots.inject('plugins.bundle.config',()=>ctx.slots.register({name:'plugins.bundle.config',key},Component));
      ctx.effect(()=>slot(options.name,()=>h(Page,{})));
      const abort=new AbortController(),disposers=[];ctx.effect(()=>()=>{abort.abort();for(const off of disposers)off?.();});
      api(options.route,undefined,abort.signal).then(data=>{if(abort.signal.aborted)return;for(const row of data.rows)disposers.push(ctx.slots.inject('plugins.row.config',()=>ctx.slots.register({name:'plugins.row.config',key:`${options.name}#${row.id}`},()=>h(Page,{only:row.id}))));}).catch(()=>{});
    }
    return {...base,inject:[...new Set([...(base.inject||[]),'slots'])],apply(ctx,...args){install(ctx);return base.apply?.(ctx,...args);}};
  }};
}
