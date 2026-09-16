import test from 'node:test';
import assert from 'node:assert/strict';
import { PageRenderCache } from '../page-render-cache.js';

const page = value => ({imageData:{data:Uint8Array.of(value,0,0,255)}});

test('concurrent requests and revisiting a setting reuse one render', async () => {
    const cache = new PageRenderCache();
    let renders = 0, finish;
    const render = () => { renders++; return new Promise(resolve => { finish = resolve; }); };
    const first = cache.getOrRender('page-1:overprint', render);
    const second = cache.getOrRender('page-1:overprint', render);
    await Promise.resolve();
    finish(page(1));
    assert.equal(await first, await second);
    await cache.getOrRender('page-1:knockout', () => {renders++;return page(2);});
    assert.equal(await cache.getOrRender('page-1:overprint', render), await first);
    assert.equal(renders, 2);
});

test('cache evicts least recently used pixels at its byte budget', async () => {
    const cache = new PageRenderCache(8);
    let calls = 0;
    const get = key => cache.getOrRender(key, () => {calls++;return page(key);});
    await get(1); await get(2); await get(1); await get(3);
    assert.equal(calls,3);
    await get(1); assert.equal(calls,3);
    await get(2); assert.equal(calls,4);
    assert.ok(cache.bytes <= 8);
});

test('a document change prevents old in-flight results from repopulating the cache', async () => {
    const cache = new PageRenderCache();
    let finish;
    const pending = cache.getOrRender('same-key', () => new Promise(resolve => {finish=resolve;}));
    await Promise.resolve();
    cache.clear();
    const fresh = await cache.getOrRender('same-key', () => page(2));
    finish(page(1)); await pending;
    assert.equal(await cache.getOrRender('same-key', () => assert.fail('unexpected rerender')), fresh);
    assert.equal(cache.bytes,4);
});
