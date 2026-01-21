import { WorkerPool } from './worker-pool.js';
import { VirtualScrollManager } from './VirtualScrollManager.js';
import { getSpotColorRGB } from './constants.js';

export class PDFSeparationViewer {
    constructor() {
        // 스크롤 뷰어에서는 개별 페이지마다 캔버스가 동적 생성됨
        // 기존 호환성을 위해 더미 캔버스 생성
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.currentPDF = null;
        this.ghostscript = null;
        this.spotColors = [];
        this.gsModule = null;
        this.currentPage = 1;
        this.totalPages = 1;
        this.zoomLevel = 1.0;

        // 전체 페이지 CMYK 채널 누적 데이터
        this.totalChannelCounts = {
            cyan: 0,
            magenta: 0,
            yellow: 0,
            black: 0
        };
        this.totalPixelCount = 0;

        // 페이지별 CMYK 채널 사용량 저장
        this.pageChannelData = {};

        // 병렬 처리용 WorkerPool 설정
        this.workerPool = null;
        this.workerPoolSize = Math.min(navigator.hardwareConcurrency || 4, 3); // 네트워크 부하 방지를 위해 최대 3개로 제한

        // 페이지 캐시 (빠른 페이지 전환용)
        this.pageCache = new Map(); // pageNum -> { imageData, baseWidth, baseHeight, spotColorData }
        this.pageCacheSize = 5; // 최대 캐시 페이지 수
        this.preloadingPages = new Set(); // 현재 프리로딩 중인 페이지

        // 별색 관련 속성
        this.spotColors = [];           // 감지된 별색 이름 목록
        this.spotColorData = {};        // { 'PANTONE 186 C': Uint8Array (그레이스케일) }
        this.spotColorCheckboxes = {};  // { 'PANTONE 186 C': HTMLInputElement }
        this.spotColorRatios = {};      // { 'PANTONE 186 C': 15.3 }
        this.pageSpotColorData = {};    // { pageNum: { 'PANTONE 186 C': count } }

        // 스크롤 뷰어 매니저
        this.scrollManager = null;

        // 페이지 메타데이터 (MediaBox, TrimBox)
        this.pageMetadata = new Map(); // pageNum -> { mediaBox, trimBox }
        this.coverCalculatorInputs = { spine: 0, flap: 0 };
        this.renderDPI = 300; // 기본 DPI (300으로 상향)

        this.initializeElements();
        this.bindEvents();
        this.initializeScrollViewer();
        this.loadGhostscript();
    }

