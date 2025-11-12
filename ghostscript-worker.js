// Ghostscript WebWorker
import Module from './gs.mjs';

let gsModule = null;

function createModuleConfig(overrides = {}) {
    return Object.assign({
        locateFile: (path) => new URL(path, self.location.href).href,
        print: () => {},
        printErr: (text) => console.warn('GS:', text)
    }, overrides);
}

async function initGhostscript() {
    if (!gsModule) {
        gsModule = await Module(createModuleConfig({ noExitRuntime: true }));
    }
    return gsModule;
}

async function getPDFPageSize(pdfData, pageNum = 1) {
    try {
        // 저해상도로 렌더링해서 실제 크기 파악
        const moduleInstance = await Module(createModuleConfig({ noExitRuntime: false }));
        moduleInstance.FS.writeFile("input.pdf", new Uint8Array(pdfData));

        const args = [
            '-dNOPAUSE',
            '-dBATCH',
            '-dSAFER',
            '-sDEVICE=pngalpha',
            '-r72', // 72 DPI = 1:1 포인트 to 픽셀
            `-dFirstPage=${pageNum}`,
            `-dLastPage=${pageNum}`,
            '-sOutputFile=probe.png',
            'input.pdf'
        ];

        try {
            moduleInstance.callMain(args);
        } catch (error) {
            if (error?.name !== 'ExitStatus' || error.status !== 0) {
                throw error;
            }
        }

        // 생성된 이미지 크기 확인
        const probeData = moduleInstance.FS.readFile("probe.png", { encoding: "binary" });

        // PNG 헤더에서 크기 읽기 (IHDR 청크)
        const view = new DataView(probeData.buffer, probeData.byteOffset, probeData.byteLength);

        // PNG 시그니처 확인
        if (view.getUint32(0) !== 0x89504e47) {
            throw new Error('PNG 파일이 아닙니다');
        }

        // IHDR 청크는 8바이트 후 (width: 4바이트, height: 4바이트)
        const width = view.getUint32(16);
        const height = view.getUint32(20);

        console.log('72 DPI 렌더링 크기:', width, 'x', height);

        const result = { width, height };
        console.log('최종 페이지 크기:', result);
        return result;
    } catch (error) {
        console.error('PDF 페이지 크기 가져오기 실패:', error);
        return { width: 612, height: 792 };
    }
}

async function processPDF(pdfData, options) {
    const outputWidth = options.width || 800;
    const outputHeight = options.height || 600;
    const ghostscriptArgs = buildGhostscriptArgs(options, outputWidth, outputHeight);

    try {
        const moduleInstance = await Module(createModuleConfig({ noExitRuntime: false }));

        moduleInstance.FS.writeFile("input.pdf", new Uint8Array(pdfData));

        try {
            moduleInstance.callMain(ghostscriptArgs);
        } catch (error) {
            // Emscripten throws ExitStatus on normal termination; ignore status 0
            if (error?.name !== 'ExitStatus' || error.status !== 0) {
                throw error;
            }
        }

        const outputData = moduleInstance.FS.readFile("output.png", { encoding: "binary" });
        return outputData;
    } catch (error) {
        console.error('Ghostscript 처리 실패:', error);
        throw error;
    }
}

function buildGhostscriptArgs(options, width, height) {
    // PDF 크기와 원하는 출력 크기를 기반으로 DPI 계산
    // 기본 PDF는 72 DPI 기준
    const dpi = Math.round((width / options.pdfWidth) * 72);

    const args = [
        '-dNOPAUSE',
        '-dBATCH',
        '-dSAFER',
        '-sDEVICE=pngalpha',
        '-dGraphicsAlphaBits=4',
        '-dTextAlphaBits=4',
        `-r${dpi}`,
        '-sOutputFile=output.png'
    ];

    console.log('Ghostscript DPI:', dpi, '(PDF:', options.pdfWidth, 'x', options.pdfHeight, '→ 출력:', width, 'x', height + ')');

    // CMYK 분판 제어 (실제 Ghostscript 옵션 사용)
    // 주의: Ghostscript의 CMYK 분판은 복잡하므로 일단 기본 렌더링만 수행
    // 향후 tiffsep 또는 psdcmyk 디바이스를 사용하여 분판 구현 가능

    // 오버프린트 시뮬레이션
    if (options.overprint) {
        // 실제 Ghostscript 오버프린트 옵션
        args.push('-dOverprint=/enable');
    }

    args.push('input.pdf');
    return args;
}

// WebWorker 메시지 처리
self.addEventListener('message', async function(e) {
    const { type, requestId, data } = e.data;

    try {
        if (type === 'init') {
            await initGhostscript();
            self.postMessage({ type: 'init', success: true });
        } else if (type === 'getPageSize') {
            const { pdfData, pageNum } = data;
            console.log('Worker: PDF 페이지 크기 조회 중...');

            const pageSize = await getPDFPageSize(pdfData, pageNum);
            console.log('Worker: PDF 페이지 크기:', pageSize);

            self.postMessage({
                type: 'pageSize',
                requestId: requestId,
                success: true,
                pageSize: pageSize
            });
        } else if (type === 'process') {
            const { pdfData, options } = data;
            console.log('Worker: PDF 처리 시작', { width: options.width, height: options.height });

            const outputData = await processPDF(pdfData, options);
            console.log('Worker: PDF 처리 완료, 출력 크기:', outputData.length);

            self.postMessage({
                type: 'result',
                requestId: requestId,
                success: true,
                data: outputData,
                width: options.width || 800,
                height: options.height || 600
            });
        }
    } catch (error) {
        console.error('Worker error:', error);
        self.postMessage({
            type: 'error',
            requestId: requestId,
            message: error.message
        });
    }
});
