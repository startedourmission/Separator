// WebWorker 기반 Ghostscript 사용
// UTIF는 HTML에서 전역 스크립트로 로드됨 (window.UTIF)

class PDFSeparationViewer {
    constructor() {
        this.canvas = document.getElementById('pdf-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.currentPDF = null;
        this.ghostscript = null;
        this.spotColors = [];
        this.gsModule = null;
        this.currentPage = 1;
        this.totalPages = 1;
        this.zoomLevel = 1.0;

        this.initializeElements();
        this.bindEvents();
        this.initializeCanvas();
        this.loadGhostscript();
    }

    initializeCanvas() {
        // 초기 캔버스 크기 설정
        this.canvas.width = 800;
        this.canvas.height = 600;

        // 초기 테스트 패턴 표시
        this.ctx.fillStyle = '#f0f0f0';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        this.ctx.fillStyle = '#999';
        this.ctx.font = '16px sans-serif';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText('PDF 파일을 선택해주세요', this.canvas.width / 2, this.canvas.height / 2);
    }
    
    initializeElements() {
        this.fileInput = document.getElementById('pdf-file');
        this.cmykCheckboxes = {
            cyan: document.getElementById('cyan'),
            magenta: document.getElementById('magenta'),
            yellow: document.getElementById('yellow'),
            black: document.getElementById('black')
        };
        this.tacValueElement = document.getElementById('tac-value');
        this.cursorCoordsElement = document.getElementById('cursor-coords');

        // 뷰어 컨트롤
        this.zoomSlider = document.getElementById('zoom-slider');
        this.zoomValue = document.getElementById('zoom-value');
        this.prevPageBtn = document.getElementById('prev-page');
        this.nextPageBtn = document.getElementById('next-page');
        this.currentPageInput = document.getElementById('current-page');
        this.totalPagesSpan = document.getElementById('total-pages');
    }
    
    bindEvents() {
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

        Object.values(this.cmykCheckboxes).forEach(checkbox => {
            checkbox.addEventListener('change', () => this.updateSeparation());
        });

        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseleave', () => this.clearMouseInfo());

        // 줌 컨트롤
        this.zoomSlider.addEventListener('input', (e) => {
            this.zoomLevel = parseInt(e.target.value) / 100;
            this.zoomValue.textContent = e.target.value + '%';
            this.renderCurrentPage();
        });

        // 페이지 네비게이션
        this.prevPageBtn.addEventListener('click', () => this.goToPreviousPage());
        this.nextPageBtn.addEventListener('click', () => this.goToNextPage());

        // 페이지 번호 직접 입력
        this.currentPageInput.addEventListener('change', (e) => {
            const pageNum = parseInt(e.target.value);
            this.goToPage(pageNum);
        });
        this.currentPageInput.addEventListener('keydown', (e) => {
            console.log('키 입력 감지:', e.key); // 디버깅용
            if (e.key === 'Enter') {
                e.preventDefault(); // 폼 제출 방지
                e.stopPropagation(); // 이벤트 전파 차단
                const pageNum = parseInt(e.target.value);
                console.log('페이지 이동:', pageNum);
                this.goToPage(pageNum);
                e.target.blur(); // Enter 후 포커스 해제
            }
        });
    }
    
    async loadGhostscript() {
        try {
            console.log('Ghostscript WebWorker 초기화 중...');

            this.worker = new Worker('./ghostscript-worker.js', { type: 'module' });
            this.currentPDFData = null;
            this.requestId = 0;
            this.pendingRequests = new Map();

            // Worker 메시지 핸들러를 한 번만 설정
            this.worker.onmessage = (e) => {
                const { type, requestId, success, data, width, height, message, pageSize, pageCount, supported, files, devices, rawOutput, fileSize, format } = e.data;

                if (type === 'init') {
                    const pending = this.pendingRequests.get('init');
                    if (pending) {
                        if (success) {
                            pending.resolve();
                        } else {
                            pending.reject(new Error(message || 'Worker 초기화 실패'));
                        }
                        this.pendingRequests.delete('init');
                    }
                } else if (type === 'testTiffsep') {
                    const pending = this.pendingRequests.get(requestId);
                    if (pending) {
                        pending.resolve({ supported, files, message });
                        this.pendingRequests.delete(requestId);
                    }
                } else if (type === 'listDevices') {
                    const pending = this.pendingRequests.get(requestId);
                    if (pending) {
                        pending.resolve({ devices, rawOutput });
                        this.pendingRequests.delete(requestId);
                    }
                } else if (type === 'testDevice') {
                    const pending = this.pendingRequests.get(requestId);
                    if (pending) {
                        pending.resolve({ supported, files, message, fileSize });
                        this.pendingRequests.delete(requestId);
                    }
                } else if (type === 'pageCount') {
                    const pending = this.pendingRequests.get(requestId);
                    if (pending) {
                        pending.resolve(pageCount);
                        this.pendingRequests.delete(requestId);
                    }
                } else if (type === 'pageSize') {
                    const pending = this.pendingRequests.get(requestId);
                    if (pending) {
                        pending.resolve(pageSize);
                        this.pendingRequests.delete(requestId);
                    }
                } else if (type === 'result') {
                    const pending = this.pendingRequests.get(requestId);
                    if (pending) {
                        if (success) {
                            if (format === 'tiff') {
                                // TIFF CMYK 데이터 처리
                                this.convertTIFFToCMYK(data, width, height)
                                    .then(cmykData => pending.resolve(cmykData))
                                    .catch(error => {
                                        console.error('TIFF 변환 실패:', error);
                                        pending.resolve(this.createDummyImageData(width, height));
                                    });
                            } else {
                                // PNG 데이터 처리 (기존)
                                this.convertPNGToImageData(data, width, height)
                                    .then(imageData => pending.resolve(imageData))
                                    .catch(error => {
                                        console.error('이미지 변환 실패:', error);
                                        pending.resolve(this.createDummyImageData(width, height));
                                    });
                            }
                        } else {
                            console.error('Worker 처리 오류:', message);
                            pending.resolve(this.createDummyImageData(width, height));
                        }
                        this.pendingRequests.delete(requestId);
                    }
                } else if (type === 'error') {
                    const pending = this.pendingRequests.get(requestId);
                    if (pending) {
                        console.error('Worker 오류:', message);
                        const options = pending.options || {};
                        pending.resolve(this.createDummyImageData(options.width || 800, options.height || 600));
                        this.pendingRequests.delete(requestId);
                    }
                }
            };

            // Worker 초기화
            await new Promise((resolve, reject) => {
                this.pendingRequests.set('init', { resolve, reject });
                this.worker.postMessage({ type: 'init' });
            });

            this.ghostscript = {
                loadPDF: async (data) => {
                    try {
                        this.currentPDFData = new Uint8Array(data);
                        console.log('PDF 로딩 완료, 크기:', this.currentPDFData.length);

                        // 페이지 수 조회
                        const pageCount = await this.ghostscript.getPageCount();

                        return { success: true, pages: pageCount };
                    } catch (error) {
                        console.error('PDF 로딩 실패:', error);
                        return { success: false };
                    }
                },

                getPageCount: async () => {
                    if (!this.currentPDFData) {
                        throw new Error('PDF가 로딩되지 않았습니다');
                    }

                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject });

                        this.worker.postMessage({
                            type: 'getPageCount',
                            requestId: reqId,
                            data: {
                                pdfData: this.currentPDFData
                            }
                        });
                    });
                },

