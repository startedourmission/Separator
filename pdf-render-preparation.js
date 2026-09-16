// Ghostscript can paint spurious CMY in isolated knockout groups containing
// overprinting black paths. For opaque, uniformly K100 paths, knockout and
// source-over produce the same result. Remove only that redundant group flag
// from a rendering copy; retain isolation, all overprint flags and the original
// document. Never apply this to mixed colors, transparency, images or text.
const arities = {q:0,Q:0,cm:6,m:2,l:2,c:6,v:4,y:4,h:0,re:4,W:0,'W*':0,n:0,
    S:0,s:0,f:0,F:0,'f*':0,B:0,'B*':0,b:0,'b*':0,k:4,K:4,w:1,J:1,j:1,M:1,i:1,ri:1,gs:1};
const fills = new Set(['f','F','f*','B','B*','b','b*']);
const strokes = new Set(['S','s','B','B*','b','b*']);

// A deliberately restricted content-stream validator, not a general PDF parser.
// Reject unknown syntax/operators rather than changing an unproven group.
export function opaqueBlackPaths(source, getState) {
    const tokens = source.replace(/%[^\r\n]*/g, '').match(/[^\x00\t\n\f\r ]+/g) || [];
    let state = {}, painted = false, args = [];
    const stack = [];
    for (const token of tokens) {
        if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
            const number = Number(token);
            if (!Number.isFinite(number)) return false;
            args.push(number);
        } else if (/^\/[A-Za-z0-9_#.-]+$/.test(token)) {
            args.push(token);
        } else {
            if (!Object.hasOwn(arities,token) || args.length !== arities[token]) return false;
            if (token === 'gs') {
                if (typeof args[0] !== 'string') return false;
                const change = getState(args[0]);
                if (!change) return false;
                state = {...state,...change};
            } else if (token === 'ri') {
                if (!['/Perceptual','/RelativeColorimetric','/AbsoluteColorimetric','/Saturation'].includes(args[0])) return false;
            } else {
                if (args.some(value => typeof value !== 'number')) return false;
                if (token === 'q') stack.push({...state});
                if (token === 'Q') {
                    if (!stack.length) return false;
                    state = stack.pop();
                }
                if (token === 'k' || token === 'K') {
                    // Reject any other source color, even if later overwritten.
                    if (args.some((value,i) => value !== (i === 3 ? 1 : 0))) return false;
                    state[token === 'k' ? 'fillBlack' : 'strokeBlack'] = true;
                }
                if (fills.has(token) || strokes.has(token)) {
                    if (state.blend !== '/Normal' || state.mask !== '/None' || state.alphaIsShape !== false) return false;
                    if (fills.has(token) && (!state.fillBlack || state.fillAlpha !== 1)) return false;
                    if (strokes.has(token) && (!state.strokeBlack || state.strokeAlpha !== 1)) return false;
                    painted = true;
                }
            }
            args = [];
        }
        if (args.length > 6) return false;
    }
    return painted && !args.length && !stack.length;
}

export async function preparePDFForRendering(bytes, lib = globalThis.PDFLib) {
    const {PDFDocument,PDFName,PDFDict,PDFRawStream,PDFBool,PDFNumber,decodePDFRawStream} = lib;
    const pdf = await PDFDocument.load(bytes, {updateMetadata:false});
    const name = key => PDFName.of(key);
    const lookup = (dict,key) => dict?.lookup(name(key));
    const isName = (value,expected) => value instanceof PDFName && value.toString() === '/' + expected;
    const isTrue = value => value === PDFBool.True;
    const allowedState = new Set(['Type','BM','CA','ca','OP','op','OPM','SA','SMask','AIS']);
    let correctedGroups = 0;
    for (const [,stream] of pdf.context.enumerateIndirectObjects()) {
        if (!(stream instanceof PDFRawStream) || !isName(lookup(stream.dict,'Subtype'),'Form')) continue;
        const group = lookup(stream.dict,'Group');
        if (!(group instanceof PDFDict) || !isName(lookup(group,'S'),'Transparency') ||
            !isName(lookup(group,'CS'),'DeviceCMYK') || !isTrue(lookup(group,'I')) || !isTrue(lookup(group,'K'))) continue;
        const resources = lookup(stream.dict,'Resources');
        if (!(resources instanceof PDFDict)) continue;
        const ext = lookup(resources,'ExtGState');
        if (!(ext instanceof PDFDict)) continue;
        try {
            const decoded = decodePDFRawStream(stream).decode();
            // Large/complex forms do not qualify for this narrow workaround.
            if (decoded.length > 1024*1024) continue;
            const source = new TextDecoder('latin1').decode(decoded);
            const valid = opaqueBlackPaths(source, token => {
                const gs = lookup(ext,token.slice(1).replace(/#([0-9a-f]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))));
                if (!(gs instanceof PDFDict) || gs.keys().some(key => !allowedState.has(key.decodeText()))) return null;
                const values = {};
                for (const [key,field] of [['ca','fillAlpha'],['CA','strokeAlpha']]) {
                    const value = lookup(gs,key);
                    if (value !== undefined) {
                        if (!(value instanceof PDFNumber)) return null;
                        values[field] = value.asNumber();
                    }
                }
                for (const [key,field] of [['BM','blend'],['SMask','mask']]) {
                    const value = lookup(gs,key);
                    if (value !== undefined) {
                        if (!(value instanceof PDFName)) return null;
                        values[field] = value.toString();
                    }
                }
                const ais = lookup(gs,'AIS');
                if (ais !== undefined) {
                    if (!(ais instanceof PDFBool)) return null;
                    values.alphaIsShape = ais.asBoolean();
                }
                return values;
            });
            if (!valid) continue;
            // The group dictionary may be shared by unrelated forms.
            const copy = group.clone(pdf.context);
            copy.set(name('K'),PDFBool.False);
            stream.dict.set(name('Group'),copy);
            correctedGroups++;
        } catch (error) {
            // Unsupported stream filters or malformed resources stay untouched.
            console.warn('검증하지 못한 투명 그룹은 원본으로 유지:',error.message);
        }
    }
    return {bytes:correctedGroups ? await pdf.save() : bytes, correctedGroups, pageCount:pdf.getPageCount()};
}
