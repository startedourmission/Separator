import { warmUpColorProfile } from '../color-profile.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { compositeSeparations } from '../separation-renderer.js';
import { registerSpotColorRGB } from '../constants.js';
import { PDFSeparationViewer } from '../PDFSeparationViewer.js';
import { VirtualScrollManager } from '../VirtualScrollManager.js';

await warmUpColorProfile();
registerSpotColorRGB('TestGreen', {r: 150, g: 180, b: 70});
const all = {cyan: true, magenta: true, yellow: true, black: true, spotColors: {TestGreen: true}};
function pixel([c, m, y, k], tint, settings = all) {
    const data = {width: 1, height: 1, channels: Object.fromEntries(
        ['cyan', 'magenta', 'yellow', 'black'].map((name, i) => [name, Uint8Array.of([c,m,y,k][i])]))};
    return [...compositeSeparations(data, {TestGreen: Uint8Array.of(tint)}, settings, new Uint8ClampedArray(4))];
}

test('100% spot preserves underlying black; knockout and white remain distinct', () => {
    const overlap = pixel([0,0,0,255], 255);
    const spotOnly = pixel([0,0,0,0], 255);
    const blackOnly = pixel([0,0,0,255], 0);
    assert.deepEqual(spotOnly, [150,180,70,255]);
    assert.ok(overlap.slice(0,3).every((v,i) => v < spotOnly[i] && v <= blackOnly[i]));
    assert.deepEqual(pixel([0,0,0,0],0), [255,255,255,255]);
});

test('process cyan is retained under a spot; toggles isolate existing ink plates', () => {
    const both = pixel([255,0,0,0],128);
    const noCyan = pixel([255,0,0,0],128,{...all,cyan:false});
    assert.ok(both[0] < noCyan[0]);
    assert.deepEqual(pixel([255,0,0,0],255,{...all,spotColors:{}}), pixel([255,0,0,0],0));
    assert.deepEqual(pixel([0,0,0,255],255,{...all,black:false}), pixel([0,0,0,0],255));
});

function viewer() {
    return Object.assign(Object.create(PDFSeparationViewer.prototype), {
        scanVariants: {}, excludeAnnotations: true, overprintPreview: true,
        renderGeneration: 0, scanGeneration: 0, pageCache: new Map(),
        pagePreviews: new Map(), preloadingPages: new Set(), pageCacheSize: 5
    });
}

test('annotation and overprint combinations have independent measurements', () => {
    const v=viewer(), variants=new Set();
    for(const annotations of [true,false]) for(const overprint of [true,false]) {
        v.excludeAnnotations=annotations; v.overprintPreview=overprint;
        variants.add(v.currentVariant());
    }
    assert.equal(variants.size,4);
    v.excludeAnnotations=true;v.overprintPreview=true;
    const original=v.currentVariant();original.scanned=true;
    v.overprintPreview=false;assert.equal(v.currentVariant().scanned,false);
    v.overprintPreview=true;assert.equal(v.currentVariant(),original);
});

test('late render and inactive scan previews cannot populate the active cache', () => {
    const v=viewer(), old=v.currentVariant(), page={renderGeneration:0};
    v.clearPageCache();v.addToCache(1,page);assert.equal(v.pageCache.size,0);
    v.addToCache(1,{renderGeneration:1});assert.equal(v.pageCache.size,1);
    v.overprintPreview=false;
    const data={type:'cmyk',width:1,height:1,channels:{cyan:[0],magenta:[0],yellow:[0],black:[255]}};
    v.storePagePreview(1,data,null,old);assert.equal(v.pagePreviews.size,0);
    v.storePagePreview(1,data);assert.equal(v.pagePreviews.size,1);
});

test('a render finishing after a setting switch cannot paint its old page', async () => {
    const v=viewer();let finish;
    v.renderPageData=()=>new Promise(resolve=>{finish=resolve;});
    const el={status:'placeholder',wrapper:{}};
    const sm=Object.assign(Object.create(VirtualScrollManager.prototype),{viewer:v,pageElements:new Map([[1,el]])});
    sm.renderToCanvas=()=>assert.fail('stale result painted');
    const pending=sm.renderPage(1);
    v.clearPageCache();el.renderToken=null;
    finish({renderGeneration:0});await pending;
    assert.equal(v.pageCache.size,0);
});

test('single-page mode does not prepare comparisons for display:none pages', () => {
    const manager = Object.assign(Object.create(VirtualScrollManager.prototype), {
        viewport: {getBoundingClientRect: () => ({top:20,bottom:800})}
    });
    const wrapper = rect => ({getBoundingClientRect: () => rect});
    assert.equal(manager.isWrapperInViewport(wrapper({top:0,bottom:0,width:0,height:0})),false);
    assert.equal(manager.isWrapperInViewport(wrapper({top:100,bottom:500,width:800,height:400})),true);
});


test('late results from the other overprint mode cannot enter the selected page cache', () => {
    const v = viewer();
    const old = {renderGeneration:0, renderSettings:{excludeAnnots:true,overprint:true}};
    v.overprintPreview = false;
    v.addToCache(1, old);
    assert.equal(v.pageCache.size, 0);
    v.addToCache(1, {...old, renderSettings:{excludeAnnots:true,overprint:false}});
    assert.equal(v.pageCache.size, 1);
});
