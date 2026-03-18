// Ghostscript WebWorker
import Module from './gs.mjs';

let gsModule = null;

function createModuleConfig(overrides = {}) {
    return Object.assign({
        locateFile: (path) => new URL(path, self.location.href).href,
        print: () => { },
        printErr: () => { }
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

        const result = { width, height };
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
    const useCMYK = options.useCMYK || false;

    try {
        const moduleInstance = await Module(createModuleConfig({ noExitRuntime: false }));
        moduleInstance.FS.writeFile("input.pdf", new Uint8Array(pdfData));

        if (useCMYK) {
            // CMYK TIFF 생성 (정확한 분판용)
            const tiffArgs = buildTiffCMYKArgs(options, outputWidth, outputHeight, targetPage);

            try {
                moduleInstance.callMain(tiffArgs);
            } catch (error) {
                if (error?.name !== 'ExitStatus' || error.status !== 0) {
                    throw error;
                }
            }

            const tiffData = moduleInstance.FS.readFile("output.tif", { encoding: "binary" });
            return { format: 'tiff', data: tiffData };
        } else {
            // 기존 PNG 렌더링
            const ghostscriptArgs = buildGhostscriptArgs(options, outputWidth, outputHeight, targetPage);

            try {
                moduleInstance.callMain(ghostscriptArgs);
            } catch (error) {
                if (error?.name !== 'ExitStatus' || error.status !== 0) {
                    throw error;
                }
            }

            const outputData = moduleInstance.FS.readFile("output.png", { encoding: "binary" });
            return { format: 'png', data: outputData };
        }
    } catch (error) {
        console.error('Ghostscript 처리 실패:', error);
        throw error;
    }
}

function buildTiffCMYKArgs(options, width, height, pageNum = 1) {
    // tiff32nc 디바이스로 CMYK TIFF 생성
    const pdfWidth = options.pdfWidth || width;
    const pdfHeight = options.pdfHeight || height;
    // DPI가 옵션으로 전달되면 그것을 사용하고, 아니면 크기 기반 계산
    const dpi = options.dpi || Math.max(1, Math.round((width / pdfWidth) * 72));

    const args = [
        '-dNOPAUSE',
        '-dBATCH',
        '-dSAFER',
        '-sDEVICE=tiff32nc',  // 32-bit CMYK TIFF
        `-r${dpi}`,
        `-dFirstPage=${pageNum}`,
        `-dLastPage=${pageNum}`,
        '-sOutputFile=output.tif'
    ];



    // 오버프린트 지원
    if (options.overprint) {
        args.push('-dOverprint=/enable');
    }

    args.push('input.pdf');
    return args;
}

function buildGhostscriptArgs(options, width, height, pageNum = 1) {
    // PDF 크기와 원하는 출력 크기를 기반으로 DPI 계산
    const pdfWidth = options.pdfWidth || width;
    const pdfHeight = options.pdfHeight || height;
    // DPI가 옵션으로 전달되면 그것을 사용
    const dpi = options.dpi || Math.max(1, Math.round((width / pdfWidth) * 72));

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



    // 오버프린트 시뮬레이션
    if (options.overprint) {
        args.push('-dOverprint=/enable');
    }

    args.push('input.pdf');
    return args;
}

// WebWorker 메시지 처리
self.addEventListener('message', async function (e) {
    const { type, requestId, data } = e.data;

    try {
        if (type === 'init') {
            await initGhostscript();
            self.postMessage({ type: 'init', success: true });
        } else if (type === 'processTiffsep') {


            try {
                const { pdfData, pageNum, dpi } = data;
                const gsOutput = [];
                const moduleInstance = await Module(createModuleConfig({
                    noExitRuntime: false,
                    print: (text) => { gsOutput.push('[stdout] ' + text); },
                    printErr: (text) => { gsOutput.push('[stderr] ' + text); }
                }));

                // PDF 파일 작성
                moduleInstance.FS.writeFile("input.pdf", new Uint8Array(pdfData));

                // tiffsep 디바이스로 렌더링 (분판용)
                const tiffsepDpi = Math.min(dpi || 300, 300);
                const args = [
                    '-dNOPAUSE',
                    '-dBATCH',
                    '-dNOSAFER',
                    '-sDEVICE=tiffsep',
                    `-r${tiffsepDpi}`,
                    `-dFirstPage=${pageNum || 1}`,
                    `-dLastPage=${pageNum || 1}`,
                    '-dMaxSpots=10',
                    '-sOutputFile=plate%d.tif',
                    'input.pdf'
                ];



                try {
                    moduleInstance.callMain(args);
                } catch (error) {
                    if (error?.name !== 'ExitStatus' || error.status !== 0) {
                        throw error;
                    }
                }

                // 생성된 파일 목록 조회
                const files = moduleInstance.FS.readdir('/');
                const allPlateFiles = files.filter(f => f.startsWith('plate') && f.endsWith('.tif'));
                // composite 파일(plate1.tif 등 숫자만 있는 파일)과 분판 파일 분리
                // tiffsep %d 모드: plate1.tif(composite), plate1(Cyan).tif(분판)
                const plateFiles = allPlateFiles.filter(f => /plate\d+\(.+\)\.tif/.test(f) || /plate[A-Za-z]/.test(f));
                const compositeFiles = allPlateFiles.filter(f => /^plate\d+\.tif$/.test(f));



                // GS 출력에서 별색 이름 추출 (tiffsep 로그에서 파싱)
                // 예: "  /Cyan /Magenta /Yellow /Black /PANTONE 185 C" 등
                const spotColorNames = [];
                for (const line of gsOutput) {
                    // tiffsep은 "%%SeparationColor:" 또는 "Spot" 관련 로그를 출력할 수 있음
                    const sepMatch = line.match(/SeparationColor.*?:\s*(.+)/i);
                    if (sepMatch) {
                        spotColorNames.push(sepMatch[1].trim());
                    }
                }

                // 각 파일에서 색상명 추출 및 데이터 읽기
                const channels = {};
                const spotColors = [];
                let width = 0;
                let height = 0;

                // %d 패턴 사용 시 CMYK 순서 매핑 (01=Cyan, 02=Magenta, 03=Yellow, 04=Black, 05+=별색)
                const cmykOrder = ['Cyan', 'Magenta', 'Yellow', 'Black'];

                // 파일을 숫자 순서대로 정렬
                plateFiles.sort((a, b) => {
                    const numA = parseInt(a.match(/\d+/)?.[0] || '0');
                    const numB = parseInt(b.match(/\d+/)?.[0] || '0');
                    return numA - numB;
                });

                for (const file of plateFiles) {
                    let colorName = null;

                    // 패턴 1: plate1(ColorName).tif 또는 plate(ColorName).tif (%d+%s 혼합 패턴)
                    let match = file.match(/plate\d*\((.+?)\)\.tif/);
                    if (match) {
                        colorName = match[1];
                        // %XX URL 인코딩 패턴이 포함되면 바이트로 변환 후 EUC-KR 디코딩
                        if (/%[0-9A-Fa-f]{2}/.test(colorName)) {
                            try {
                                const bytes = [];
                                let i = 0;
                                while (i < colorName.length) {
                                    if (colorName[i] === '%' && i + 2 < colorName.length) {
                                        bytes.push(parseInt(colorName.substring(i + 1, i + 3), 16));
                                        i += 3;
                                    } else {
                                        bytes.push(colorName.charCodeAt(i));
                                        i++;
                                    }
                                }
                                const byteArray = new Uint8Array(bytes);
                                // EUC-KR 디코딩 시도
                                try {
                                    const decoded = new TextDecoder('euc-kr', { fatal: true }).decode(byteArray);
                                    colorName = decoded;
                                } catch {
                                    // UTF-8 시도
                                    try {
                                        colorName = new TextDecoder('utf-8', { fatal: true }).decode(byteArray);
                                    } catch {
                                        // 실패 시 원본 유지
                                    }
                                }
                            } catch (e) {
                                // 디코딩 실패 시 원본 유지
                            }
                        }
                        // 비ASCII 문자가 직접 포함된 경우 (URL 인코딩 없이)
                        else if (/[^\x00-\x7F]/.test(colorName)) {
                            try {
                                const bytes = new Uint8Array([...colorName].map(c => c.charCodeAt(0)));
                                const decoded = new TextDecoder('euc-kr', { fatal: true }).decode(bytes);
                                colorName = decoded;
                            } catch {
                                // 디코딩 실패 시 원본 유지
                            }
                        }
                    }

                    // 패턴 2: plateCyan.tif 등 (%s 패턴 결과)
                    if (!colorName) {
                        match = file.match(/plate([A-Za-z].+?)\.tif/);
                        if (match) {
                            colorName = match[1];
                        }
                    }

                    if (colorName) {
                        const tiffData = moduleInstance.FS.readFile(file, { encoding: "binary" });

                        channels[colorName] = tiffData;
                        // CMYK가 아닌 색상은 별색으로 분류
                        const normalizedColorName = colorName.toLowerCase();
                        if (!['cyan', 'magenta', 'yellow', 'black'].includes(normalizedColorName)) {
                            spotColors.push(colorName);
                        }
                    }
                }

                // 정리 (파일 삭제)
                try {
                    moduleInstance.FS.unlink("input.pdf");
                    allPlateFiles.forEach(f => moduleInstance.FS.unlink(f));
                } catch (e) {
                    // 파일 정리 실패 무시
                }

                self.postMessage({
                    type: 'tiffsepResult',
                    requestId: requestId,
                    success: true,
                    channels: channels,
                    spotColors: spotColors
                });
            } catch (error) {
                console.error('❌ tiffsep 처리 실패:', error);
                self.postMessage({
                    type: 'tiffsepResult',
                    requestId: requestId,
                    success: false,
                    message: error.message
                });
            }
        } else if (type === 'listDevices') {
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
                // 디바이스 목록 파싱
                const deviceSection = allOutput.split('Available devices:')[1];
                const devices = deviceSection ? deviceSection.split('\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0 && !line.startsWith('Search'))
                    .flatMap(line => line.split(/\s+/))
                    .filter(d => d.length > 0)
                    : [];

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

                try {
                    moduleInstance.callMain(args);
                } catch (error) {
                    if (error?.name !== 'ExitStatus' || error.status !== 0) {
                        throw error;
                    }
                }

                // 생성된 파일 확인
                const files = moduleInstance.FS.readdir('/');
                const outputFiles = files.filter(f =>
                    f.endsWith('.tif') ||
                    f.endsWith('.psd') ||
                    f.endsWith('.pam') ||
                    f.endsWith('.bmp')
                );

                if (outputFiles.length > 0) {
                    const fileData = moduleInstance.FS.readFile(outputFiles[0]);

                    self.postMessage({
                        type: 'testDevice',
                        requestId: requestId,
                        success: true,
                        supported: true,
                        files: outputFiles,
                        fileSize: fileData.length
                    });
                } else {
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
            const pageCount = await getPDFPageCount(pdfData);

            self.postMessage({
                type: 'pageCount',
                requestId: requestId,
                success: true,
                pageCount: pageCount
            });
        } else if (type === 'getPageSize') {
            const { pdfData, pageNum } = data;
            const pageSize = await getPDFPageSize(pdfData, pageNum);

            self.postMessage({
                type: 'pageSize',
                requestId: requestId,
                success: true,
                pageSize: pageSize
            });
        } else if (type === 'process') {
            const { pdfData, options, pageNum } = data;
            const targetPage = pageNum || options?.pageNum || 1;
            const result = await processPDF(pdfData, options, targetPage);

            self.postMessage({
                type: 'result',
                requestId: requestId,
                success: true,
                format: result.format,
                data: result.data,
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
