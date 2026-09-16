import test from 'node:test';
import assert from 'node:assert/strict';
import {opaqueBlackPaths} from '../pdf-render-preparation.js';

const normal={fillAlpha:1,strokeAlpha:1,blend:'/Normal',mask:'/None',alphaIsShape:false};
const resolve=name=>name==='/GS0' ? normal : null;
const black='0 0 0 1 k 0 0 0 1 K /GS0 gs ';
const path='10 10 30 20 re ';

test('only proven opaque K100 vector groups qualify for the workaround',()=>{
    assert.equal(opaqueBlackPaths(black+path+'B',resolve),true);
    assert.equal(opaqueBlackPaths('% comment\n'+black+'q 1 0 0 1 10 20 cm '+path+'f Q '+path+'S',resolve),true);
    for(const source of [
        black+'1 0 0 0 k '+path+'f', // real color must retain knockout
        black+'0 0 0 .5 K '+path+'S', // different tint
        black+'1 1 1 rg '+path+'f',
        black+'/Image Do',black+'/Shading sh',black+'BT (text) Tj ET',
        '/GS0 gs '+path+'f', // inherited color is unknown
        '0 0 0 1 k '+path+'f', // inherited opacity/blend/mask unknown
        black+'/Missing gs '+path+'f',
        black+'q '+path+'f',black+'Q '+path+'f',
        black+'[1 2] 0 d '+path+'S', // unsupported syntax
        black+path+'f 2',black+path+'Unknown'
    ]) assert.equal(opaqueBlackPaths(source,resolve),false,source);
});

test('opacity, blend, masks and saved graphics state cannot bypass validation',()=>{
    for(const state of [
        {...normal,fillAlpha:.5},{...normal,strokeAlpha:.5},
        {...normal,blend:'/Multiply'},{...normal,mask:'/Mask'},
        {...normal,alphaIsShape:true}
    ]) assert.equal(opaqueBlackPaths(black+path+'B',()=>state),false);
    const resolve=name=>name==='/GS0'?normal:{fillAlpha:.5};
    assert.equal(opaqueBlackPaths(black+'q /Fade gs Q '+path+'f',resolve),true);
    assert.equal(opaqueBlackPaths(black+'q /Fade gs '+path+'f Q',resolve),false);
});
