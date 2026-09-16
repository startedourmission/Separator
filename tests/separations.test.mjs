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


test('cursor totals include every spot plate in both viewer paths, including totals above 400%', async () => {
    const v=viewer();
    assert.equal(v.calculateTAC({cyan:100,magenta:100,yellow:100,black:100},{SpotA:100,SpotB:75}),575);
    const process={cyan:0,magenta:0,yellow:0,black:100};
    assert.equal(v.calculateTAC(process),100);
    const imageData={type:'cmyk',width:1,height:1,channels:Object.fromEntries(
        Object.entries(process).map(([name,value])=>[name,Uint8Array.of(value*2.55)]))};
    imageData.channels.black[0]=255;
    const canvas={width:1,height:1,getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})};
    Object.assign(v,{
        currentPDF:true,canvas,baseWidth:1,baseHeight:1,zoomLevel:1,
        originalCMYKData:imageData,spotColors:['SpotA','SpotB'],
        tacValueElement:{textContent:''},cursorCoordsElement:{textContent:''},
        updateChannelInkInfo:()=>{},updateSpotColorInkInfo:()=>{}
    });
    for(const [spots,expected] of [
        [{SpotA:Uint8Array.of(255),SpotB:Uint8Array.of(128)},'250.2'],
        [{SpotA:Uint8Array.of(255)},'200.0'],
        [{},'100.0']
    ]) {
        v.spotColorData=spots;
        const event={clientX:50,clientY:50};
        v.handleCanvasMouseMove(event,1,canvas,{imageData,spotColorData:spots});
        assert.equal(v.tacValueElement.textContent,expected);
        v.tacValueElement.textContent='';
        await v.handleMouseMove(event);
        assert.equal(v.tacValueElement.textContent,expected);
    }
});


test('cover auto calculation waits for metadata and render, then runs once', async () => {
    const v=viewer(), doc={};let calls=0;
    Object.assign(v,{
        currentPDFData:doc,currentFileType:'pdf',currentPage:1,
        autoCoverCalculation:{document:doc,ready:false,status:'pending'},
        scrollManager:{pageElements:new Map([[1,{status:'loading'}]])},pageMetadata:new Map(),
        detectCropMarks:async options=>{assert.equal(options.automatic,true);calls++;}
    });
    v.maybeAutoCalculateCover();assert.equal(calls,0);
    v.autoCoverCalculation.ready=true;v.pageMetadata.set(1,{});
    v.maybeAutoCalculateCover();assert.equal(v.autoCoverCalculation.status,'pending');
    v.scrollManager.pageElements.set(1,{status:'rendered',pageData:{}});
    v.maybeAutoCalculateCover();v.maybeAutoCalculateCover();
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(calls,1);assert.equal(v.autoCoverCalculation.status,'done');
    v.maybeAutoCalculateCover();assert.equal(calls,1);
    v.autoCoverCalculation.status='pending';v.maybeAutoCalculateCover();
    v.autoCoverCalculation={document:{},ready:false,status:'pending'};
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(calls,1,'a replaced document must cancel scheduled analysis');
});

test('a PDF without crop marks shows its TrimBox dimensions without guessed book parts', () => {
    const v=viewer();
    Object.assign(v,{currentPage:1,finalMarks:[],calcResultElement:{textContent:''},
        pageMetadata:new Map([[1,{trimBox:{width:720,height:360}}]])});
    v.calculateCoverSpread();
    assert.equal(v.calcResultElement.textContent,'펼침면 너비 : 254.00 x 127.00 mm');
});

test('coverage warnings use strict thresholds and include hidden spot plates', () => {
    const channels={cyan:Uint8Array.of(255,255,255,255),magenta:Uint8Array.of(255,255,255,255),
        yellow:Uint8Array.of(255,255,255,255),black:Uint8Array.of(0,102,153,0)};
    const data={width:4,height:1,channels},spots={TestGreen:Uint8Array.of(0,0,0,255)};
    const hidden={cyan:false,magenta:false,yellow:false,black:false,spotColors:{}};
    const render=limit=>[...compositeSeparations(data,spots,hidden,new Uint8ClampedArray(16),{},limit)];
    const red=[255,35,35,255],white=[255,255,255,255];
    assert.deepEqual(render(300),[...white,...red,...red,...red]);
    assert.deepEqual(render(350),[...white,...white,...red,...red]);
    assert.deepEqual(render(0),[...white,...white,...white,...white]);
    assert.equal(spots.TestGreen[3],255,'warnings must not alter original plate values');
});
