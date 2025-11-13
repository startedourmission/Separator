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

function interceptConsole(handler) {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args) => {
        handler(args.join(' '));
        if (originalLog) originalLog.apply(console, args);
    };
    console.warn = (...args) => {
        handler(args.join(' '));
        if (originalWarn) originalWarn.apply(console, args);
    };
    console.error = (...args) => {
        handler(args.join(' '));
        if (originalError) originalError.apply(console, args);
    };

    return () => {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    };
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

async function getPDFPageCount(pdfData) {
    try {
        const outputs = [];
        const captureOutput = (text) => {
            if (typeof text === 'string') {
                outputs.push(text);
            }
        };

        const restoreConsole = interceptConsole(captureOutput);
        let moduleInstance;

        try {
            moduleInstance = await Module(createModuleConfig({
                noExitRuntime: false,
                print: captureOutput,
                printErr: captureOutput
            }));

            moduleInstance.FS.writeFile("input.pdf", new Uint8Array(pdfData));

            const args = [
                '-dNOPAUSE',
                '-dBATCH',
                '-dSAFER',
                '-sDEVICE=nullpage',
                'input.pdf'
            ];

            try {
                moduleInstance.callMain(args);
            } catch (error) {
                if (error?.name !== 'ExitStatus' || error.status !== 0) {
                    throw error;
                }
            }
        } finally {
            restoreConsole();
        }

        const pageMatch = [...outputs].reverse().find(line => {
            const match = line.match(/Processing pages \d+ through (\d+)/);
            return !!match;
        });

        let pageCount = 1;
        if (pageMatch) {
            const match = pageMatch.match(/Processing pages \d+ through (\d+)/);
            if (match) {
                pageCount = parseInt(match[1], 10);
            }
        }

        console.log('최종 페이지 수:', pageCount);
        return pageCount;
    } catch (error) {
        console.error('PDF 페이지 수 조회 실패:', error);
        return 1;
    }
}

