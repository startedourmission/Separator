import test from 'node:test';
import assert from 'node:assert/strict';
import { warmUpColorProfile, transformCMYK } from '../color-profile.js';
import { parseSpotCMYK } from '../spot-color.js';
import { compositeSeparations } from '../separation-renderer.js';
await warmUpColorProfile();

test('actual ICC transform matches independently generated Pillow/ImageCms patches', () => {
    // Pillow 11 / LittleCMS reference, bundled JapanColor2001Coated.icc -> sRGB,
    // relative colorimetric, BLACKPOINTCOMPENSATION | NOOPTIMIZE (8192 | 256).
    const patches=[[0,0,0,0],[255,0,0,0],[0,255,0,0],[0,0,255,0],[0,0,0,255],
        [128,128,128,128],[0,0,0,128],[100,200,50,80],[0,255,255,0]];
    const expected=[[255,255,255],[0,161,233],[228,0,127],[255,241,0],[35,25,22],
        [90,79,74],[159,159,160],[132,60,106],[230,0,19]].flat();
    const actual=transformCMYK(Uint8Array.from(patches.flat()));
    for(let i=0;i<expected.length;i++) assert.ok(Math.abs(actual[i]-expected[i])<=1,`channel ${i}: ${actual[i]} vs ${expected[i]}`);
});

test('PDF alternate ink values preserve process black and take precedence over RGB name tables', () => {
    const spotCMYK=parseSpotCMYK(['%%SeparationColor: "PANTONE 186 C" 100% ink = 16380 0 32760 0 CMYK']);
    assert.deepEqual(spotCMYK['PANTONE 186 C'],[0.5,0,1,0]);
    const channels=Object.fromEntries(['cyan','magenta','yellow','black'].map(n=>[n,Uint8Array.of(n==='black'?255:0)]));
    const rendered=compositeSeparations({width:1,height:1,channels}, {'PANTONE 186 C':Uint8Array.of(255)},
        {cyan:true,magenta:true,yellow:true,black:true,spotColors:{'PANTONE 186 C':true}},new Uint8ClampedArray(4),spotCMYK);
    assert.deepEqual([...rendered],[...transformCMYK(Uint8Array.of(128,0,255,255)),255]);
    assert.equal(channels.black[0],255);
});
