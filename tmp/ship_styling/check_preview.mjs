import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const path = 'C:/Users/user/.codex/visualizations/2026/11/21/01a1fe07-7060-7052-923b-5712d2782e4e/ship-styling.html';
const html = fs.readFileSync(path, 'utf8');
assert(Buffer.byteLength(html) < 1_000_000, 'Inline preview exceeds the size limit');
assert(!/<!doctype|<html|<head|<body/i.test(html), 'Expected an HTML fragment');
const elements = new Map();
for (const id of ['admiral-ship-preset','admiral-ship-condition','admiral-ship-image','admiral-ship-caption']) {
  elements.set('#'+id, {value:'', listeners:{}, addEventListener(type,fn){ this.listeners[type]=fn; }});
}
const saved = [];
const listeners = {};
const context = {
  document: {getElementById(id){
    assert.equal(id,'admiral-ship-styling');
    return {querySelector(selector){ assert(elements.has(selector)); return elements.get(selector); }};
  }},
  window: {openai: {setWidgetState(value){ saved.push(value); return Promise.resolve(); }},
    addEventListener(type,fn){ listeners[type]=fn; }},
};
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
vm.runInNewContext(script, context);
const preset=elements.get('#admiral-ship-preset');
const condition=elements.get('#admiral-ship-condition');
const picture=elements.get('#admiral-ship-image');
assert.equal(preset.value,'ru');
assert.equal(saved.length,0, 'Loading must not overwrite saved choices');
const images=new Set();
for (const state of ['intact','wreck']) {
  for (const nation of ['original','ru','se','en','nl']) {
    preset.value=nation; condition.value=state;
    preset.listeners.change();
    assert(picture.src.startsWith('data:image/jpeg;base64,'));
    const bytes=Buffer.from(picture.src.split(',')[1],'base64');
    assert.equal(bytes.readUInt16BE(0),0xffd8);
    assert(picture.alt.includes(state==='wreck'?'разбитый':'целый'));
    images.add(picture.src);
  }
}
assert.equal(images.size,10, 'Every preset and state must have its own render');
assert.equal(saved.length,10);
listeners['openai:set_globals']({detail:{globals:{widgetState:{modelContent:{style:'se',condition:'wreck'}}}}});
assert.equal(preset.value,'se');
assert.equal(condition.value,'wreck');
assert.equal(saved.length,10, 'Restoring choices must not re-save them');
console.log(JSON.stringify({bytes:Buffer.byteLength(html),renders:images.size,interactions:'passed',stateRestoration:'passed'}));
