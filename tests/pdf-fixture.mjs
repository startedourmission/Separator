// Small deterministic PDF: black overprints either a spot green or process cyan.
export function overprintPDF(spot = true, contentOverride) {
    const content = contentOverride ?? `${spot ? '/Spot cs 1 scn' : '1 0 0 0 k'} 10 10 100 40 re f\n/OP gs 0 0 0 1 k 40 20 40 20 re f\n`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 60] /Resources << /ExtGState << /OP << /Type /ExtGState /OP true /op true /OPM 1 >> >> /ColorSpace << /Spot [/Separation /TestGreen /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0.5 0 1 0] /N 1 >>] >> >> /Contents 4 0 R >>',
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`
    ];
    return pdfFromObjects(objects);
}

function pdfFromObjects(objects) {
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

// Isolated knockout form containing opaque K100 fill/stroke, the GS regression.
// A second unused form shares the group dictionary and must never be modified.
export function knockoutGroupPDF({mixed=false,transparent=false,isolated=true,knockout=true,background=false}={}) {
    const state = '<< /Type /ExtGState /OP true /op true /OPM 1 /CA 1 /ca '+(transparent?'.5':'1')+' /BM /Normal /SMask /None /AIS false /SA true >>';
    const form = '0 0 0 1 k 0 0 0 1 K /GS0 gs 2 w 20 15 80 30 re f 20 15 80 30 re S\n'
        +(mixed?'1 0 0 0 k 60 20 30 20 re f\n':'');
    const content = (background?'1 0 0 0 k 0 0 120 60 re f\n':'')+'/Fm Do\n';
    const stream = text=>'<< /Length '+Buffer.byteLength(text)+' >>\nstream\n'+text+'endstream';
    return pdfFromObjects([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 60] /Group << /S /Transparency /CS /DeviceCMYK >> /Resources << /XObject << /Fm 5 0 R /Other 7 0 R >> >> /Contents 4 0 R >>',
        stream(content),
        '<< /Type /XObject /Subtype /Form /BBox [0 0 120 60] /Group 6 0 R /Resources << /ExtGState << /GS0 '+state+' >> >> /Length '+Buffer.byteLength(form)+' >>\nstream\n'+form+'endstream',
        '<< /S /Transparency /CS /DeviceCMYK /I '+isolated+' /K '+knockout+' >>',
        '<< /Type /XObject /Subtype /Form /BBox [0 0 120 60] /Group 6 0 R /Resources << >> /Length 0 >>\nstream\nendstream'
    ]);
}
