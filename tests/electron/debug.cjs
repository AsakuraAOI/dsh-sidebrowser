const assert = require('node:assert/strict')

module.exports = async function debugChecks(call, view, provider) {
  const start = await call('debug', { action: 'start', captureBodies: true })
  assert.equal(start.capabilities.nativeCDP, false)
  await call('eval', { code: `window.getterCalls=0;window.loggedObject={answer:42};loggedObject.self=loggedObject;Object.defineProperty(loggedObject,'danger',{get(){getterCalls++;return 'bad'},enumerable:true});console.log('object-fixture',loggedObject);loggedObject.answer=43` })
  const structured = await call('console', { source: 'structured' })
  const objectId = structured.entries.find(row => row.message.includes('object-fixture')).args[1].objectId
  const object = await call('console', { objectId })
  assert.equal(object.properties.find(p => p.name === 'answer').value.value, 43)
  assert.equal(object.properties.find(p => p.name === 'danger').accessor, true)
  assert.equal((await call('eval', { code: 'getterCalls' })).value, 0)
  await call('eval', { code: `(async()=>{
    console.warn('native-console-fixture');
    setTimeout(()=>{throw new Error('uncaught-debug-fixture')},0);
    Promise.reject(new Error('rejection-debug-fixture'));
    const response=await fetch('/api?token=private-query',{method:'POST',headers:{Authorization:'private-header'},body:'request-debug-fixture'});
    const text=await response.text(); if(!text.includes('POST')) throw new Error('application body was consumed');
    await fetch('/api/large'); await fetch('/api/error');
    try{await fetch('/offline')}catch{}
    await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST','/api/xhr');xhr.setRequestHeader('X-Test','xhr');xhr.onload=()=>xhr.responseText.includes('POST')?resolve():reject(new Error('bad XHR'));xhr.onerror=reject;xhr.send('xhr-request-fixture')});
    await new Promise((resolve,reject)=>{const ws=new WebSocket(location.origin.replace('http','ws')+'/ws');ws.onopen=()=>ws.send('websocket-fixture');ws.onmessage=e=>{if(e.data!=='websocket-fixture'){reject(new Error('bad WebSocket'));return}ws.close();resolve()};ws.onerror=()=>reject(new Error('WebSocket failed'))});
    await new Promise((resolve,reject)=>{const source=new EventSource('/events');let normal=false;source.onmessage=e=>{normal=e.data==='sse-default-fixture'};source.addEventListener('detail',e=>{source.close();if(normal&&e.data==='sse-named-fixture')resolve();else reject(new Error('bad SSE'))});source.onerror=()=>{source.close();reject(new Error('SSE failed'))}});
    if(!navigator.sendBeacon('/beacon','beacon-fixture'))throw new Error('Beacon not queued');
    return true;
  })()` })
  let network, logs
  const deadline = Date.now() + 4000
  while (true) {
    network = await call('network'); logs = await call('console')
    if (network.requests.filter(row => row.source === 'fetch' || row.source === 'xhr').length >= 5
      && logs.entries.some(row => row.source === 'unhandled-rejection')) break
    if (Date.now() >= deadline) throw new Error('Debug capture not ready: ' + JSON.stringify({ network, logs }))
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(logs.entries.some(row => row.source === 'electron-console' && row.message.includes('native-console-fixture')))
  assert.ok(logs.entries.some(row => row.source === 'page-error' && row.message.includes('uncaught-debug-fixture')))
  assert.ok(!JSON.stringify(network.requests).includes('private-query'))
  const post = network.requests.find(row => row.method === 'POST' && row.source === 'fetch')
  let detail
  while (true) {
    detail = await call('network', { requestId: post.id })
    if (detail.request.responseBody?.text) break
    if (Date.now() >= deadline) throw new Error('Body capture not ready')
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  assert.equal(detail.request.requestHeaders.authorization, '[redacted]')
  assert.equal(detail.request.requestBody.text, 'request-debug-fixture')
  assert.ok(detail.request.responseBody.text.includes('POST'))
  const xhr = network.requests.find(row => row.source === 'xhr')
  const xhrDetail = await call('network', { requestId: xhr.id })
  assert.equal(xhrDetail.request.requestBody.text, 'xhr-request-fixture')
  assert.ok(xhrDetail.request.responseBody.text.includes('POST'))
  const large = network.requests.find(row => row.url.endsWith('/api/large'))
  const largeDetail = await call('network', { requestId: large.id, maxChars: 30000 })
  assert.equal(largeDetail.request.responseBody.text.length, 16384)
  assert.equal(largeDetail.request.responseBody.truncated, true)
  assert.ok(network.requests.some(row => row.state === 'failed'))
  assert.ok(network.requests.some(row => row.status === 503 && row.state === 'complete'))
  const sockets = network.requests.find(row => row.source === 'websocket')
  const socketDetail = await call('network', { requestId: sockets.id })
  assert.ok(socketDetail.request.events.some(row => row.type === 'sent' && row.data.text === 'websocket-fixture'))
  assert.ok(socketDetail.request.events.some(row => row.type === 'received' && row.data.text === 'websocket-fixture'))
  const stream = network.requests.find(row => row.source === 'eventsource')
  const streamDetail = await call('network', { requestId: stream.id })
  assert.ok(streamDetail.request.events.some(row => row.type === 'detail' && row.data.text === 'sse-named-fixture'))
  const beacon = network.requests.find(row => row.source === 'beacon')
  assert.equal(beacon.state, 'queued')
  assert.equal(beacon.serverReceiptVerified, false)
  assert.equal(view.isDevToolsOpened(), false)
  const loaded = new Promise(resolve => view.addEventListener('did-finish-load', resolve, { once: true }))
  view.reload(); await loaded
  await call('debug', { action: 'status' })
  await call('eval', { code: 'fetch("/api/after-reload")' })
  assert.ok((await call('network')).requests.some(row => row.url.endsWith('/api/after-reload')))
  await call('debug', { action: 'clear' })
  assert.equal((await call('network')).requests.length, 0)
  await call('eval', { code: 'window.preStopFetch=fetch;window.preStopSend=XMLHttpRequest.prototype.send' })
  const stopped = await call('debug', { action: 'stop' })
  assert.equal(stopped.pageHooksRestored, true)
  assert.equal((await call('eval', { code: 'fetch===window.preStopFetch || XMLHttpRequest.prototype.send===window.preStopSend' })).value, false)
  assert.equal(provider.debug.states.size, 0)
  return { console: true, uncaughtError: true, unhandledRejection: true, fetch: true, xhr: true, bodyPreview: true,
    bodyTruncation: true, transportFailure: true, httpError: true, navigationReattach: true,
    clearAndRestore: true, guestDevToolsDisabled: true, openedDevTools: false,
    structuredConsole: true, liveObjectHandles: true, getterNotExecuted: true, websocket: true, namedEventSource: true, beaconAttempt: true }
}