                getPageSize: async (pageNum) => {
                    if (!this.currentPDFData) {
                        throw new Error('PDF가 로딩되지 않았습니다');
                    }

                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject });

                        this.worker.postMessage({
                            type: 'getPageSize',
                            requestId: reqId,
                            data: {
                                pdfData: this.currentPDFData,
                                pageNum: pageNum
                            }
                        });
                    });
                },

                renderPage: async (pageNum, options) => {
                    if (!this.currentPDFData) {
                        throw new Error('PDF가 로딩되지 않았습니다');
                    }

                    const payloadOptions = { ...options, pageNum };

                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject, options: payloadOptions });

                        this.worker.postMessage({
                            type: 'process',
                            requestId: reqId,
                            data: {
                                pdfData: this.currentPDFData,
                                options: payloadOptions,
                                pageNum
                            }
                        });
                    });
                },

                getSpotColors: async () => {
                    return ['PANTONE 186 C', 'PANTONE 287 C'];
                },

                getPixelInkValues: async (x, y) => {
                    return {
                        cyan: Math.random() * 100,
                        magenta: Math.random() * 100,
                        yellow: Math.random() * 100,
                        black: Math.random() * 100
                    };
                },

                testTiffsep: async () => {
                    if (!this.currentPDFData) {
                        throw new Error('PDF를 먼저 로딩해주세요');
                    }

                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject });

                        this.worker.postMessage({
                            type: 'testTiffsep',
                            requestId: reqId,
                            data: {
                                pdfData: this.currentPDFData
                            }
                        });
                    });
                },

                listDevices: async () => {
                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject });

                        this.worker.postMessage({
                            type: 'listDevices',
                            requestId: reqId
                        });
                    });
                },

                testDevice: async (device, outputFile) => {
                    if (!this.currentPDFData) {
                        throw new Error('PDF를 먼저 로딩해주세요');
                    }

                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject });

                        this.worker.postMessage({
                            type: 'testDevice',
                            requestId: reqId,
                            data: {
                                pdfData: this.currentPDFData,
                                device: device,
                                outputFile: outputFile
                            }
                        });
                    });
                }
            };

            console.log('Ghostscript WebWorker 준비 완료');
        } catch (error) {
            console.error('Ghostscript WebWorker 초기화 실패:', error);
            this.showError('Ghostscript를 초기화할 수 없습니다.');
        }
    }
    
    async convertTIFFToCMYK(tiffData, width, height) {
        return new Promise((resolve, reject) => {
            try {
                console.log('TIFF 파싱 시작, 크기:', tiffData.length);

                // UTIF로 TIFF 디코딩
                const ifds = UTIF.decode(tiffData.buffer);
                console.log('TIFF IFD 개수:', ifds.length);

                const page = ifds[0];
                UTIF.decodeImage(tiffData.buffer, page);

                console.log('TIFF 이미지 정보:', {
                    width: page.width,
                    height: page.height,
                    bitsPerSample: page.t258,
                    samplesPerPixel: page.t277,
                    photometric: page.t262
                });

                // page.data는 CMYK 픽셀 배열 (각 픽셀당 4바이트: C, M, Y, K)
                const cmykPixels = new Uint8Array(page.data);

                // CMYK 채널 분리
                const pixelCount = page.width * page.height;
                const cyan = new Uint8Array(pixelCount);
                const magenta = new Uint8Array(pixelCount);
                const yellow = new Uint8Array(pixelCount);
                const black = new Uint8Array(pixelCount);

                for (let i = 0; i < pixelCount; i++) {
                    cyan[i] = cmykPixels[i * 4 + 0];
                    magenta[i] = cmykPixels[i * 4 + 1];
                    yellow[i] = cmykPixels[i * 4 + 2];
                    black[i] = cmykPixels[i * 4 + 3];
                }

                console.log('CMYK 채널 분리 완료');

                // CMYK 데이터를 포함한 객체 반환
                resolve({
                    type: 'cmyk',
                    width: page.width,
                    height: page.height,
                    channels: { cyan, magenta, yellow, black }
                });
            } catch (error) {
                console.error('TIFF 파싱 실패:', error);
                reject(error);
            }
        });
    }

    async convertPNGToImageData(pngData, width, height) {
        return new Promise((resolve, reject) => {
            const blob = new Blob([pngData], { type: 'image/png' });
            const img = new Image();

            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');

                ctx.drawImage(img, 0, 0, width, height);
                const imageData = ctx.getImageData(0, 0, width, height);
                URL.revokeObjectURL(img.src);
                resolve(imageData);
            };

            img.onerror = (error) => {
                console.error('PNG 이미지 로딩 실패:', error);
                URL.revokeObjectURL(img.src);
                reject(error);
            };

            img.src = URL.createObjectURL(blob);
        });
    }
    
    buildGhostscriptArgs(options, width, height) {
        const args = [
            '-dNOPAUSE',
            '-dBATCH',
            '-dSAFER',
            '-sDEVICE=pngalpha',
            '-dGraphicsAlphaBits=4',
            '-dTextAlphaBits=4',
            `-r150`,
            `-g${width}x${height}`,
            '-sOutputFile=output.png'
        ];
        
        // CMYK 분판 제어 - Ghostscript의 실제 분판 옵션 사용
        if (options.separations && options.separations.length > 0) {
            // 모든 색상을 끄고 선택된 것만 켜는 방식
            args.push('-dUseCIEColor=true');
            
            if (!options.separations.includes('cyan')) {
                args.push('-dCyan=0');
            }
            if (!options.separations.includes('magenta')) {
                args.push('-dMagenta=0');
            }
            if (!options.separations.includes('yellow')) {
                args.push('-dYellow=0');
            }
            if (!options.separations.includes('black')) {
                args.push('-dBlack=0');
            }
            
            // 별색 처리
            options.separations.forEach(spot => {
                if (!['cyan', 'magenta', 'yellow', 'black'].includes(spot)) {
                    args.push(`-dSpotColor="${spot}"`);
                }
            });
        }
        
        // 오버프린트 시뮬레이션
        if (options.overprint) {
            args.push('-dOverprint=true');
            args.push('-dOverprintMode=1');
        }
        
        // PDF 파일 입력
        args.push('input.pdf');
        
        return args;
    }
    
    async handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file || file.type !== 'application/pdf') {
            this.showError('PDF 파일을 선택해 주세요.');
            return;
        }
        
        try {
            console.log('PDF 파일 로딩:', file.name);
            const arrayBuffer = await file.arrayBuffer();
            await this.loadPDF(arrayBuffer);
        } catch (error) {
            console.error('파일 로딩 실패:', error);
            this.showError('PDF 파일을 로딩할 수 없습니다.');
        }
    }
    
    async loadPDF(data) {
        if (!this.ghostscript) {
            this.showError('Ghostscript가 준비되지 않았습니다.');
            return;
        }

        try {
            const result = await this.ghostscript.loadPDF(data);
            if (result.success) {
                this.currentPDF = data;
                this.totalPages = result.pages;
                this.currentPage = 1;
                console.log('PDF 총 페이지:', this.totalPages);

                await this.loadSpotColors();
                await this.renderCurrentPage();
                console.log('PDF 로딩 성공');
            } else {
                throw new Error('PDF 로딩 실패');
            }
        } catch (error) {
            console.error('PDF 로딩 오류:', error);
            this.showError('PDF를 로딩할 수 없습니다.');
        }
    }
    
    async loadSpotColors() {
        try {
            this.spotColors = await this.ghostscript.getSpotColors();
            this.updateSpotColorControls();
        } catch (error) {
            console.error('별색 정보 로딩 실패:', error);
        }
    }
    
    updateSpotColorControls() {
        this.spotControlsContainer.innerHTML = '';
        
        this.spotColors.forEach((colorName, index) => {
            const controlDiv = document.createElement('div');
            controlDiv.className = 'spot-color-control';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `spot-${index}`;
            checkbox.checked = true;
            checkbox.addEventListener('change', () => this.updateSeparation());
            
            const label = document.createElement('label');
            label.htmlFor = `spot-${index}`;
            label.textContent = colorName;
            
            controlDiv.appendChild(checkbox);
            controlDiv.appendChild(label);
            this.spotControlsContainer.appendChild(controlDiv);
        });
    }
    
    async renderCurrentPage() {
        if (!this.currentPDF || !this.ghostscript) {
            return;
        }

        // 이미 원본 이미지가 있으면 스케일만 적용
        if (this.baseImageData && this.zoomLevel !== this.lastZoomLevel) {
            this.applyZoomAndSeparation();
            this.lastZoomLevel = this.zoomLevel;
            return;
        }

        try {
            // PDF 페이지의 실제 크기 가져오기 (포인트 단위)
            let pageSize;
            let pdfAspectRatio;

            try {
                pageSize = await this.ghostscript.getPageSize(this.currentPage);
                pdfAspectRatio = pageSize.width / pageSize.height;
                console.log('PDF 실제 크기:', pageSize.width, 'x', pageSize.height, '(비율:', pdfAspectRatio.toFixed(2) + ')');
            } catch (error) {
                console.warn('PDF 크기 조회 실패, 기본 비율 사용:', error);
                // 기본값: A4 비율
                pdfAspectRatio = 1 / 1.414;
            }

            // 컨테이너 크기 확인 (padding 제거했으므로 전체 크기 사용)
            const container = this.canvas.parentElement;
            const containerWidth = container.clientWidth;
            const containerHeight = container.clientHeight;

            // 100% 줌일 때 컨테이너 가로에 꽉 차게 표시 (세로는 스크롤)
            let baseWidth = containerWidth;
            let baseHeight = Math.floor(baseWidth / pdfAspectRatio);

            // Ghostscript 렌더링은 실제 표시 크기와 동일하게 (1:1)
            // DPI를 높여서 고해상도를 얻는 방식으로 변경
            const renderWidth = baseWidth;
            const renderHeight = baseHeight;

            const renderOptions = this.buildRenderOptions();
            renderOptions.width = renderWidth;
            renderOptions.height = renderHeight;
            renderOptions.pdfWidth = pageSize?.width || renderWidth;
            renderOptions.pdfHeight = pageSize?.height || renderHeight;
            renderOptions.pageNum = this.currentPage;
            renderOptions.useCMYK = true;  // CMYK TIFF 모드 사용

            console.log('PDF 렌더링 (CMYK 모드):', renderWidth, 'x', renderHeight);

            const imageData = await this.ghostscript.renderPage(this.currentPage, renderOptions);

            this.baseImageData = imageData;
            this.baseWidth = baseWidth;  // 100% 줌일 때의 표시 크기
            this.baseHeight = baseHeight;

            this.applyZoomAndSeparation();
            this.updatePageControls();
            this.lastZoomLevel = this.zoomLevel;
        } catch (error) {
            console.error('페이지 렌더링 실패:', error);
            this.showError('페이지를 렌더링할 수 없습니다.');
        }
    }

    applyZoomAndSeparation() {
        if (!this.baseImageData) {
            console.error('applyZoomAndSeparation: baseImageData가 없습니다');
            return;
        }

        // 줌 적용된 이미지 표시 크기 (baseWidth는 100% 줌 기준)
        const scaledWidth = Math.floor(this.baseWidth * this.zoomLevel);
        const scaledHeight = Math.floor(this.baseHeight * this.zoomLevel);

        // 캔버스 크기 설정
        this.canvas.width = scaledWidth;
        this.canvas.height = scaledHeight;

        // CMYK 데이터인 경우
        if (this.baseImageData.type === 'cmyk') {
            this.renderCMYKWithSeparation(this.baseImageData, scaledWidth, scaledHeight);
        } else {
            // 기존 RGB ImageData 처리
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = this.baseImageData.width;
            tempCanvas.height = this.baseImageData.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.putImageData(this.baseImageData, 0, 0);

            this.ctx.imageSmoothingEnabled = true;
            this.ctx.imageSmoothingQuality = 'high';
            this.ctx.drawImage(tempCanvas, 0, 0, scaledWidth, scaledHeight);

            this.originalImageData = this.ctx.getImageData(0, 0, scaledWidth, scaledHeight);
            this.applyColorSeparation(this.originalImageData);
        }
    }

    goToPage(pageNum) {
        // 유효성 검증
        if (isNaN(pageNum) || pageNum < 1 || pageNum > this.totalPages) {
            console.warn('유효하지 않은 페이지 번호:', pageNum);
            // 현재 페이지로 되돌리기
            this.currentPageInput.value = this.currentPage;
            return;
        }

        if (pageNum !== this.currentPage) {
            this.currentPage = pageNum;
            this.baseImageData = null; // 새 페이지 렌더링 강제
            this.renderCurrentPage();
        }
    }

    goToPreviousPage() {
        if (this.currentPage > 1) {
            this.goToPage(this.currentPage - 1);
        }
    }

    goToNextPage() {
        if (this.currentPage < this.totalPages) {
            this.goToPage(this.currentPage + 1);
        }
    }

    updatePageControls() {
        this.currentPageInput.value = this.currentPage;
        this.currentPageInput.max = this.totalPages;
        this.totalPagesSpan.textContent = this.totalPages;
        this.prevPageBtn.disabled = this.currentPage <= 1;
        this.nextPageBtn.disabled = this.currentPage >= this.totalPages;
    }
    
    buildRenderOptions() {
        const options = {
            width: 800,
            height: 600,
            separations: []
        };

        // CMYK 분판 옵션
        Object.entries(this.cmykCheckboxes).forEach(([color, checkbox]) => {
            if (checkbox.checked) {
                options.separations.push(color);
            }
        });

        return options;
    }
    
    displayImageData(imageData) {
        // 이 함수는 applyZoomAndSeparation에서 처리됨
        // 호환성을 위해 유지
    }

    renderCMYKWithSeparation(cmykData, targetWidth, targetHeight) {
        const { width, height, channels } = cmykData;
        const { cyan, magenta, yellow, black } = channels;

        // 현재 선택된 분판 옵션 가져오기
        const renderOptions = this.buildRenderOptions();
        const separations = renderOptions.separations || [];

        console.log('CMYK 분판 렌더링:', separations);

        // RGB 이미지로 변환 (선택된 채널만 사용)
        const pixelCount = width * height;
        const rgbData = new Uint8ClampedArray(pixelCount * 4);

        for (let i = 0; i < pixelCount; i++) {
            // CMYK 값 (0-255, 255 = 100% 잉크)
            const c = separations.includes('cyan') ? cyan[i] : 0;
            const m = separations.includes('magenta') ? magenta[i] : 0;
            const y = separations.includes('yellow') ? yellow[i] : 0;
            const k = separations.includes('black') ? black[i] : 0;

            // CMYK → RGB 변환
            // CMYK는 0-255 범위이고, 255 = 100% 잉크
            // RGB로 변환 시: R = 255 * (1 - C/255) * (1 - K/255)
            const cNorm = c / 255;
            const mNorm = m / 255;
            const yNorm = y / 255;
            const kNorm = k / 255;

            rgbData[i * 4 + 0] = Math.round(255 * (1 - cNorm) * (1 - kNorm)); // R
            rgbData[i * 4 + 1] = Math.round(255 * (1 - mNorm) * (1 - kNorm)); // G
            rgbData[i * 4 + 2] = Math.round(255 * (1 - yNorm) * (1 - kNorm)); // B
            rgbData[i * 4 + 3] = 255; // Alpha
        }

        // ImageData 생성
        const imageData = new ImageData(rgbData, width, height);

        // 임시 캔버스에 그리기
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(imageData, 0, 0);

        // 스케일링하여 메인 캔버스에 그리기
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        this.ctx.fillStyle = 'white';
        this.ctx.fillRect(0, 0, targetWidth, targetHeight);
        this.ctx.drawImage(tempCanvas, 0, 0, targetWidth, targetHeight);

        // 원본 CMYK 데이터 저장 (TAC 계산용)
        this.originalCMYKData = cmykData;
    }

    applyColorSeparation(imageData) {
        if (!this.originalImageData) {
            this.originalImageData = imageData;
        }

        // 현재 선택된 분판 옵션 가져오기
        const renderOptions = this.buildRenderOptions();
        const separations = renderOptions.separations || [];

        // 원본 이미지 데이터 복사
        const filteredData = new ImageData(
            new Uint8ClampedArray(this.originalImageData.data),
            this.originalImageData.width,
            this.originalImageData.height
        );

        // CMYK 분판 필터 적용
        for (let i = 0; i < filteredData.data.length; i += 4) {
            const r = filteredData.data[i];
            const g = filteredData.data[i + 1];
            const b = filteredData.data[i + 2];

            // RGB를 CMYK로 변환
            const k = 1 - Math.max(r, g, b) / 255;
            const c = k >= 1 ? 0 : (1 - r / 255 - k) / (1 - k);
            const m = k >= 1 ? 0 : (1 - g / 255 - k) / (1 - k);
            const y = k >= 1 ? 0 : (1 - b / 255 - k) / (1 - k);

            // 선택되지 않은 채널 제거
            let filteredC = separations.includes('cyan') ? c : 0;
            let filteredM = separations.includes('magenta') ? m : 0;
            let filteredY = separations.includes('yellow') ? y : 0;
            let filteredK = separations.includes('black') ? k : 0;

            // CMYK를 다시 RGB로 변환
            const newR = 255 * (1 - filteredC) * (1 - filteredK);
            const newG = 255 * (1 - filteredM) * (1 - filteredK);
            const newB = 255 * (1 - filteredY) * (1 - filteredK);

            filteredData.data[i] = newR;
            filteredData.data[i + 1] = newG;
            filteredData.data[i + 2] = newB;
        }

        // 필터링된 이미지 표시 (캔버스 전체)
        this.ctx.putImageData(filteredData, 0, 0);
    }
    
    createDummyImageData(width = 800, height = 600) {
        // 개발/테스트 목적의 더미 이미지 데이터 생성
        console.log(`더미 이미지 생성: ${width}x${height}`);

        // 임시 캔버스를 사용하여 ImageData 생성
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const tempCtx = tempCanvas.getContext('2d');
        const imageData = tempCtx.createImageData(width, height);

        for (let i = 0; i < imageData.data.length; i += 4) {
            // CMYK 패턴 시뮬레이션
            const x = (i / 4) % width;
            const y = Math.floor((i / 4) / width);

            // 현재 활성화된 분판에 따라 색상 조정
            const renderOptions = this.buildRenderOptions();
            const separations = renderOptions.separations || ['cyan', 'magenta', 'yellow', 'black'];

            let r = 0, g = 0, b = 0;

            if (separations.includes('cyan')) {
                r += (1 - (x / width)) * 255 * 0.3;
            }
            if (separations.includes('magenta')) {
                g += (1 - (y / height)) * 255 * 0.3;
            }
            if (separations.includes('yellow')) {
                r += (x / width) * 255 * 0.3;
                g += (x / width) * 255 * 0.3;
            }
            if (separations.includes('black')) {
                const blackAmount = Math.min(x / width, y / height) * 255 * 0.4;
                r = Math.max(0, r - blackAmount);
                g = Math.max(0, g - blackAmount);
                b = Math.max(0, b - blackAmount);
            }

            imageData.data[i] = Math.min(255, r);       // Red
            imageData.data[i + 1] = Math.min(255, g);   // Green
            imageData.data[i + 2] = Math.min(255, b);   // Blue
            imageData.data[i + 3] = 255;                // Alpha
        }

        return imageData;
    }
    
    async updateSeparation() {
        if (this.currentPDF && this.baseImageData) {
            // CMYK 데이터인 경우
            if (this.baseImageData.type === 'cmyk') {
                const scaledWidth = Math.floor(this.baseWidth * this.zoomLevel);
                const scaledHeight = Math.floor(this.baseHeight * this.zoomLevel);
                this.renderCMYKWithSeparation(this.baseImageData, scaledWidth, scaledHeight);
            } else if (this.originalImageData) {
                // 기존 RGB 데이터 처리
                this.applyColorSeparation(this.originalImageData);
            }
        }
    }
    
    async handleMouseMove(event) {
        if (!this.currentPDF) return;

        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        // 화면 좌표를 원본 이미지 좌표로 변환
        const scaledWidth = Math.floor(this.baseWidth * this.zoomLevel);
        const scaledHeight = Math.floor(this.baseHeight * this.zoomLevel);

        const xRatio = x / rect.width;
        const yRatio = y / rect.height;

        const canvasX = Math.floor(xRatio * scaledWidth);
        const canvasY = Math.floor(yRatio * scaledHeight);

        // 범위 체크
        if (canvasX < 0 || canvasX >= scaledWidth || canvasY < 0 || canvasY >= scaledHeight) {
            return;
        }

        this.cursorCoordsElement.textContent = `${canvasX}, ${canvasY}`;

        try {
            let inkValues;

            // CMYK 데이터가 있으면 직접 사용
            if (this.originalCMYKData) {
                const { width, height, channels } = this.originalCMYKData;

                // 스케일 역보정 (화면 좌표 → 원본 TIFF 좌표)
                const origX = Math.floor((canvasX / scaledWidth) * width);
                const origY = Math.floor((canvasY / scaledHeight) * height);
                const pixelIndex = origY * width + origX;

                if (pixelIndex >= 0 && pixelIndex < width * height) {
                    inkValues = {
                        cyan: (channels.cyan[pixelIndex] / 255) * 100,
                        magenta: (channels.magenta[pixelIndex] / 255) * 100,
                        yellow: (channels.yellow[pixelIndex] / 255) * 100,
                        black: (channels.black[pixelIndex] / 255) * 100
                    };
                }
            } else if (this.originalImageData) {
                // 기존 RGB → CMYK 변환 방식
                const pixelIndex = (canvasY * this.originalImageData.width + canvasX) * 4;
                const r = this.originalImageData.data[pixelIndex];
                const g = this.originalImageData.data[pixelIndex + 1];
                const b = this.originalImageData.data[pixelIndex + 2];

                const k = 1 - Math.max(r, g, b) / 255;
                const c = k >= 1 ? 0 : (1 - r / 255 - k) / (1 - k);
                const m = k >= 1 ? 0 : (1 - g / 255 - k) / (1 - k);
                const y = k >= 1 ? 0 : (1 - b / 255 - k) / (1 - k);

                inkValues = {
                    cyan: c * 100,
                    magenta: m * 100,
                    yellow: y * 100,
                    black: k * 100
                };
            }

            if (inkValues) {
                const tac = this.calculateTAC(inkValues);
                this.tacValueElement.textContent = tac.toFixed(1);
            }
        } catch (error) {
            console.error('잉크값 조회 실패:', error);
        }
    }
    
    calculateTAC(inkValues) {
        return inkValues.cyan + inkValues.magenta + inkValues.yellow + inkValues.black;
    }
    
    clearMouseInfo() {
        this.cursorCoordsElement.textContent = '-';
        this.tacValueElement.textContent = '-';
    }
    
    showError(message) {
        // 간단한 오류 표시 (실제 구현에서는 더 정교한 UI 사용)
        alert(message);
        console.error(message);
    }

    // 전역 접근용 tiffsep 테스트 메서드
    async testTiffsep() {
        try {
            console.log('🧪 tiffsep 지원 테스트 시작...');
            const result = await this.ghostscript.testTiffsep();

            if (result.supported) {
                console.log('✅ tiffsep 지원됨!');
                console.log('생성된 파일:', result.files);
                return { supported: true, files: result.files };
            } else {
                console.log('❌ tiffsep 미지원');
                console.log('메시지:', result.message);
                return { supported: false, message: result.message };
            }
        } catch (error) {
            console.error('❌ 테스트 실패:', error);
            return { supported: false, error: error.message };
        }
    }

    // 사용 가능한 디바이스 목록 조회
    async listDevices() {
        try {
            console.log('📋 Ghostscript 디바이스 목록 조회 중...');
            const result = await this.ghostscript.listDevices();

            console.log('사용 가능한 디바이스:', result.devices);

            // CMYK 관련 디바이스 필터링
            const cmykDevices = result.devices.filter(d =>
                d.toLowerCase().includes('cmyk') ||
                d.toLowerCase().includes('tiff') ||
                d.toLowerCase().includes('psd') ||
                d.toLowerCase().includes('sep')
            );

            if (cmykDevices.length > 0) {
                console.log('🎨 CMYK/분판 관련 디바이스:', cmykDevices);
            }

            return result;
        } catch (error) {
            console.error('❌ 디바이스 목록 조회 실패:', error);
            return { devices: [], error: error.message };
        }
    }

    // 특정 디바이스 테스트
    async testDevice(device, outputFile) {
        try {
            console.log(`🧪 ${device} 디바이스 테스트 중...`);
            const result = await this.ghostscript.testDevice(device, outputFile);

            if (result.supported) {
                console.log(`✅ ${device} 성공!`);
                console.log('생성된 파일:', result.files);
                console.log('파일 크기:', result.fileSize, 'bytes');
                return { supported: true, files: result.files, fileSize: result.fileSize };
            } else {
                console.log(`❌ ${device} 실패`);
                console.log('메시지:', result.message);
                return { supported: false, message: result.message };
            }
        } catch (error) {
            console.error(`❌ ${device} 테스트 실패:`, error);
            return { supported: false, error: error.message };
        }
    }
}

// 페이지 로딩 완료 시 애플리케이션 초기화
let viewer;
document.addEventListener('DOMContentLoaded', () => {
    viewer = new PDFSeparationViewer();
    // 콘솔에서 viewer.testTiffsep() 호출 가능하도록 전역 변수로 노출
    window.viewer = viewer;
});
