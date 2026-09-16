import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { overprintPDF } from './pdf-fixture.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const artifacts=path.join(root,'_docs/overprint-verification');
await fs.mkdir(artifacts,{recursive:true});
const server=http.createServer(async(req,res)=>{
    try {
        const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
        const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
        if(!file.startsWith(root)) {res.writeHead(403).end();return;}
        const data=await fs.readFile(file);
        res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.css':'text/css'})[path.extname(file)]||'application/octet-stream');
        res.end(data);
    } catch {res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})})
    .catch(error=>{server.close();throw error;});
const errors=[];
try {
    const page=await browser.newPage({viewport:{width:1600,height:1000},ignoreHTTPSErrors:true});
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>window.viewer?.ghostscript&&viewer.workerPool?.initialized);
    await page.evaluate(()=>{viewer.renderDPI=72;});
    async function settled(){
        await page.waitForFunction(()=>{
            const v=window.viewer, el=v.scrollManager.pageElements.get(1);
            return el?.status==='rendered' && v.isCurrentPageData(el.pageData) && v.currentVariant().scanned;
        },null,{timeout:60000});
    }
    async function toggle(on){await page.locator('#overprint-preview').setChecked(on);await settled();}
    async function sample(){return page.evaluate(()=>{
        const v=viewer,el=v.scrollManager.pageElements.get(1),data=el.pageData.imageData;
        const x=Math.round(data.width/2),y=Math.round(data.height/2),i=y*data.width+x;
        return {ink:Object.fromEntries(Object.entries(data.channels).map(([n,a])=>[n,a[i]])),
            spots:Object.fromEntries(Object.entries(el.pageData.spotColorData).map(([n,a])=>[n,a[i]])),
            rgb:[...el.canvas.getContext('2d').getImageData(x,y,1,1).data],
            ratios:v.calculateTotalChannelRatios(),spotRatios:v.calculateSpotColorRatios()};
    });}
    async function exportPixel(){return page.evaluate(async()=>{
        const im=await viewer.ghostscript.renderPage(1,{dpi:72,width:120,height:60,pdfWidth:120,pdfHeight:60,opaque:true});
        return [...im.data.slice((30*120+60)*4,(30*120+60)*4+4)];
    });}
    const results={};
    for(const spot of [true,false]) {
        await page.locator('#overprint-preview').setChecked(true);
        await page.locator('#pdf-file').setInputFiles({name:`${spot?'spot':'process'}.pdf`,mimeType:'application/pdf',buffer:overprintPDF(spot)});
        await settled();
        const on=await sample(),rgbOn=await exportPixel();
        assert.equal(on.ink.black,255);
        assert.equal(spot?on.spots.TestGreen:on.ink.cyan,255);
        assert.ok(Math.max(...on.rgb.slice(0,3))<60,'black should remain visible under the spot');
        await toggle(false);
        const off=await sample(),rgbOff=await exportPixel();
        assert.equal(off.ink.black,255);
        assert.equal(spot?off.spots.TestGreen:off.ink.cyan,0);
        assert.notDeepEqual(rgbOn,rgbOff,'RGB export must honor overprint');
        assert.notDeepEqual(spot?on.spotRatios:on.ratios,spot?off.spotRatios:off.ratios,'scan totals must honor overprint');
        // Cached measurements and page renders must return to the same ON result.
        await toggle(true);assert.deepEqual(await sample(),on);
        // Rapid transitions deliberately leave renders in flight.
        await page.evaluate(()=>{
            const cb=document.getElementById('overprint-preview');
            for(const value of [false,true,false]){cb.checked=value;cb.dispatchEvent(new Event('change'));}
        });
        await settled();assert.deepEqual(await sample(),off);
        // Both annotation variants must retain the selected overprint setting.
        await page.locator('#exclude-annotations').setChecked(false);await settled();
        assert.deepEqual(await sample(),off);
        await toggle(true);assert.deepEqual(await sample(),on);
        await page.locator('#exclude-annotations').setChecked(true);await settled();
        assert.deepEqual(await sample(),on);
        results[spot?'spot':'process']={on,off,rgbOn,rgbOff};
        console.log(`PASS ${spot?'spot':'process'}: ON/OFF plates, scan, RGB export, cached return, rapid toggles`);
    }
    // Exercise the fallback worker without a pool as well.
    await page.evaluate(()=>{window.savedPool=viewer.workerPool;viewer.workerPool=null;});
    await toggle(true);assert.equal((await sample()).ink.cyan,255);
    await toggle(false);assert.equal((await sample()).ink.cyan,0);
    await page.evaluate(()=>{viewer.workerPool=window.savedPool;});
    console.log('PASS single-worker fallback');

    const cover=path.join(root,'higs_cover.pdf');
    if(await fs.stat(cover).catch(()=>null)) {
        await page.locator('#overprint-preview').setChecked(true);
        await page.evaluate(()=>{viewer.renderDPI=300;});
        await page.locator('#pdf-file').setInputFiles(cover);
        await settled();
        await page.waitForFunction(()=>viewer.spotColors.includes('PANTONE 2285 C'));
        const coverSamples=await page.evaluate(()=>{
            const el=viewer.scrollManager.pageElements.get(1),im=el.pageData.imageData;
            return [[430,188],[430,400],[1410,698]].map(([x,y])=>{
                x=Math.round(x*im.width/2000);y=Math.round(y*im.width/2000);const i=y*im.width+x;
                return {k:im.channels.black[i],spot:el.pageData.spotColorData['PANTONE 2285 C'][i],rgb:[...el.canvas.getContext('2d').getImageData(x,y,1,1).data]};
            });
        });
        for(const p of coverSamples){assert.equal(p.k,255);assert.equal(p.spot,255);assert.ok(Math.max(...p.rgb.slice(0,3))<65);}
        const image=await page.evaluate(()=>viewer.scrollManager.pageElements.get(1).canvas.toDataURL());
        await fs.writeFile(path.join(artifacts,'higs-overprint-on.png'),Buffer.from(image.split(',')[1],'base64'));
        await page.screenshot({path:path.join(artifacts,'viewer.png')});
        await toggle(false);
        const offImage=await page.evaluate(()=>viewer.scrollManager.pageElements.get(1).canvas.toDataURL());
        await fs.writeFile(path.join(artifacts,'higs-overprint-off.png'),Buffer.from(offImage.split(',')[1],'base64'));
        results.coverSamples=coverSamples;
        console.log('PASS higs_cover.pdf: all three reported regions retain black');
    }
    assert.deepEqual(errors,[],'browser errors');
    await fs.writeFile(path.join(artifacts,'results.json'),JSON.stringify(results,null,2));
} finally {
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
}
