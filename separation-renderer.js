import { getSpotColorRGB } from './constants.js';
import { transformCMYK } from './color-profile.js';

// Document-provided equivalent CMYK values take precedence over name-based RGB.
// Additive ink equivalents match Ghostscript's tiffsep composite calculation;
// original process/spot plates remain untouched for ink measurement.
export function selectedSpots(spotColorData, separations, spotCMYK = {}) {
    return Object.entries(spotColorData || {})
        .filter(([name,data]) => data && separations.spotColors?.[name])
        .map(([name,data]) => ({name, data, cmyk: spotCMYK[name], rgb: getSpotColorRGB(name)}));
}

export function compositeSeparations(cmykData, spotColorData, separations, pixels, spotCMYK = {}, inkLimit = 0) {
    const {width,height,channels} = cmykData;
    const spots = selectedSpots(spotColorData,separations,spotCMYK);
    const planes = ['cyan','magenta','yellow','black'];
    const allSpots = inkLimit > 0 ? Object.values(spotColorData || {}).filter(Boolean) : [];
    const count = width*height;
    // Bound WASM scratch memory even for large pages / GPU fallback.
    const block = new Uint8Array(Math.min(count,65536)*4);
    for(let start=0;start<count;start+=65536) {
        const length=Math.min(65536,count-start),input=block.subarray(0,length*4);
        for(let ch=0;ch<4;ch++) {
            const plane=channels[planes[ch]],enabled=separations[planes[ch]];
            for(let j=0;j<length;j++) {
                const i=start+j;
                let ink=enabled ? plane[i] : 0;
                for(const spot of spots) if(spot.cmyk) ink+=spot.data[i]*spot.cmyk[ch];
                input[j*4+ch]=Math.min(255,Math.round(ink));
            }
        }
        const rgb=transformCMYK(input);
        for(let j=0;j<length;j++) {
            const i=start+j;
            let r=rgb[j*3],g=rgb[j*3+1],b=rgb[j*3+2];
            // Only missing document equivalents use the legacy display fallback.
            for(const spot of spots) if(!spot.cmyk) {
                const tint=spot.data[i]/255;
                r*=1-tint+tint*spot.rgb.r/255;
                g*=1-tint+tint*spot.rgb.g/255;
                b*=1-tint+tint*spot.rgb.b/255;
            }
            if (inkLimit > 0) {
                let total=channels.cyan[i]+channels.magenta[i]+channels.yellow[i]+channels.black[i];
                for(const plane of allSpots) total+=plane[i];
                if(total*100 > inkLimit*255) {r=255;g=35;b=35;}
            }
            pixels[i*4]=r;pixels[i*4+1]=g;pixels[i*4+2]=b;pixels[i*4+3]=255;
        }
    }
    return pixels;
}
