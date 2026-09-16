// Ghostscript tiffsep PrintSpotCMYK uses its fixed-point frac_1 (0x7ff8).
// Values come from the PDF's Separation/DeviceN alternate space, not a Pantone list.
export function parseSpotCMYK(lines) {
    const result = {};
    for (const line of lines) {
        const match = line.match(/%%SeparationColor:\s*"(.*)"\s+100% ink =\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+CMYK/);
        if (match) result[match[1]] = match.slice(2).map(n => Math.max(0,Math.min(1,Number(n)/32760)));
    }
    return result;
}
