import { getSpotColorRGB } from './constants.js';
import { getColorTables } from './color-profile.js';

// 입력은 Ghostscript가 knockout/overprint를 이미 반영한 독립 잉크판이다.
// 별색 대체 CMY를 감산하거나 별색을 불투명 RGB로 덮으면 실제 잉크가 사라진다.
// 화면과 미리보기에서 동일한 근사 잉크 합성을 사용한다.
export function compositeSeparations(cmykData, spotColorData, separations, pixels) {
    const { width, height, channels } = cmykData;
    const { cyan, magenta, yellow, black } = channels;
    const spots = Object.entries(spotColorData || {})
        .filter(([name, data]) => data && separations.spotColors?.[name])
        .map(([name, data]) => ({ data, ...getSpotColorRGB(name) }));
    const { cmy, kCurve, idxC, idxCT, idxM, idxY, STRIDE_C } = getColorTables();

    for (let i = 0; i < width * height; i++) {
        const c = separations.cyan ? cyan[i] : 0;
        const m = separations.magenta ? magenta[i] : 0;
        const y = separations.yellow ? yellow[i] : 0;
        const k = separations.black ? black[i] : 0;
        const lo = idxC[c] + idxM[m] + idxY[y];
        const hi = lo + STRIDE_C;
        const ct = idxCT[c];
        const ko = k * 3;
        let r = (cmy[lo] + (cmy[hi] - cmy[lo]) * ct) * kCurve[ko];
        let g = (cmy[lo + 1] + (cmy[hi + 1] - cmy[lo + 1]) * ct) * kCurve[ko + 1];
        let b = (cmy[lo + 2] + (cmy[hi + 2] - cmy[lo + 2]) * ct) * kCurve[ko + 2];

        for (const spot of spots) {
            const tint = spot.data[i] / 255;
            r *= 1 - tint + tint * spot.r / 255;
            g *= 1 - tint + tint * spot.g / 255;
            b *= 1 - tint + tint * spot.b / 255;
        }
        const offset = i * 4;
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
        pixels[offset + 3] = 255;
    }
    return pixels;
}