async function processPDF(pdfData, options, pageNum = 1) {
    const outputWidth = options.width || 800;
    const outputHeight = options.height || 600;
    const targetPage = pageNum || options.pageNum || 1;
    const ghostscriptArgs = buildGhostscriptArgs(options, outputWidth, outputHeight, targetPage);

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

function buildGhostscriptArgs(options, width, height, pageNum = 1) {
    // PDF 크기와 원하는 출력 크기를 기반으로 DPI 계산
    const pdfWidth = options.pdfWidth || width;
    const pdfHeight = options.pdfHeight || height;
    const dpi = Math.max(1, Math.round((width / pdfWidth) * 72));

    const args = [
        '-dNOPAUSE',
        '-dBATCH',
        '-dSAFER',
        '-sDEVICE=pngalpha',
        '-dGraphicsAlphaBits=4',
        '-dTextAlphaBits=4',
        `-r${dpi}`,
        `-dFirstPage=${pageNum}`,
        `-dLastPage=${pageNum}`,
        '-sOutputFile=output.png'
    ];

    console.log('Ghostscript DPI:', dpi, `페이지: ${pageNum}`, '(PDF:', pdfWidth, 'x', pdfHeight, '→ 출력:', width, 'x', height + ')');

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
        } else if (type === 'testTiffsep') {
            console.log('=== tiffsep 지원 테스트 시작 ===');

            try {
                const { pdfData } = data;
                const moduleInstance = await Module(createModuleConfig({ noExitRuntime: false }));

                // PDF 파일 작성
                moduleInstance.FS.writeFile("input.pdf", new Uint8Array(pdfData));

                // tiffsep 디바이스로 렌더링 시도
                // 주의: tiffsep은 %s를 색상명으로 치환 (Cyan, Magenta, Yellow, Black)
                const args = [
                    '-dNOPAUSE',
                    '-dBATCH',
                    '-dSAFER',
                    '-sDEVICE=tiffsep',
                    '-r72',
                    '-dFirstPage=1',
                    '-dLastPage=1',
                    '-sOutputFile=plate%s.tif',  // %s 앞뒤 공백 제거
                    'input.pdf'
                ];

                console.log('tiffsep 명령 실행:', args.join(' '));

                try {
                    moduleInstance.callMain(args);
                } catch (error) {
                    if (error?.name !== 'ExitStatus' || error.status !== 0) {
                        throw error;
                    }
                }

                // 생성된 파일 확인
                const files = moduleInstance.FS.readdir('/');
                console.log('생성된 파일 목록:', files);

                const tiffFiles = files.filter(f => f.endsWith('.tif'));
                console.log('TIFF 파일:', tiffFiles);

                if (tiffFiles.length > 0) {
                    console.log('✅ tiffsep 지원됨! 생성된 분판 파일:', tiffFiles);
                    self.postMessage({
                        type: 'testTiffsep',
                        requestId: requestId,
                        success: true,
                        supported: true,
                        files: tiffFiles
                    });
                } else {
                    console.log('❌ tiffsep 실행됐지만 파일 생성 실패');
                    self.postMessage({
                        type: 'testTiffsep',
                        requestId: requestId,
                        success: true,
                        supported: false,
                        message: 'TIFF 파일이 생성되지 않음'
                    });
                }
            } catch (error) {
                console.error('❌ tiffsep 테스트 실패:', error);
                self.postMessage({
                    type: 'testTiffsep',
                    requestId: requestId,
                    success: false,
                    supported: false,
                    message: error.message
                });
            }
        } else if (type === 'listDevices') {
            console.log('=== Ghostscript 디바이스 목록 조회 ===');

            try {
                const outputs = [];
                const captureOutput = (text) => {
                    if (typeof text === 'string') {
                        outputs.push(text);
                    }
                };

                const restoreConsole = interceptConsole(captureOutput);
                let moduleInstance;

                try {
                    moduleInstance = await Module(createModuleConfig({
                        noExitRuntime: false,
                        print: captureOutput,
                        printErr: captureOutput
                    }));

                    const args = ['-h'];
                    console.log('명령 실행: gs -h');

                    try {
                        moduleInstance.callMain(args);
                    } catch (error) {
                        // -h는 항상 종료 코드를 반환하므로 무시
                    }
                } finally {
                    restoreConsole();
                }

                // "Available devices:" 섹션 추출
                const allOutput = outputs.join('\n');
                console.log('=== Ghostscript 출력 ===');
                console.log(allOutput);

                // 디바이스 목록 파싱
                const deviceSection = allOutput.split('Available devices:')[1];
                const devices = deviceSection ? deviceSection.split('\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0 && !line.startsWith('Search'))
                    .flatMap(line => line.split(/\s+/))
                    .filter(d => d.length > 0)
                    : [];

                console.log('파싱된 디바이스:', devices);

                self.postMessage({
                    type: 'listDevices',
                    requestId: requestId,
                    success: true,
                    devices: devices,
                    rawOutput: allOutput
                });
            } catch (error) {
                console.error('디바이스 목록 조회 실패:', error);
                self.postMessage({
                    type: 'listDevices',
                    requestId: requestId,
                    success: false,
                    message: error.message
                });
            }
        } else if (type === 'testDevice') {
            console.log('=== 디바이스 테스트 시작 ===');

            try {
                const { pdfData, device, outputFile } = data;
                const moduleInstance = await Module(createModuleConfig({ noExitRuntime: false }));

                // PDF 파일 작성
                moduleInstance.FS.writeFile("input.pdf", new Uint8Array(pdfData));

                const args = [
                    '-dNOPAUSE',
                    '-dBATCH',
                    '-dSAFER',
                    `-sDEVICE=${device}`,
                    '-r72',
                    '-dFirstPage=1',
                    '-dLastPage=1',
                    `-sOutputFile=${outputFile}`,
                    'input.pdf'
                ];

                console.log(`${device} 명령 실행:`, args.join(' '));

                try {
                    moduleInstance.callMain(args);
                } catch (error) {
                    if (error?.name !== 'ExitStatus' || error.status !== 0) {
                        throw error;
                    }
                }

                // 생성된 파일 확인
                const files = moduleInstance.FS.readdir('/');
                console.log('생성된 파일 목록:', files);

                const outputFiles = files.filter(f =>
                    f.endsWith('.tif') ||
                    f.endsWith('.psd') ||
                    f.endsWith('.pam') ||
                    f.endsWith('.bmp')
                );

                if (outputFiles.length > 0) {
                    console.log(`✅ ${device} 성공! 생성된 파일:`, outputFiles);

                    // 첫 번째 파일의 크기 확인
                    const fileData = moduleInstance.FS.readFile(outputFiles[0]);
                    console.log(`파일 크기: ${fileData.length} bytes`);

                    self.postMessage({
                        type: 'testDevice',
                        requestId: requestId,
                        success: true,
                        supported: true,
                        files: outputFiles,
                        fileSize: fileData.length
                    });
                } else {
                    console.log(`❌ ${device} 파일 생성 실패`);
                    self.postMessage({
                        type: 'testDevice',
                        requestId: requestId,
                        success: true,
                        supported: false,
                        message: '출력 파일이 생성되지 않음'
                    });
                }
            } catch (error) {
                console.error('❌ 디바이스 테스트 실패:', error);
                self.postMessage({
                    type: 'testDevice',
                    requestId: requestId,
                    success: false,
                    supported: false,
                    message: error.message
                });
            }
        } else if (type === 'getPageCount') {
            const { pdfData } = data;
            console.log('Worker: PDF 페이지 수 조회 중...');

            const pageCount = await getPDFPageCount(pdfData);
            console.log('Worker: PDF 페이지 수:', pageCount);

            self.postMessage({
                type: 'pageCount',
                requestId: requestId,
                success: true,
                pageCount: pageCount
            });
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
            const { pdfData, options, pageNum } = data;
            const targetPage = pageNum || options?.pageNum || 1;
            console.log('Worker: PDF 처리 시작', { width: options.width, height: options.height, page: targetPage });

            const outputData = await processPDF(pdfData, options, targetPage);
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
