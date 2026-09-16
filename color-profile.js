import { instantiate, TYPE_CMYK_8, TYPE_CMYK_16, TYPE_RGB_8,
    INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_BLACKPOINTCOMPENSATION,
    cmsFLAGS_NOOPTIMIZE } from './vendor/lcms/lcms.js';

// Both the CPU transform and GPU lookup use the actual bundled ICC profile.
// Relative colorimetric + black-point compensation, paper-white simulation off.
export const COLOR_PROFILE = 'Japan Color 2001 Coated';
export const LUT_SIZE = 33;
let ready, engine, transform, transform16, lut;

export function warmUpColorProfile() {
    return ready ||= (async () => {
        const url = new URL('./JapanColor2001Coated.icc', import.meta.url);
        const bytes = url.protocol === 'file:'
            ? new Uint8Array(await (await import('node:fs/promises')).readFile(url))
            : new Uint8Array(await (await fetch(url).then(r => {
                if (!r.ok) throw new Error(`ICC 프로파일 로드 실패: ${r.status}`);
                return r.arrayBuffer();
            })));
        engine = await instantiate();
        const source = engine.cmsOpenProfileFromMem(bytes, bytes.length);
        const target = engine.cmsCreate_sRGBProfile();
        if (!source || !target) throw new Error('ICC 프로파일을 열 수 없습니다.');
        const flags = cmsFLAGS_BLACKPOINTCOMPENSATION | cmsFLAGS_NOOPTIMIZE;
        transform = engine.cmsCreateTransform(source, TYPE_CMYK_8, target, TYPE_RGB_8,
            INTENT_RELATIVE_COLORIMETRIC, flags);
        transform16 = engine.cmsCreateTransform(source, TYPE_CMYK_16, target, engine.cmsFormatterForColorspaceOfProfile(target,4,true),
            INTENT_RELATIVE_COLORIMETRIC, flags);
        engine.cmsCloseProfile(source);
        engine.cmsCloseProfile(target);
        if (!transform || !transform16) throw new Error('ICC 색 변환 초기화 실패');
    })();
}

export function transformCMYK(bytes) {
    if (!transform) throw new Error('ICC 색 변환이 아직 준비되지 않았습니다.');
    return engine.cmsDoTransform(transform, bytes, bytes.length / 4);
}

// K slices of a trilinearly filtered CMY cube. Exact ICC nodes (16-bit input),
// not hand-tuned ink colors. Interpolation error is covered by color tests.
export function getColorLUT() {
    if (lut) return lut;
    if (!transform16) throw new Error('ICC 색 변환이 아직 준비되지 않았습니다.');
    const n = LUT_SIZE, count = n ** 4;
    const input = new Uint16Array(count * 4);
    let i = 0;
    for (let k=0;k<n;k++) for(let y=0;y<n;y++) for(let m=0;m<n;m++) for(let c=0;c<n;c++) {
        input[i++]=Math.round(c/(n-1)*65535);
        input[i++]=Math.round(m/(n-1)*65535);
        input[i++]=Math.round(y/(n-1)*65535);
        input[i++]=Math.round(k/(n-1)*65535);
    }
    lut = engine.cmsDoTransform(transform16, input, count);
    // Preserve out-of-gamut values until AFTER interpolation. Clipping each
    // RGB lattice node first creates visible errors along the sRGB boundary.
    // Interpolate linear light, not gamma-encoded RGB.
    for (let i=0;i<lut.length;i++) {
        const v=lut[i];
        lut[i]=v<=0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4;
    }
    return lut;
}

const singleCache = new Map();
export function cmykToRGB255(c,m,y,k) {
    const input = Uint8Array.from([c,m,y,k], v => Math.max(0,Math.min(255,Math.round(v) || 0)));
    const key = input.join(',');
    if (!singleCache.has(key)) {
        const [r,g,b] = transformCMYK(input);
        if (singleCache.size >= 4096) singleCache.clear();
        singleCache.set(key,{r,g,b});
    }
    return singleCache.get(key);
}
