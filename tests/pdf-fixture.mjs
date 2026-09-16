// Small deterministic PDF: black overprints either a spot green or process cyan.
export function overprintPDF(spot = true) {
    const content = `${spot ? '/Spot cs 1 scn' : '1 0 0 0 k'} 10 10 100 40 re f\n/OP gs 0 0 0 1 k 40 20 40 20 re f\n`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 60] /Resources << /ExtGState << /OP << /Type /ExtGState /OP true /op true /OPM 1 >> >> /ColorSpace << /Spot [/Separation /TestGreen /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0.5 0 1 0] /N 1 >>] >> >> /Contents 4 0 R >>',
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, i) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
}
