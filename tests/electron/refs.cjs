const assert = require('node:assert/strict')
module.exports = async (call, view) => {
  await call('eval', { code: `const nav=document.createElement('nav');nav.id='ref-test-nav';nav.innerHTML=Array.from({length:75},(_,i)=>'<a href="/nav/'+i+'">Navigation '+i+'</a>').join('');document.body.prepend(nav);true` })
  const list = await call('read', { mode: 'elements' })
  const input = list.elements.find(el => el.name === 'Name' || el.tag === 'input' && el.type !== 'password')
  const button = list.elements.find(el => el.tag === 'button' && el.text === 'Save')
  assert.ok(list.elements.indexOf(input) >= 75 && list.elements.indexOf(button) >= 75)
  await call('act', { action: 'type', ref: input.ref, text: 'Ref fixture', inputMode: 'native' })
  const observation = await call('snapshot', { afterAction: true, focusRef: input.ref, maxChars: 3000, maxElements: 40 })
  assert.equal(observation.region.target.tag, 'form')
  assert.ok(observation.elements.some(el => el.ref === button.ref))
  assert.ok(!observation.text.includes('Navigation 0'))
  const scoped = await call('read', { mode: 'elements', selector: '#form', maxElements: 1 })
  assert.equal(scoped.elements.length, 1)
  assert.equal(scoped.truncated, true)
  const deadline = Date.now() + 2500
  while (true) {
    try { await view.capturePage(); break }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)) }
  }
  await call('act', { action: 'click', ref: button.ref, inputMode: 'native' })
  assert.ok((await call('read', { selector: '#result' })).text.includes('Saved Ref fixture'))
  const loaded = new Promise(resolve => view.addEventListener('did-finish-load', resolve, { once: true }))
  view.reload(); await loaded
  const old = await call('inspect', { ref: button.ref }).then(() => null, error => error)
  assert.match(old.message, /unknown-ref|stale/)
  return { menuDisplacementFixed: true, nativeTypeAndClickWithOriginalRefs: true, scopedObservation: true,
    omittedRefsPreserved: true, navigationRefsRejected: true }
}