    // 스크롤 뷰어 초기화
    initializeScrollViewer() {
        this.scrollManager = new VirtualScrollManager(this);
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
        this.selectAllCheckbox = document.getElementById('select-all');
        this.cmykCheckboxes = {
            cyan: document.getElementById('cyan'),
            magenta: document.getElementById('magenta'),
            yellow: document.getElementById('yellow'),
            black: document.getElementById('black')
        };
        this.channelRatioElements = {
            cyan: document.getElementById('cyan-ratio'),
            magenta: document.getElementById('magenta-ratio'),
            yellow: document.getElementById('yellow-ratio'),
            black: document.getElementById('black-ratio')
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

        // 로딩 인디케이터
        this.loadingIndicator = document.getElementById('loading-indicator');
        this.loadingText = document.getElementById('loading-text');
        this.loadingProgress = document.getElementById('loading-progress');

        // 스캔 진행률 요소
        this.scanProgressSection = document.getElementById('scan-progress-section');
        this.scanProgressFill = document.getElementById('scan-progress-fill');
        this.scanProgressText = document.getElementById('scan-progress-text');

        // 보기 모드 요소
        this.viewModeSelect = document.getElementById('view-mode');

        // 별색 컨트롤 컨테이너 (Task 2.4)
        this.spotControlsContainer = document.getElementById('spot-color-controls');

        // Task 5.2: 별색 잉크량 정보 컨테이너
        this.spotInkInfoContainer = document.getElementById('spot-ink-info');

        // 페이지 정보 요소 (New)
        this.mediaBoxDimElement = document.getElementById('mediabox-dim');
        this.trimBoxDimElement = document.getElementById('trimbox-dim');

        // 표지 계산기 요소 (New)
        this.spineInput = document.getElementById('spine-width');
        this.flapInput = document.getElementById('flap-width');
        this.coverInput = document.getElementById('cover-width');
        this.marginInput = document.getElementById('flap-margin-width');
        this.calcResultElement = document.getElementById('calc-result');

        // 표지 계산기 입력값 저장 (기본값 설정)
        this.coverCalculatorInputs = {
            spine: 17,
            flap: 90,
            cover: 188,
            margin: 5
        };

        // 렌더링 화질 컨트롤 (New)
        // 렌더링 화질 컨트롤 (New)
        this.qualitySelect = document.getElementById('quality-select');
    }

    showLoading(text = '로딩 중...', progress = '') {
        this.loadingText.textContent = text;
        this.loadingProgress.textContent = progress;
        this.loadingIndicator.classList.remove('hidden');
    }

    hideLoading() {
        this.loadingIndicator.classList.add('hidden');
    }

    updateScanProgress(current, total, estimatedTimeText = '') {
        const percentage = Math.round((current / total) * 100);
        this.scanProgressFill.style.width = `${percentage}%`;

        // Task 6.2: 예상 시간 표시
        let progressText = `${current}/${total} 페이지 (${percentage}%)`;
        if (estimatedTimeText && current === 1) {
            progressText += ` - ${estimatedTimeText}`;
        }

        this.scanProgressText.textContent = progressText;
        this.scanProgressSection.classList.remove('hidden');
    }

    hideScanProgress() {
        this.scanProgressSection.classList.add('hidden');
    }

    bindEvents() {
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

        // 전체 선택 체크박스
        this.selectAllCheckbox.addEventListener('change', () => {
            const isChecked = this.selectAllCheckbox.checked;
            // CMYK 체크박스 선택/해제
            Object.values(this.cmykCheckboxes).forEach(checkbox => {
                checkbox.checked = isChecked;
            });
            // 별색 체크박스는 건드리지 않음 (Task: 별색 체크박스 제거됨)
            this.updateSeparation();
        });

        // 개별 CMYK 체크박스
        Object.values(this.cmykCheckboxes).forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                this.updateSeparation();
                // Task 7: 전체 선택 체크박스 상태 업데이트 (CMYK + 별색 모두 체크)
                this.updateSelectAllCheckbox();
            });
        });

        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseleave', () => this.clearMouseInfo());

        // 줌 컨트롤
        this.zoomSlider.addEventListener('input', (e) => {
            this.zoomLevel = parseInt(e.target.value) / 100;
            this.zoomValue.textContent = e.target.value + '%';
            // 스크롤 뷰어 줌 업데이트
            if (this.scrollManager && this.scrollManager.totalPages > 0) {
                this.scrollManager.updateZoom(this.zoomLevel);
            }
        });

        // 보기 모드 변경
        this.viewModeSelect.addEventListener('change', (e) => {
            const mode = e.target.value;
            if (this.scrollManager) {
                this.scrollManager.setDisplayMode(mode);
            }
        });

        // 페이지 네비게이션 (스크롤 방식)
        this.prevPageBtn.addEventListener('click', () => this.goToPreviousPage());
        this.nextPageBtn.addEventListener('click', () => this.goToNextPage());

        // 페이지 번호 직접 입력
        this.currentPageInput.addEventListener('change', (e) => {
            const pageNum = parseInt(e.target.value);
            this.goToPage(pageNum);
        });
        this.currentPageInput.addEventListener('keydown', (e) => {

            if (e.key === 'Enter') {
                e.preventDefault(); // 폼 제출 방지
                e.stopPropagation(); // 이벤트 전파 차단
                const pageNum = parseInt(e.target.value);

                this.goToPage(pageNum);
                e.target.blur(); // Enter 후 포커스 해제
            }
        });

        // 채널 비율 클릭 이벤트 (이벤트 전파 차단하여 체크박스 해제 방지)
        this.channelRatioElements.cyan.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showChannelPageList('cyan');
        });
        this.channelRatioElements.magenta.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showChannelPageList('magenta');
        });
        this.channelRatioElements.yellow.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showChannelPageList('yellow');
        });
        this.channelRatioElements.black.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showChannelPageList('black');
        });

        // 모달 닫기 버튼
        const closeModalBtn = document.getElementById('close-modal');
        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', () => this.closeChannelPageList());
        }

        // 모달 배경 클릭 시 닫기
        const modal = document.getElementById('page-list-modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeChannelPageList();
                }
            });
        }


        // 표지 계산기 입력 이벤트
        if (this.spineInput && this.flapInput && this.coverInput && this.marginInput) {
            const updateCalc = () => this.calculateCoverSpread();
            this.spineInput.addEventListener('input', (e) => {
                this.coverCalculatorInputs.spine = parseFloat(e.target.value) || 0;
                updateCalc();
            });
            this.flapInput.addEventListener('input', (e) => {
                this.coverCalculatorInputs.flap = parseFloat(e.target.value) || 0;
                updateCalc();
            });
            this.coverInput.addEventListener('input', (e) => {
                this.coverCalculatorInputs.cover = parseFloat(e.target.value) || 0;
                updateCalc();
            });
            this.marginInput.addEventListener('input', (e) => {
                this.coverCalculatorInputs.margin = parseFloat(e.target.value) || 0;
                updateCalc();
            });

            // 초기 계산 실행
            updateCalc();
        }

        // 렌더링 화질 컨트롤 이벤트
        // 렌더링 화질 컨트롤 이벤트
        if (this.qualitySelect) {
            this.qualitySelect.addEventListener('change', (e) => {
                this.renderDPI = parseInt(e.target.value);

                // 설정 변경 시 캐시 비우고 재렌더링
                this.pageCache.clear();
                if (this.scrollManager) {
                    this.scrollManager.updateAllVisiblePages(true); // Ghostscript 재렌더링 강제
                }
            });
        }

        // 사이드바 토글 이벤트
        const toggleLeftBtn = document.getElementById('toggle-left');
        const toggleRightBtn = document.getElementById('toggle-right');
        const leftPanel = document.getElementById('left-panel');
        const rightPanel = document.getElementById('right-panel');
        const container = document.querySelector('.container');

        if (toggleLeftBtn && leftPanel) {
            toggleLeftBtn.addEventListener('click', () => {
                leftPanel.classList.toggle('collapsed');
                container.classList.toggle('left-collapsed');
                toggleLeftBtn.textContent = leftPanel.classList.contains('collapsed') ? '▶' : '◀';

                // 레이아웃 변경 시 캔버스 크기 즉시 재계산
                if (this.scrollManager && this.scrollManager.totalPages > 0) {
                    this.scrollManager.recalculatePageDimensions();
                    this.scrollManager.updateZoom(this.zoomLevel);
                }
            });
        }

        if (toggleRightBtn && rightPanel) {
            toggleRightBtn.addEventListener('click', () => {
                rightPanel.classList.toggle('collapsed');
                container.classList.toggle('right-collapsed');
                toggleRightBtn.textContent = rightPanel.classList.contains('collapsed') ? '◀' : '▶';

                // 레이아웃 변경 시 캔버스 크기 즉시 재계산
                if (this.scrollManager && this.scrollManager.totalPages > 0) {
                    this.scrollManager.recalculatePageDimensions();
                    this.scrollManager.updateZoom(this.zoomLevel);
                }
            });
        }
    }

    async loadGhostscript() {
        try {


            this.worker = new Worker('./ghostscript-worker.js', { type: 'module' });
            this.currentPDFData = null;
            this.requestId = 0;
            this.pendingRequests = new Map();

            // Worker 메시지 핸들러를 한 번만 설정
            this.worker.onmessage = (e) => {
                const { type, requestId, success, data, width, height, message, pageSize, pageCount, supported, files, devices, rawOutput, fileSize, format, channels, spotColors } = e.data;

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

                } else if (type === 'tiffsepResult') {
                    const pending = this.pendingRequests.get(requestId);
                    if (pending) {
                        if (success) {
                            pending.resolve({ channels, spotColors, width, height });
                        } else {
                            pending.reject(new Error(message || 'tiffsep 처리 실패'));
                        }
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

            // 병렬 스캔용 WorkerPool 초기화
            this.workerPool = new WorkerPool('./ghostscript-worker.js', this.workerPoolSize);
            await this.workerPool.init();
            console.log(`WorkerPool initialized with ${this.workerPoolSize} workers for parallel scanning`);

            this.ghostscript = {
                loadPDF: async (data) => {
                    try {
                        this.currentPDFData = new Uint8Array(data);


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
                },

                processTiffsep: async (pdfData, pageNum, dpi) => {
                    const dataToUse = pdfData || this.currentPDFData;
                    if (!dataToUse) {
                        throw new Error('PDF 데이터가 없습니다');
                    }

                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject });

                        this.worker.postMessage({
                            type: 'processTiffsep',
                            requestId: reqId,
                            data: {
                                pdfData: dataToUse,
                                pageNum: pageNum || 1,
                                dpi: dpi || 72
                            }
                        });
                    });
                }
            };


        } catch (error) {
            console.error('Ghostscript WebWorker 초기화 실패:', error);
            this.showError('Ghostscript를 초기화할 수 없습니다.');
        }
    }

    async convertTIFFToCMYK(tiffData, width, height) {
        return new Promise((resolve, reject) => {
            try {
                // UTIF로 TIFF 디코딩
                const ifds = UTIF.decode(tiffData.buffer);

                const page = ifds[0];
                UTIF.decodeImage(tiffData.buffer, page);



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



    async parseSpotColorTIFF(tiffData, colorName) {
        return new Promise((resolve, reject) => {
            try {
                if (!tiffData) {
                    console.warn(`별색 ${colorName} 데이터가 없습니다. 빈 채널로 처리합니다.`);
                    const emptyData = new Uint8Array((this.baseWidth || 800) * (this.baseHeight || 600)).fill(0);
                    resolve({
                        width: this.baseWidth || 800,
                        height: this.baseHeight || 600,
                        data: emptyData
                    });
                    return;
                }



                // UTIF로 TIFF 디코딩
                // Uint8Array의 buffer를 slice하여 올바른 범위만 전달
                const arrayBuffer = tiffData.buffer.slice(
                    tiffData.byteOffset,
                    tiffData.byteOffset + tiffData.byteLength
                );
                const ifds = UTIF.decode(arrayBuffer);

                if (!ifds || ifds.length === 0) {
                    throw new Error('TIFF IFD를 찾을 수 없습니다');
                }

                const page = ifds[0];
                UTIF.decodeImage(arrayBuffer, page);



                // 그레이스케일 채널 데이터 추출 (0-255)
                const pixelCount = page.width * page.height;
                const channelData = new Uint8Array(page.data);



                resolve({
                    width: page.width,
                    height: page.height,
                    data: channelData
                });
            } catch (error) {
                console.error(`별색 ${colorName} TIFF 파싱 실패:`, error);
                // 에러 처리: 파싱 실패 시 빈 채널 반환
                const emptyData = new Uint8Array(this.baseWidth * this.baseHeight).fill(0);
                resolve({
                    width: this.baseWidth || 800,
                    height: this.baseHeight || 600,
                    data: emptyData
                });
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
            // 1단계: PDF 로딩 (33%)
            this.showLoading('PDF 로딩 중...', '33%');

            const result = await this.ghostscript.loadPDF(data);
            if (result.success) {
                this.currentPDF = data;
                this.totalPages = result.pages;
                this.currentPage = 1;


                // 페이지 캐시 클리어
                this.clearPageCache();

                // 전체 페이지 CMYK 데이터 수집 초기화
                this.totalChannelCounts = { cyan: 0, magenta: 0, yellow: 0, black: 0 };
                this.totalPixelCount = 0;

                // 2단계: 초기화 (66%)
                this.showLoading('초기화 중...', '66%');
                await this.loadSpotColors();

                // 3단계: 스크롤 뷰어 초기화 (100%)
                this.showLoading('뷰어 초기화 중...', '100%');

                // 첫 페이지 크기 가져오기
                let aspectRatio = 1 / 1.414; // A4 기본값
                try {
                    const pageSize = await this.ghostscript.getPageSize(1);
                    aspectRatio = pageSize.width / pageSize.height;
                } catch (e) {
                    console.warn('페이지 크기 조회 실패, 기본 비율 사용');
                }

                // 스크롤 뷰어 초기화
                this.scrollManager.init(this.totalPages, aspectRatio);
                this.updatePageControls();

                // 렌더링 완료 후 로딩 숨김
                this.hideLoading();

                // 백그라운드에서 모든 페이지 스캔 (비동기)
                this.scanAllPagesInBackground();

                // 메타데이터 추출 (비동기)
                this.extractPDFMetadata();


            } else {
                throw new Error('PDF 로딩 실패');
            }
        } catch (error) {
            console.error('PDF 로딩 오류:', error);
            this.hideLoading();
            this.showError('PDF를 로딩할 수 없습니다.');
        }
    }

    async scanAllPagesInBackground() {
        // 병렬 처리를 위해 WorkerPool 사용
        const startTime = performance.now();

        // 예상 시간 계산 (병렬 처리로 인해 더 빠름)
        const estimatedTimePerPage = 2;
        const parallelFactor = Math.min(this.workerPoolSize, this.totalPages);
        const estimatedTotalSeconds = Math.ceil((this.totalPages * estimatedTimePerPage) / parallelFactor);
        const estimatedMinutes = Math.ceil(estimatedTotalSeconds / 60);
        const estimatedTimeText = `약 ${estimatedMinutes}분 소요 (${this.workerPoolSize}개 병렬 처리)`;

        // WorkerPool에 PDF 데이터 설정
        if (this.workerPool && this.currentPDFData) {
            this.workerPool.setPDFData(this.currentPDFData);
        }

        const scanWidth = 200;  // 작은 크기로 빠르게
        const scanHeight = 280; // A4 비율 대략

        // 페이지 번호 배열 생성
        const pageNumbers = Array.from({ length: this.totalPages }, (_, i) => i + 1);

        // 완료된 페이지 카운터
        let completedPages = 0;

        // 옵션 생성 함수
        const optionsGenerator = (pageNum) => ({
            width: scanWidth,
            height: scanHeight,
            pdfWidth: scanWidth,
            pdfHeight: scanHeight,
            pageNum: pageNum,
            useCMYK: true,
            separations: []
        });

        // 페이지 완료 콜백 (TIFF 변환 및 UI 업데이트)
        const onPageComplete = async (result) => {
            completedPages++;

            if (result.success && result.result) {
                try {
                    const { format, data, width, height } = result.result;

                    if (format === 'tiff' && data) {
                        // TIFF를 CMYK로 변환
                        const imageData = await this.convertTIFFToCMYK(data, width, height);

                        if (imageData && imageData.type === 'cmyk') {
                            this.accumulateChannelData(imageData, result.pageNum);
                        }
                    }
                } catch (error) {
                    console.error(`페이지 ${result.pageNum} 변환 실패:`, error);
                }
            } else {
                console.error(`페이지 ${result.pageNum} 스캔 실패:`, result.error);
            }

            // UI 업데이트 (throttle: 5페이지마다 또는 마지막 페이지)
            if (completedPages % 5 === 0 || completedPages === this.totalPages) {
                const ratios = this.calculateTotalChannelRatios();
                this.updateChannelRatios(ratios);
                this.updateScanProgress(completedPages, this.totalPages, estimatedTimeText);
            }
        };

        try {
            // WorkerPool이 있으면 병렬 처리, 없으면 순차 처리
            if (this.workerPool) {
                console.log(`병렬 스캔 시작: ${this.totalPages}페이지, ${this.workerPoolSize}개 Worker`);

                // 배치 크기를 Worker 수의 2배로 설정 (메모리와 성능 균형)
                const batchSize = this.workerPoolSize * 2;

                const results = await this.workerPool.renderPagesInBatches(
                    pageNumbers,
                    optionsGenerator,
                    batchSize,
                    onPageComplete
                );

                const endTime = performance.now();
                const elapsedSeconds = ((endTime - startTime) / 1000).toFixed(1);
                console.log(`병렬 스캔 완료: ${this.totalPages}페이지, ${elapsedSeconds}초 소요`);

            } else {
                // Fallback: 기존 순차 처리
                console.log('WorkerPool 없음, 순차 스캔으로 대체');
                for (const pageNum of pageNumbers) {
                    const options = optionsGenerator(pageNum);
                    try {
                        const result = await this.ghostscript.renderPage(pageNum, options);
                        await onPageComplete({ pageNum, result: { format: 'tiff', data: result?.data, width: options.width, height: options.height }, success: true });
                    } catch (error) {
                        await onPageComplete({ pageNum, error, success: false });
                    }
                }
            }

            // 최종 UI 업데이트
            const ratios = this.calculateTotalChannelRatios();
            this.updateChannelRatios(ratios);
            this.updateScanProgress(this.totalPages, this.totalPages, '완료!');

        } catch (error) {
            console.error('병렬 스캔 중 오류:', error);
        }

        // 완료 후 3초 뒤에 진행률 바 숨김
        setTimeout(() => this.hideScanProgress(), 3000);
    }


    async loadSpotColors() {
        try {

            const spotColors = new Set();

            // PDF 데이터에서 /Separation 검색 (제미나이 방식)
            const data = this.currentPDFData;
            const len = data.length;

            const CHUNK_SIZE = 1024 * 1024; // 1MB
            const decoder = new TextDecoder('utf-8', { fatal: false });

            let position = 0;
            while (position < len) {
                const chunk = data.subarray(position, Math.min(position + CHUNK_SIZE, len));
                const text = decoder.decode(chunk);

                // /Separation /Name 검색
                const separationRegex = /\/Separation\s*\/([^\s\[\]\/\(\)<>]+)/g;
                let match;
                while ((match = separationRegex.exec(text)) !== null) {
                    let name = match[1];
                    // PDF Name 이스케이프 처리 (#20 -> space)
                    name = name.replace(/#([0-9A-Fa-f]{2})/g, (m, code) => String.fromCharCode(parseInt(code, 16)));

                    if (name !== 'All' && name !== 'None' && !['Cyan', 'Magenta', 'Yellow', 'Black'].includes(name)) {
                        spotColors.add(name);
                    }
                }

                position += CHUNK_SIZE - 100; // 오버랩 (경계면 절단 방지)
            }

            this.spotColors = Array.from(spotColors).sort();


            // 별색 데이터는 나중에 renderCurrentPage에서 tiffsep으로 로드
            // (제미나이가 만든 구조 유지)
            this.spotColorData = {};

            this.updateSpotColorControls();

        } catch (error) {
            console.error('별색 감지 실패:', error);
            this.spotColors = [];
            this.spotColorData = {};
            this.updateSpotColorControls();
        }
    }

    updateSpotColorControls() {
        // 별색 컨트롤 컨테이너가 없으면 생성하지 않음
        if (!this.spotControlsContainer) {
            console.warn('별색 컨트롤 컨테이너가 없습니다.');
            return;
        }

        // 기존 컨트롤 초기화
        this.spotControlsContainer.innerHTML = '';
        this.spotColorCheckboxes = {};

        // 별색이 없으면 섹션 숨김
        if (!this.spotColors || this.spotColors.length === 0) {
            this.spotControlsContainer.style.display = 'none';
            return;
        }

        // 별색이 있으면 섹션 표시
        this.spotControlsContainer.style.display = 'block';

        // 각 별색에 대한 컨트롤 생성
        this.spotColors.forEach((colorName, index) => {
            const controlDiv = document.createElement('div');
            controlDiv.className = 'control-row';

            // 체크박스 생성
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            const safeId = colorName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
            checkbox.id = `spot-${safeId}`;
            checkbox.checked = true;
            // Task 7: 별색 체크박스 변경 시 렌더링 업데이트 및 전체 선택 상태 업데이트
            checkbox.addEventListener('change', () => {
                this.updateSeparation();
                this.updateSelectAllCheckbox();
            });

            // 레이블 생성 (CMYK와 동일한 스타일)
            const label = document.createElement('label');
            label.htmlFor = checkbox.id;
            label.className = 'color-label spot-color';
            label.textContent = colorName;

            // 비율 표시 요소 생성
            const ratioSpan = document.createElement('span');
            ratioSpan.className = 'channel-ratio';
            ratioSpan.id = `${checkbox.id}-ratio`;
            ratioSpan.textContent = '-';

            // 별색 비율 클릭 이벤트 (이벤트 전파 차단하여 체크박스 해제 방지)
            ratioSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showSpotColorPageList(colorName);
            });

            // 체크박스 참조 저장
            this.spotColorCheckboxes[colorName] = checkbox;

            // DOM에 추가
            // controlDiv.appendChild(checkbox); // UI에서 별색 체크박스 제거
            controlDiv.appendChild(label);
            controlDiv.appendChild(ratioSpan);
            this.spotControlsContainer.appendChild(controlDiv);
        });


    }

    // Task 7: 전체 선택 체크박스 상태 업데이트 헬퍼 메서드
    updateSelectAllCheckbox() {
        // CMYK 체크박스가 모두 체크되어 있는지 확인
        const allCMYKChecked = Object.values(this.cmykCheckboxes).every(cb => cb.checked);

        // 별색 체크박스 확인 로직 제거 (항상 켜져있거나 제어 불가능하므로 CMYK만 확인)

        // CMYK 모두 체크되어 있으면 전체 선택 체크박스도 체크
        this.selectAllCheckbox.checked = allCMYKChecked;
    }



    // PDF 메타데이터 추출 (MediaBox, TrimBox)
    async extractPDFMetadata() {
        if (!this.currentPDF) return;

        try {
            const { PDFDocument } = PDFLib;
            const pdfDoc = await PDFDocument.load(this.currentPDF);
            const pages = pdfDoc.getPages();

            this.pageMetadata.clear();

            pages.forEach((page, index) => {
                const pageNum = index + 1;
                const { width, height } = page.getSize(); // MediaBox (default)

                // MediaBox 가져오기
                const mediaBox = page.getMediaBox();

                // TrimBox 가져오기 (없으면 MediaBox 사용)
                let trimBox = mediaBox;
                try {
                    // 1. getTrimBox() 메서드 시도 (표준)
                    if (typeof page.getTrimBox === 'function') {
                        trimBox = page.getTrimBox();
                    }
                    // 2. node.TrimBox() 접근 시도 (저수준)
                    else if (page.node && page.node.TrimBox) {
                        const entry = page.node.TrimBox();
                        // 배열인지 객체인지 확인
                        if (entry && typeof entry.x === 'number') {
                            trimBox = entry;
                        } else if (Array.isArray(entry) && entry.length === 4) {
                            // [x, y, xmax, ymax] 형태일 수 있음 (PDF 사양)
                            trimBox = {
                                x: entry[0],
                                y: entry[1],
                                width: entry[2] - entry[0],
                                height: entry[3] - entry[1]
                            };
                        }
                    }
                } catch (e) {
                    console.warn(`페이지 ${pageNum} TrimBox 추출 실패, MediaBox로 대체`, e);
                }

                // 유효성 검사: width/height가 없거나 숫자가 아니면 MediaBox 사용
                if (!trimBox || typeof trimBox.width !== 'number' || typeof trimBox.height !== 'number') {
                    trimBox = mediaBox;
                }

                this.pageMetadata.set(pageNum, {
                    mediaBox: { width: mediaBox.width, height: mediaBox.height },
                    trimBox: { width: trimBox.width, height: trimBox.height }
                });
            });

            console.log('PDF 메타데이터 추출 완료:', this.pageMetadata);

            // 현재 페이지 정보 업데이트
            this.updatePageDimensionInfo();
            this.calculateCoverSpread();

        } catch (error) {
            console.error('메타데이터 추출 중 오류:', error);
        }
    }

    // 페이지 치수 정보 업데이트 UI
    updatePageDimensionInfo() {
        const pageNum = this.currentPage;
        const metadata = this.pageMetadata.get(pageNum);

        if (!metadata) {
            if (this.mediaBoxDimElement) this.mediaBoxDimElement.textContent = '-';
            if (this.trimBoxDimElement) this.trimBoxDimElement.textContent = '-';
            return;
        }

        // 포인트 -> mm 변환 (1 pt = 0.352778 mm)
        const ptToMm = 0.352778;

        const mediaW = (metadata.mediaBox.width * ptToMm).toFixed(1);
        const mediaH = (metadata.mediaBox.height * ptToMm).toFixed(1);

        const trimW = (metadata.trimBox.width * ptToMm).toFixed(1);
        const trimH = (metadata.trimBox.height * ptToMm).toFixed(1);

        if (this.mediaBoxDimElement) {
            this.mediaBoxDimElement.textContent = `${mediaW} × ${mediaH} mm`;
        }

        if (this.trimBoxDimElement) {
            this.trimBoxDimElement.textContent = `${trimW} × ${trimH} mm`;
        }

        // 페이지 변경 시 계산기도 업데이트 (TrimBox 기준이므로)
        this.calculateCoverSpread();
    }

    // 표지 펼침면 계산
    // 표지 펼침면 계산 (합계 방식)
    calculateCoverSpread() {
        if (!this.calcResultElement) return;

        // 현재 페이지의 TrimBox 높이 가져오기
        let trimHeightMm = 0;
        const pageNum = this.currentPage;
        const metadata = this.pageMetadata.get(pageNum);
        if (metadata && metadata.trimBox) {
            const ptToMm = 0.352778;
            trimHeightMm = metadata.trimBox.height * ptToMm;
        }

        const spineMm = this.coverCalculatorInputs.spine || 0;
        const flapMm = this.coverCalculatorInputs.flap || 0;
        const coverMm = this.coverCalculatorInputs.cover || 0;
        const marginMm = this.coverCalculatorInputs.margin || 0;

        // 계산: (표지 * 2) + (날개 * 2) + (날개여백 * 2) + 책등
        const totalWidth = (coverMm * 2) + (flapMm * 2) + (marginMm * 2) + spineMm;

        // 소수점 1자리까지 표시
        const totalW_fixed = totalWidth.toFixed(1);
        const height_fixed = trimHeightMm > 0 ? trimHeightMm.toFixed(1) : '0.0';

        // 요청 포맷: 펼침면 너비 : 재단크기세로x입력받은걸로계산한너비 mm
        this.calcResultElement.textContent = `펼침면 너비 : ${height_fixed} x ${totalW_fixed} mm`;
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

        // 캐시에서 페이지 데이터 확인
        const cached = this.pageCache.get(this.currentPage);
        if (cached) {
            this.baseImageData = cached.imageData;
            this.baseWidth = cached.baseWidth;
            this.baseHeight = cached.baseHeight;
            this.spotColorData = cached.spotColorData || {};
            this.applyZoomAndSeparation();
            this.updatePageControls();
            this.lastZoomLevel = this.zoomLevel;
            // 인접 페이지 프리로드
            this.preloadAdjacentPages();
            return;
        }

        try {
            // 페이지 렌더링 및 캐싱
            const pageData = await this.renderPageData(this.currentPage);

            this.baseImageData = pageData.imageData;
            this.baseWidth = pageData.baseWidth;
            this.baseHeight = pageData.baseHeight;
            this.spotColorData = pageData.spotColorData || {};

            // 캐시에 저장
            this.addToCache(this.currentPage, pageData);

            this.applyZoomAndSeparation();
            this.updatePageControls();
            this.lastZoomLevel = this.zoomLevel;

            // 인접 페이지 프리로드
            this.preloadAdjacentPages();

        } catch (error) {
            console.error('페이지 렌더링 실패:', error);
            this.showError('페이지를 렌더링할 수 없습니다.');
        }
    }

    // 페이지 데이터 렌더링 (캐시/프리로드용)
    async renderPageData(pageNum) {
        // PDF 페이지의 실제 크기 가져오기 (포인트 단위)
        let pageSize;
        let pdfAspectRatio;

        try {
            pageSize = await this.ghostscript.getPageSize(pageNum);
            pdfAspectRatio = pageSize.width / pageSize.height;
        } catch (error) {
            console.warn('PDF 크기 조회 실패, 기본 비율 사용:', error);
            pdfAspectRatio = 1 / 1.414;
        }

        // 컨테이너 크기 확인 (스크롤 뷰포트 사용)
        const container = document.getElementById('scroll-viewport');
        const containerWidth = container ? container.clientWidth - 40 : 800; // 40px 패딩

        // 100% 줌일 때 컨테이너 가로에 꽉 차게 표시
        const baseWidth = containerWidth;
        const baseHeight = Math.floor(baseWidth / pdfAspectRatio);
        const renderWidth = baseWidth;
        const renderHeight = baseHeight;

        let imageData = null;
        let spotColorData = {};

        // 별색이 있으면 tiffsep으로 렌더링 시도
        const hasSpotColors = this.spotColors && this.spotColors.length > 0;
        let tiffsepSuccessful = false;

        if (hasSpotColors) {
            try {
                const result = await this.ghostscript.processTiffsep(
                    this.currentPDFData,
                    pageNum,
                    this.renderDPI
                );

                if (result && result.channels && Object.keys(result.channels).length > 0) {
                    const { channels, width, height } = result;

                    const cyanParsed = await this.parseSpotColorTIFF(channels['Cyan'], 'Cyan');
                    const magentaParsed = await this.parseSpotColorTIFF(channels['Magenta'], 'Magenta');
                    const yellowParsed = await this.parseSpotColorTIFF(channels['Yellow'], 'Yellow');
                    const blackParsed = await this.parseSpotColorTIFF(channels['Black'], 'Black');

                    imageData = {
                        type: 'cmyk',
                        width: width || cyanParsed.width,
                        height: height || cyanParsed.height,
                        channels: {
                            cyan: cyanParsed.data,
                            magenta: magentaParsed.data,
                            yellow: yellowParsed.data,
                            black: blackParsed.data
                        }
                    };

                    for (const colorName of this.spotColors) {
                        if (channels[colorName]) {
                            const parsed = await this.parseSpotColorTIFF(channels[colorName], colorName);
                            spotColorData[colorName] = parsed.data;
                        }
                    }
                    tiffsepSuccessful = true;
                }
            } catch (error) {
                console.error('tiffsep 렌더링 오류:', error);
            }
        }

        if (!tiffsepSuccessful) {
            const renderOptions = this.buildRenderOptions();
            renderOptions.width = renderWidth;
            renderOptions.height = renderHeight;
            renderOptions.pdfWidth = pageSize?.width || renderWidth;
            renderOptions.pdfHeight = pageSize?.height || renderHeight;
            renderOptions.pageNum = pageNum;
            renderOptions.useCMYK = true;
            renderOptions.dpi = this.renderDPI; // DPI 명시적 전달

            imageData = await this.ghostscript.renderPage(pageNum, renderOptions);
        }

        return { imageData, baseWidth, baseHeight, spotColorData };
    }

    // 캐시에 페이지 추가
    addToCache(pageNum, pageData) {
        // 캐시가 가득 차면 가장 오래된 항목 제거
        if (this.pageCache.size >= this.pageCacheSize) {
            const firstKey = this.pageCache.keys().next().value;
            this.pageCache.delete(firstKey);
        }
        this.pageCache.set(pageNum, pageData);
    }

    // 인접 페이지 프리로드
    preloadAdjacentPages() {
        const pagesToPreload = [];

        // 다음 2페이지, 이전 1페이지 프리로드
        if (this.currentPage < this.totalPages) {
            pagesToPreload.push(this.currentPage + 1);
        }
        if (this.currentPage + 1 < this.totalPages) {
            pagesToPreload.push(this.currentPage + 2);
        }
        if (this.currentPage > 1) {
            pagesToPreload.push(this.currentPage - 1);
        }

        for (const pageNum of pagesToPreload) {
            // 이미 캐시에 있거나 프리로딩 중이면 스킵
            if (this.pageCache.has(pageNum) || this.preloadingPages.has(pageNum)) {
                continue;
            }

            this.preloadingPages.add(pageNum);

            // 백그라운드에서 프리로드 (에러 무시)
            this.renderPageData(pageNum)
                .then(pageData => {
                    this.addToCache(pageNum, pageData);
                })
                .catch(() => { })
                .finally(() => {
                    this.preloadingPages.delete(pageNum);
                });
        }
    }

    // PDF 로드 시 캐시 클리어
    clearPageCache() {
        this.pageCache.clear();
        this.preloadingPages.clear();
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
            // 별색 데이터가 있고 선택된 별색이 있으면 renderWithSpotColors 사용
            const hasSpotColorData = this.spotColorData && Object.keys(this.spotColorData).length > 0;
            const hasSelectedSpotColors = this.spotColors.some(colorName => {
                const checkbox = this.spotColorCheckboxes[colorName];
                return checkbox && checkbox.checked;
            });

            if (hasSpotColorData && hasSelectedSpotColors) {
                this.renderWithSpotColors(this.baseImageData, scaledWidth, scaledHeight);
            } else {
                this.renderCMYKWithSeparation(this.baseImageData, scaledWidth, scaledHeight);
            }
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

        // 스크롤 뷰어 모드: 해당 페이지로 스크롤
        if (this.scrollManager && this.scrollManager.totalPages > 0) {
            this.scrollManager.scrollToPage(pageNum);
            this.currentPage = pageNum;
            this.updatePageControls();
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

    renderWithSpotColors(cmykData, targetWidth, targetHeight) {
        const { width, height, channels } = cmykData;
        const { cyan, magenta, yellow, black } = channels;

        // 현재 선택된 분판 옵션 가져오기
        const renderOptions = this.buildRenderOptions();
        const separations = renderOptions.separations || [];

        // 선택된 별색 필터링
        const selectedSpotColors = this.spotColors.filter(colorName => {
            const checkbox = this.spotColorCheckboxes[colorName];
            return checkbox && checkbox.checked;
        });



        // RGB 이미지로 변환 (CMYK + 별색 합성)
        const pixelCount = width * height;
        const rgbData = new Uint8ClampedArray(pixelCount * 4);

        for (let i = 0; i < pixelCount; i++) {
            // 1. CMYK → RGB 변환 (선택된 채널만)
            const c = separations.includes('cyan') ? cyan[i] : 0;
            const m = separations.includes('magenta') ? magenta[i] : 0;
            const y = separations.includes('yellow') ? yellow[i] : 0;
            const k = separations.includes('black') ? black[i] : 0;

            const cNorm = c / 255;
            const mNorm = m / 255;
            const yNorm = y / 255;
            const kNorm = k / 255;

            let r = 255 * (1 - cNorm) * (1 - kNorm);
            let g = 255 * (1 - mNorm) * (1 - kNorm);
            let b = 255 * (1 - yNorm) * (1 - kNorm);

            // 2. 각 별색 적용 (곱셈 블렌딩으로 오버프린트 효과 시뮬레이션)
            for (const colorName of selectedSpotColors) {
                const spotData = this.spotColorData[colorName];
                if (!spotData) continue;

                // 별색의 그레이스케일 강도 (0-255)
                const intensity = spotData[i] / 255;  // 0-1 범위로 정규화

                if (intensity > 0) {
                    // 별색의 RGB 근사값 가져오기
                    const spotRGB = getSpotColorRGB(colorName);

                    // 곱셈 블렌딩: 별색이 있는 부분은 해당 색상으로 어둡게
                    // intensity가 1이면 완전히 별색, 0이면 영향 없음
                    r *= (1 - intensity) + intensity * (spotRGB.r / 255);
                    g *= (1 - intensity) + intensity * (spotRGB.g / 255);
                    b *= (1 - intensity) + intensity * (spotRGB.b / 255);
                }
            }

            rgbData[i * 4 + 0] = Math.round(Math.max(0, Math.min(255, r))); // R
            rgbData[i * 4 + 1] = Math.round(Math.max(0, Math.min(255, g))); // G
            rgbData[i * 4 + 2] = Math.round(Math.max(0, Math.min(255, b))); // B
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

    renderWithSpotColors(cmykData, targetWidth, targetHeight) {
        const { width, height, channels } = cmykData;
        const { cyan, magenta, yellow, black } = channels;

        // 현재 선택된 분판 옵션 가져오기
        const renderOptions = this.buildRenderOptions();
        const separations = renderOptions.separations || [];

        // 선택된 별색 필터링
        const selectedSpotColors = this.spotColors.filter(colorName => {
            const checkbox = this.spotColorCheckboxes[colorName];
            return checkbox && checkbox.checked;
        });

        console.log('CMYK + 별색 렌더링:', separations, '별색:', selectedSpotColors);

        // RGB 이미지로 변환 (CMYK + 별색 합성)
        const pixelCount = width * height;
        const rgbData = new Uint8ClampedArray(pixelCount * 4);

        for (let i = 0; i < pixelCount; i++) {
            // 1. CMYK → RGB 변환 (선택된 채널만)
            const c = separations.includes('cyan') ? cyan[i] : 0;
            const m = separations.includes('magenta') ? magenta[i] : 0;
            const y = separations.includes('yellow') ? yellow[i] : 0;
            const k = separations.includes('black') ? black[i] : 0;

            const cNorm = c / 255;
            const mNorm = m / 255;
            const yNorm = y / 255;
            const kNorm = k / 255;

            let r = 255 * (1 - cNorm) * (1 - kNorm);
            let g = 255 * (1 - mNorm) * (1 - kNorm);
            let b = 255 * (1 - yNorm) * (1 - kNorm);

            // 2. 각 별색 적용 (곱셈 블렌딩으로 오버프린트 효과 시뮬레이션)
            for (const colorName of selectedSpotColors) {
                const spotData = this.spotColorData[colorName];
                if (!spotData) continue;

                // 별색의 그레이스케일 강도 (0-255)
                const intensity = spotData[i] / 255;  // 0-1 범위로 정규화

                if (intensity > 0) {
                    // 별색의 RGB 근사값 가져오기
                    const spotRGB = getSpotColorRGB(colorName);

                    // 곱셈 블렌딩: 별색이 있는 부분은 해당 색상으로 어둡게
                    // intensity가 1이면 완전히 별색, 0이면 영향 없음
                    r *= (1 - intensity) + intensity * (spotRGB.r / 255);
                    g *= (1 - intensity) + intensity * (spotRGB.g / 255);
                    b *= (1 - intensity) + intensity * (spotRGB.b / 255);
                }
            }

            rgbData[i * 4 + 0] = Math.round(Math.max(0, Math.min(255, r))); // R
            rgbData[i * 4 + 1] = Math.round(Math.max(0, Math.min(255, g))); // G
            rgbData[i * 4 + 2] = Math.round(Math.max(0, Math.min(255, b))); // B
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

    accumulateChannelData(cmykData, pageNum) {
        // 페이지별 CMYK 데이터를 누적
        if (!cmykData || cmykData.type !== 'cmyk') {
            return;
        }

        const { width, height, channels } = cmykData;
        const { cyan, magenta, yellow, black } = channels;
        const totalPixels = width * height;

        // 페이지별 카운트 초기화
        if (!this.pageChannelData[pageNum]) {
            this.pageChannelData[pageNum] = {
                cyan: 0,
                magenta: 0,
                yellow: 0,
                black: 0,
                totalPixels: totalPixels
            };
        }

        // 각 채널에서 잉크가 있는 픽셀 수 카운트 (0이 아닌 값)
        for (let i = 0; i < totalPixels; i++) {
            if (cyan[i] > 0) {
                this.totalChannelCounts.cyan++;
                this.pageChannelData[pageNum].cyan++;
            }
            if (magenta[i] > 0) {
                this.totalChannelCounts.magenta++;
                this.pageChannelData[pageNum].magenta++;
            }
            if (yellow[i] > 0) {
                this.totalChannelCounts.yellow++;
                this.pageChannelData[pageNum].yellow++;
            }
            if (black[i] > 0) {
                this.totalChannelCounts.black++;
                this.pageChannelData[pageNum].black++;
            }
        }

        this.totalPixelCount += totalPixels;
    }

    accumulateSpotColorData(spotColorChannels, pageNum, width, height) {
        // 페이지별 별색 데이터를 누적
        if (!spotColorChannels || Object.keys(spotColorChannels).length === 0) {
            return;
        }

        const totalPixels = width * height;

        // 페이지별 별색 데이터 초기화
        if (!this.pageSpotColorData[pageNum]) {
            this.pageSpotColorData[pageNum] = {
                totalPixels: totalPixels
            };
        }

        // 각 별색에 대해 잉크 사용 픽셀 카운트
        for (const colorName of this.spotColors) {
            const channelData = spotColorChannels[colorName];
            if (!channelData) continue;

            // 별색 카운트 초기화
            if (!this.pageSpotColorData[pageNum][colorName]) {
                this.pageSpotColorData[pageNum][colorName] = 0;
            }

            // 전체 문서 별색 카운트 초기화
            if (!this.totalChannelCounts[colorName]) {
                this.totalChannelCounts[colorName] = 0;
            }

            // 잉크가 있는 픽셀 수 카운트 (0이 아닌 값)
            for (let i = 0; i < totalPixels; i++) {
                if (channelData[i] > 0) {
                    this.totalChannelCounts[colorName]++;
                    this.pageSpotColorData[pageNum][colorName]++;
                }
            }
        }

        console.log(`페이지 ${pageNum} 별색 데이터 누적 완료`);
    }

    accumulateSpotColorData(spotColorChannels, pageNum, width, height) {
        // 페이지별 별색 데이터를 누적
        if (!spotColorChannels || Object.keys(spotColorChannels).length === 0) {
            return;
        }

        const totalPixels = width * height;

        // 페이지별 별색 데이터 초기화
        if (!this.pageSpotColorData[pageNum]) {
            this.pageSpotColorData[pageNum] = {
                totalPixels: totalPixels
            };
        }

        // 각 별색에 대해 잉크 사용 픽셀 카운트
        for (const colorName of this.spotColors) {
            const channelData = spotColorChannels[colorName];
            if (!channelData) continue;

            // 별색 카운트 초기화
            if (!this.pageSpotColorData[pageNum][colorName]) {
                this.pageSpotColorData[pageNum][colorName] = 0;
            }

            // 전체 문서 별색 카운트 초기화
            if (!this.totalChannelCounts[colorName]) {
                this.totalChannelCounts[colorName] = 0;
            }

            // 잉크가 있는 픽셀 수 카운트 (0이 아닌 값)
            for (let i = 0; i < totalPixels; i++) {
                if (channelData[i] > 0) {
                    this.totalChannelCounts[colorName]++;
                    this.pageSpotColorData[pageNum][colorName]++;
                }
            }
        }

        console.log(`페이지 ${pageNum} 별색 데이터 누적 완료`);
    }

    calculateTotalChannelRatios() {
        // 전체 페이지의 누적된 데이터로부터 비율 계산
        if (this.totalPixelCount === 0) {
            return null;
        }

        return {
            cyan: (this.totalChannelCounts.cyan / this.totalPixelCount) * 100,
            magenta: (this.totalChannelCounts.magenta / this.totalPixelCount) * 100,
            yellow: (this.totalChannelCounts.yellow / this.totalPixelCount) * 100,
            black: (this.totalChannelCounts.black / this.totalPixelCount) * 100
        };
    }

    calculateSpotColorRatios() {
        // 전체 페이지의 누적 데이터로 별색 비율 계산
        if (this.totalPixelCount === 0 || !this.spotColors || this.spotColors.length === 0) {
            return null;
        }

        const ratios = {};

        // 각 별색의 사용 비율을 백분율로 계산
        for (const colorName of this.spotColors) {
            const count = this.totalChannelCounts[colorName] || 0;
            ratios[colorName] = (count / this.totalPixelCount) * 100;
        }

        return ratios;
    }

    calculateSpotColorRatios() {
        // 전체 페이지의 누적 데이터로 별색 비율 계산
        if (this.totalPixelCount === 0 || !this.spotColors || this.spotColors.length === 0) {
            return null;
        }

        const ratios = {};

        // 각 별색의 사용 비율을 백분율로 계산
        for (const colorName of this.spotColors) {
            const count = this.totalChannelCounts[colorName] || 0;
            ratios[colorName] = (count / this.totalPixelCount) * 100;
        }

        return ratios;
    }

    updateChannelRatios(ratios) {
        if (!ratios) {
            // 비율 정보가 없으면 '-' 표시
            Object.values(this.channelRatioElements).forEach(el => {
                el.textContent = '-';
            });
            // progress bar 초기화
            Object.keys(this.channelRatioElements).forEach(channel => {
                const label = document.querySelector(`.color-label.${channel}`);
                if (label) {
                    label.style.backgroundSize = '0% 100%';
                }
            });
            return;
        }

        // 각 채널의 비율을 소수점 1자리까지 표시
        this.channelRatioElements.cyan.textContent = `${ratios.cyan.toFixed(1)}%`;
        this.channelRatioElements.magenta.textContent = `${ratios.magenta.toFixed(1)}%`;
        this.channelRatioElements.yellow.textContent = `${ratios.yellow.toFixed(1)}%`;
        this.channelRatioElements.black.textContent = `${ratios.black.toFixed(1)}%`;

        // progress bar 업데이트 (각 채널의 비율만큼 배경 표시)
        const updateProgress = (channel, ratio) => {
            const label = document.querySelector(`.color-label.${channel}`);
            if (label) {
                label.style.backgroundSize = `${ratio}% 100%`;
            }
        };

        updateProgress('cyan', ratios.cyan);
        updateProgress('magenta', ratios.magenta);
        updateProgress('yellow', ratios.yellow);
        updateProgress('black', ratios.black);
    }

    updateSpotColorRatios(ratios) {
        // 별색 비율 UI 업데이트
        if (!ratios || !this.spotColors || this.spotColors.length === 0) {
            // 비율 정보가 없으면 모든 별색 비율을 '-'로 표시
            this.spotColors.forEach(colorName => {
                const safeId = colorName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
                const ratioElement = document.getElementById(`spot-${safeId}-ratio`);
                if (ratioElement) {
                    ratioElement.textContent = '-';
                }

                // progress bar 초기화
                const checkbox = this.spotColorCheckboxes[colorName];
                if (checkbox) {
                    const label = document.querySelector(`label[for="${checkbox.id}"]`);
                    if (label) {
                        label.style.backgroundSize = '0% 100%';
                    }
                }
            });
            return;
        }

        // 각 별색의 비율을 소수점 1자리까지 표시
        this.spotColors.forEach(colorName => {
            const ratio = ratios[colorName] || 0;
            const safeId = colorName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
            const ratioElement = document.getElementById(`spot-${safeId}-ratio`);

            if (ratioElement) {
                ratioElement.textContent = `${ratio.toFixed(1)}%`;
            }

            // progress bar 업데이트 (프로그레스 바 스타일로 시각화)
            const checkbox = this.spotColorCheckboxes[colorName];
            if (checkbox) {
                const label = document.querySelector(`label[for="${checkbox.id}"]`);
                if (label) {
                    label.style.backgroundSize = `${ratio}% 100%`;
                }
            }
        });

        // 별색 비율을 spotColorRatios 객체에 저장
        this.spotColorRatios = ratios;

        console.log('별색 비율 UI 업데이트 완료:', ratios);
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
        // 스크롤 뷰어 모드: 모든 보이는 페이지 리렌더링
        if (this.scrollManager && this.scrollManager.totalPages > 0) {
            this.scrollManager.updateAllVisiblePages();
            return;
        }

        // 기존 단일 페이지 모드 (폴백)
        if (this.currentPDF && this.baseImageData) {
            // CMYK 데이터인 경우
            if (this.baseImageData.type === 'cmyk') {
                const scaledWidth = Math.floor(this.baseWidth * this.zoomLevel);
                const scaledHeight = Math.floor(this.baseHeight * this.zoomLevel);

                // 별색 데이터가 있고 선택된 별색이 있으면 renderWithSpotColors 사용
                const hasSpotColorData = this.spotColorData && Object.keys(this.spotColorData).length > 0;
                const hasSelectedSpotColors = this.spotColors.some(colorName => {
                    const checkbox = this.spotColorCheckboxes[colorName];
                    return checkbox && checkbox.checked;
                });

                if (hasSpotColorData && hasSelectedSpotColors) {
                    this.renderWithSpotColors(this.baseImageData, scaledWidth, scaledHeight);
                } else {
                    this.renderCMYKWithSeparation(this.baseImageData, scaledWidth, scaledHeight);
                }
            } else if (this.originalImageData) {
                // 기존 RGB 데이터 처리
                this.applyColorSeparation(this.originalImageData);
            }
        }
    }

    // 현재 분판 설정 가져오기
    getCurrentSeparations() {
        const separations = {
            cyan: this.cmykCheckboxes.cyan?.checked ?? true,
            magenta: this.cmykCheckboxes.magenta?.checked ?? true,
            yellow: this.cmykCheckboxes.yellow?.checked ?? true,
            black: this.cmykCheckboxes.black?.checked ?? true,
            spotColors: {}
        };

        // 별색 체크박스 상태
        for (const colorName of this.spotColors) {
            const checkbox = this.spotColorCheckboxes[colorName];
            separations.spotColors[colorName] = checkbox?.checked ?? true;
        }

        return separations;
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
            let spotColorInkValues = {};

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

                    // Task 5.1: 별색 잉크량 계산
                    // 커서 위치의 각 별색 채널 값 추출
                    if (this.spotColorData && Object.keys(this.spotColorData).length > 0) {
                        for (const colorName of this.spotColors) {
                            const spotData = this.spotColorData[colorName];
                            if (spotData && pixelIndex < spotData.length) {
                                // 별색 잉크량을 백분율로 계산 (0-255 → 0-100%)
                                spotColorInkValues[colorName] = (spotData[pixelIndex] / 255) * 100;
                            }
                        }
                    }
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

                // Task 5.2: 별색 잉크량 UI 업데이트
                this.updateSpotColorInkInfo(spotColorInkValues);
            }
        } catch (error) {
            console.error('잉크값 조회 실패:', error);
        }
    }

    calculateTAC(inkValues) {
        return inkValues.cyan + inkValues.magenta + inkValues.yellow + inkValues.black;
    }

    // Task 5.2: 별색 잉크량 UI 업데이트
    updateSpotColorInkInfo(spotColorInkValues) {
        // 별색 잉크량을 CMYK TAC 아래에 표시
        if (!this.spotInkInfoContainer) {
            return;
        }

        // 별색이 없거나 별색 데이터가 없으면 숨김
        if (!this.spotColors || this.spotColors.length === 0 ||
            !spotColorInkValues || Object.keys(spotColorInkValues).length === 0) {
            this.spotInkInfoContainer.innerHTML = '';
            this.spotInkInfoContainer.style.display = 'none';
            return;
        }

        // 별색 잉크량 표시
        this.spotInkInfoContainer.style.display = 'block';

        // 각 별색별로 잉크량 표시
        const spotColorHTML = this.spotColors.map(colorName => {
            const inkValue = spotColorInkValues[colorName];
            if (inkValue !== undefined) {
                return `
                    <div class="spot-ink-item">
                        <span class="spot-ink-label">${colorName}:</span>
                        <span class="spot-ink-value">${inkValue.toFixed(1)}%</span>
                    </div>
                `;
            }
            return '';
        }).filter(html => html !== '').join('');

        // 실시간 업데이트
        this.spotInkInfoContainer.innerHTML = spotColorHTML;
    }

    clearMouseInfo() {
        this.cursorCoordsElement.textContent = '-';
        this.tacValueElement.textContent = '-';

        // Task 5.2: 별색 잉크량 정보도 초기화
        if (this.spotInkInfoContainer) {
            this.spotInkInfoContainer.innerHTML = '';
            this.spotInkInfoContainer.style.display = 'none';
        }
    }

    // 스크롤 뷰어용 개별 페이지 캔버스 마우스 이벤트 핸들러
    handleCanvasMouseMove(event, pageNum, canvas, pageData) {
        if (!this.currentPDF || !pageData || !pageData.imageData) return;

        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        // 캔버스 실제 크기와 표시 크기 비율 계산
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;

        const canvasX = Math.floor(x * scaleX);
        const canvasY = Math.floor(y * scaleY);

        // 범위 체크
        if (canvasX < 0 || canvasX >= canvas.width || canvasY < 0 || canvasY >= canvas.height) {
            return;
        }

        this.cursorCoordsElement.textContent = `${canvasX}, ${canvasY} (p.${pageNum})`;

        try {
            let inkValues;
            let spotColorInkValues = {};
            const imgData = pageData.imageData;

            // CMYK 타입 데이터 (tiffsep 또는 ghostscript CMYK 출력)
            if (imgData.type === 'cmyk' && imgData.channels) {
                const { width, height, channels } = imgData;

                // 캔버스 좌표를 원본 CMYK 데이터 좌표로 변환
                const origX = Math.floor((canvasX / canvas.width) * width);
                const origY = Math.floor((canvasY / canvas.height) * height);
                const pixelIndex = origY * width + origX;

                if (pixelIndex >= 0 && pixelIndex < width * height) {
                    inkValues = {
                        cyan: (channels.cyan[pixelIndex] / 255) * 100,
                        magenta: (channels.magenta[pixelIndex] / 255) * 100,
                        yellow: (channels.yellow[pixelIndex] / 255) * 100,
                        black: (channels.black[pixelIndex] / 255) * 100
                    };

                    // 별색 잉크량 계산
                    if (pageData.spotColorData && Object.keys(pageData.spotColorData).length > 0) {
                        for (const colorName of Object.keys(pageData.spotColorData)) {
                            const spotData = pageData.spotColorData[colorName];
                            if (spotData && pixelIndex < spotData.length) {
                                spotColorInkValues[colorName] = (spotData[pixelIndex] / 255) * 100;
                            }
                        }
                    }
                }
            } else if (imgData.data) {
                // RGB ImageData에서 CMYK 근사 계산
                const imgWidth = imgData.width;
                const imgHeight = imgData.height;

                const origX = Math.floor((canvasX / canvas.width) * imgWidth);
                const origY = Math.floor((canvasY / canvas.height) * imgHeight);
                const pixelIndex = (origY * imgWidth + origX) * 4;

                if (pixelIndex >= 0 && pixelIndex < imgData.data.length - 3) {
                    const r = imgData.data[pixelIndex];
                    const g = imgData.data[pixelIndex + 1];
                    const b = imgData.data[pixelIndex + 2];

                    const k = 1 - Math.max(r, g, b) / 255;
                    const c = k >= 1 ? 0 : (1 - r / 255 - k) / (1 - k);
                    const m = k >= 1 ? 0 : (1 - g / 255 - k) / (1 - k);
                    const yVal = k >= 1 ? 0 : (1 - b / 255 - k) / (1 - k);

                    inkValues = {
                        cyan: c * 100,
                        magenta: m * 100,
                        yellow: yVal * 100,
                        black: k * 100
                    };
                }
            }

            if (inkValues) {
                const tac = this.calculateTAC(inkValues);
                this.tacValueElement.textContent = tac.toFixed(1);
                this.updateSpotColorInkInfo(spotColorInkValues);
            }
        } catch (error) {
            console.error('잉크값 조회 실패:', error);
        }
    }

    updateSpotColorRatios(ratios) {
        // 별색 비율 UI 업데이트
        if (!ratios || !this.spotColors || this.spotColors.length === 0) {
            // 비율 정보가 없으면 모든 별색 비율을 '-'로 표시
            this.spotColors.forEach(colorName => {
                const safeId = colorName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
                const ratioElement = document.getElementById(`spot-${safeId}-ratio`);
                if (ratioElement) {
                    ratioElement.textContent = '-';
                }

                // progress bar 초기화
                const checkbox = this.spotColorCheckboxes[colorName];
                if (checkbox) {
                    const label = document.querySelector(`label[for="${checkbox.id}"]`);
                    if (label) {
                        label.style.backgroundSize = '0% 100%';
                    }
                }
            });
            return;
        }

        // 각 별색의 비율을 소수점 1자리까지 표시
        this.spotColors.forEach(colorName => {
            const ratio = ratios[colorName] || 0;
            const safeId = colorName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
            const ratioElement = document.getElementById(`spot-${safeId}-ratio`);

            if (ratioElement) {
                ratioElement.textContent = `${ratio.toFixed(1)}%`;
            }

            // progress bar 업데이트
            const checkbox = this.spotColorCheckboxes[colorName];
            if (checkbox) {
                const label = document.querySelector(`label[for="${checkbox.id}"]`);
                if (label) {
                    label.style.backgroundSize = `${ratio}% 100%`;
                }
            }
        });
    }

    showChannelPageList(channel) {
        // 해당 채널을 사용하는 페이지 목록 표시
        const channelNames = {
            cyan: 'Cyan (C)',
            magenta: 'Magenta (M)',
            yellow: 'Yellow (Y)',
            black: 'Black (K)'
        };

        // 페이지별 사용량 수집 및 정렬
        const pageList = [];
        for (const pageNum in this.pageChannelData) {
            const pageData = this.pageChannelData[pageNum];
            const usage = pageData[channel];
            if (usage > 0) {
                const ratio = (usage / pageData.totalPixels) * 100;
                pageList.push({ pageNum: parseInt(pageNum), usage, ratio });
            }
        }

        // 사용량 많은 순으로 정렬
        pageList.sort((a, b) => b.usage - a.usage);

        // 모달에 표시
        const modal = document.getElementById('page-list-modal');
        const channelNameEl = document.getElementById('modal-channel-name');
        const pageListEl = document.getElementById('page-list');

        channelNameEl.textContent = channelNames[channel];

        if (pageList.length === 0) {
            pageListEl.innerHTML = '<p class="no-pages">이 채널을 사용하는 페이지가 없습니다.</p>';
        } else {
            pageListEl.innerHTML = pageList.map(item =>
                `<div class="page-item" data-page="${item.pageNum}">
                    페이지 ${item.pageNum} <span class="page-ratio">(${item.ratio.toFixed(1)}%)</span>
                </div>`
            ).join('');

            // 페이지 아이템 클릭 이벤트
            pageListEl.querySelectorAll('.page-item').forEach(el => {
                el.addEventListener('click', () => {
                    const pageNum = parseInt(el.dataset.page);
                    this.goToPage(pageNum);
                    this.closeChannelPageList();
                });
            });
        }

        modal.classList.remove('hidden');
    }

    showSpotColorPageList(colorName) {
        // 해당 별색을 사용하는 페이지 목록 표시

        // 페이지별 사용량 수집 및 정렬
        const pageList = [];
        for (const pageNum in this.pageSpotColorData) {
            const pageData = this.pageSpotColorData[pageNum];
            const usage = pageData[colorName];
            if (usage && usage > 0) {
                const ratio = (usage / pageData.totalPixels) * 100;
                pageList.push({ pageNum: parseInt(pageNum), usage, ratio });
            }
        }

        // 사용량 많은 순으로 정렬
        pageList.sort((a, b) => b.usage - a.usage);

        // 모달에 표시
        const modal = document.getElementById('page-list-modal');
        const channelNameEl = document.getElementById('modal-channel-name');
        const pageListEl = document.getElementById('page-list');

        channelNameEl.textContent = colorName;

        if (pageList.length === 0) {
            pageListEl.innerHTML = '<p class="no-pages">이 별색을 사용하는 페이지가 없습니다.</p>';
        } else {
            pageListEl.innerHTML = pageList.map(item =>
                `<div class="page-item" data-page="${item.pageNum}">
                    페이지 ${item.pageNum} <span class="page-ratio">(${item.ratio.toFixed(1)}%)</span>
                </div>`
            ).join('');

            // 페이지 아이템 클릭 이벤트
            pageListEl.querySelectorAll('.page-item').forEach(el => {
                el.addEventListener('click', () => {
                    const pageNum = parseInt(el.dataset.page);
                    this.goToPage(pageNum);
                    this.closeChannelPageList();
                });
            });
        }

        modal.classList.remove('hidden');
    }

    showSpotColorPageList(colorName) {
        const modal = document.getElementById('page-list-modal');
        const modalTitle = document.getElementById('modal-channel-name');
        const pageList = document.getElementById('page-list');

        modalTitle.textContent = colorName;
        pageList.innerHTML = '';

        // 해당 별색을 사용하는 페이지 목록 생성
        const pages = [];
        for (let pageNum = 1; pageNum <= this.totalPages; pageNum++) {
            if (this.pageSpotColorData[pageNum] && this.pageSpotColorData[pageNum][colorName] > 0) {
                const count = this.pageSpotColorData[pageNum][colorName];
                const total = this.pageSpotColorData[pageNum].totalPixels;
                const ratio = (count / total) * 100;
                pages.push({ pageNum, ratio });
            }
        }

        // 사용 비율 내림차순 정렬
        pages.sort((a, b) => b.ratio - a.ratio);

        if (pages.length === 0) {
            pageList.innerHTML = '<div class="no-pages">이 색상을 사용하는 페이지가 없습니다.</div>';
        } else {
            pages.forEach(item => {
                const pageItem = document.createElement('div');
                pageItem.className = 'page-item';
                pageItem.innerHTML = `
                    <span class="page-num">페이지 ${item.pageNum}</span>
                    <span class="page-ratio">${item.ratio.toFixed(2)}%</span>
                `;
                pageItem.addEventListener('click', () => {
                    this.goToPage(item.pageNum);
                    this.closeChannelPageList();
                });
                pageList.appendChild(pageItem);
            });
        }

        modal.classList.remove('hidden');
    }

    closeChannelPageList() {
        const modal = document.getElementById('page-list-modal');
        modal.classList.add('hidden');
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
    // 워터마크 도구 초기화
    initWatermarkTool() {
        this.wmModal = document.getElementById('watermark-modal');
        this.openWmBtn = document.getElementById('open-watermark-btn');
        this.closeWmBtn = document.getElementById('wm-close-btn');
        this.startWmBtn = document.getElementById('wm-start-btn');
        this.wmStatus = document.getElementById('wm-status');

        if (this.openWmBtn) {
            this.openWmBtn.addEventListener('click', () => {
                if (!this.currentPDFData) {
                    this.showError('먼저 PDF 파일을 열어주세요!');
                    return;
                }
                this.wmModal.classList.remove('hidden');
                // 상태 초기화
                this.wmStatus.style.display = 'none';
                this.startWmBtn.disabled = false;
            });
        }

        if (this.closeWmBtn) {
            this.closeWmBtn.addEventListener('click', () => {
                this.wmModal.classList.add('hidden');
            });
        }

        if (this.startWmBtn) {
            this.startWmBtn.addEventListener('click', () => this.processBulkWatermark());
        }

        // 모달 배경 클릭 닫기
        if (this.wmModal) {
            this.wmModal.addEventListener('click', (e) => {
                if (e.target === this.wmModal && !this.startWmBtn.disabled) {
                    this.wmModal.classList.add('hidden');
                }
            });
        }
    }

    async processBulkWatermark() {
        const emailInput = document.getElementById('wm-emails');
        const fontSizeInput = document.getElementById('wm-fontsize');
        const opacityInput = document.getElementById('wm-opacity');

        const emails = emailInput.value.split('\n').map(e => e.trim()).filter(e => e.length > 0);
        if (emails.length === 0) {
            alert('이메일을 하나 이상 입력해주세요.');
            return;
        }

        try {
            this.startWmBtn.disabled = true;
            this.wmStatus.style.display = 'block';
            this.wmStatus.textContent = '작업을 시작합니다...';
            this.wmStatus.style.color = '#333';

            const { PDFDocument, rgb, degrees, StandardFonts } = PDFLib;
            const JSZip = window.JSZip;

            const zip = new JSZip();

            // 현재 로드된 PDF 데이터 사용
            const originalPdfBytes = this.currentPDFData; // Uint8Array

            for (let i = 0; i < emails.length; i++) {
                const email = emails[i];
                this.wmStatus.textContent = `[${i + 1}/${emails.length}] ${email} 처리 중...`;

                // Load PDF
                const pdfDoc = await PDFDocument.load(originalPdfBytes);
                const pages = pdfDoc.getPages();
                const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

                const fontSize = parseInt(fontSizeInput.value) || 50;
                const opacityVal = parseFloat(opacityInput.value) || 0.3;

                // Draw watermark
                pages.forEach(page => {
                    const { width, height } = page.getSize();
                    const textWidth = helveticaFont.widthOfTextAtSize(email, fontSize);

                    // 중앙 정렬 좌표 계산
                    const angle = Math.PI / 4;
                    const cos = Math.cos(angle);
                    const sin = Math.sin(angle);

                    const halfWidth = textWidth / 2;
                    const halfHeight = fontSize / 2;

                    const x = width / 2 - (halfWidth * cos) + (halfHeight * sin);
                    const y = height / 2 - (halfWidth * sin) - (halfHeight * cos);

                    page.drawText(email, {
                        x: x,
                        y: y,
                        size: fontSize,
                        font: helveticaFont,
                        color: rgb(0.7, 0.7, 0.7),
                        opacity: opacityVal,
                        rotate: degrees(45),
                    });
                });

                const pdfBytes = await pdfDoc.save();
                const idPart = email.split('@')[0];
                zip.file(`${idPart}.pdf`, pdfBytes);
            }

            this.wmStatus.textContent = 'ZIP 파일 압축 중...';
            const content = await zip.generateAsync({ type: 'blob' });

            // 다운로드
            const zipBlob = new Blob([content], { type: 'application/octet-stream' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(zipBlob);
            link.href = url;
            link.download = 'watermarked_pdfs.zip';
            document.body.appendChild(link);
            link.click();

            setTimeout(() => {
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                this.wmStatus.textContent = '완료! 다운로드가 시작되었습니다.';
                this.wmStatus.style.color = 'green';
                this.startWmBtn.disabled = false;
            }, 60000);

        } catch (err) {
            console.error(err);
            this.wmStatus.textContent = `오류 발생: ${err.message}`;
            this.wmStatus.style.color = 'red';
            this.startWmBtn.disabled = false;
        }
    }
}

// Selection Manager - Drag-to-Select Logic
