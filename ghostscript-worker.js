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
    const args = [
        '-dNOPAUSE',
        '-dBATCH',
        '-dSAFER',
        '-sDEVICE=pngalpha',
        '-dGraphicsAlphaBits=4',
        '-dTextAlphaBits=4',
        '-r150',
        `-g${width}x${height}`,
        '-sOutputFile=output.png'
    ];

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
