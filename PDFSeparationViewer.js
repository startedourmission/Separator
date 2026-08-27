import { WorkerPool } from './worker-pool.js';
import { VirtualScrollManager } from './VirtualScrollManager.js';
import { getSpotColorRGB, hasSpotColorRGB, registerSpotColorRGB } from './constants.js';
import { renderBookMockup } from './BookMockupGenerator.js';
import { cmykToRGB255, getColorTables, warmUpColorProfile } from './color-profile.js';

export class PDFSeparationViewer {
    constructor() {
        // 스크롤 뷰어에서는 개별 페이지마다 캔버스가 동적 생성됨
        // 기존 호환성을 위해 더미 캔버스 생성
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');

        // Japan Color 룩업 테이블을 미리 만들어 첫 렌더가 끊기지 않게 한다 (약 100ms)
        warmUpColorProfile();
        this.currentPDF = null;
        this.currentFileType = 'pdf'; // 'pdf' | 'image'
        this.ghostscript = null;
        this.spotColors = [];
        this.gsModule = null;
        this.currentPage = 1;
        this.totalPages = 1;
        this.zoomLevel = 1.0;
        // 파일의 첫 페이지에 해당하는 실제 쪽번호.
        // 내부 계산은 항상 물리 페이지(1부터)를 쓰고, 이 값은 표시·입력 변환에만 사용한다.
        this.pageNumberOffset = 1;

        // 잉크량 계산에서 재단선(TrimBox 바깥) 영역 제외 여부 (기본 켜짐)
        this.excludeTrimArea = true;

        // 렌더링/잉크량 계산에서 PDF 주석(Annotation) 제외 여부 (기본 켜짐).
        // 재단선 제외와 달리 Ghostscript 렌더 단계에서 걸러야 하므로 켜고 끌 때 재렌더가 필요함.
        this.excludeAnnotations = true;

        // 주석 제외 on/off 각각의 측정 결과를 따로 보관해서 토글 시 재사용.
        // 저장하는 값은 페이지당 카운트 숫자 몇 개뿐(비트맵 아님)이라 두 벌을 들고 있어도 부담 없음.
        this.scanVariants = {
            annots: { channel: {}, spot: {}, scanned: false },   // 주석 포함
            noAnnots: { channel: {}, spot: {}, scanned: false }  // 주석 제외
        };

        // 스캔 세대 번호 — 스캔 중 설정이 바뀌면 증가시켜 이전 스캔을 무효화
        this.scanGeneration = 0;

        // 스캔 완료 후 진행률 바를 숨기는 타이머 (새 스캔이 시작되면 취소)
        this.scanHideTimer = null;

        // 별색 프로브 진행 상태 — 스캔은 프로브 완료 후에 시작해야 함
        // (별색 유무에 따라 스캔 방식이 달라지므로)
        this.spotProbePromise = null;

        // 페이지 미리보기 (백그라운드 스캔의 72dpi 데이터를 축소 보관).
        // 먼 페이지로 점프했을 때 GS 렌더(~1초)를 기다리는 동안 흐릿한 미리보기를
        // 즉시 띄우고, 선명한 렌더가 끝나면 교체한다. pageNum -> {imageData, spotColorData}
        this.pagePreviews = new Map();

        // 페이지별 CMYK 채널 사용량 — 현재 활성 변형의 저장소를 가리키는 참조.
        // { pageNum: { cyan, magenta, yellow, black, totalPixels, dpi, fromTiffsep?, trim? } }
        // trim: TrimBox(재단면) 내부만 센 카운트 { cyan, magenta, yellow, black, totalPixels }
        // 전체 비율은 이 데이터에서 매번 재계산 (누적 카운터 방식은 페이지 재스캔/문서 교체 시 오차 누적)
        this.pageChannelData = this.currentVariant().channel;

        // 병렬 처리용 WorkerPool 설정
        this.workerPool = null;
        this.workerPoolSize = Math.min(navigator.hardwareConcurrency || 4, 3); // 네트워크 부하 방지를 위해 최대 3개로 제한

        // 페이지 캐시 (빠른 페이지 전환용)
        this.pageCache = new Map(); // pageNum -> { imageData, baseWidth, baseHeight, spotColorData }
        this.pageCacheSize = 5; // 최대 캐시 페이지 수 (updatePageCacheSize가 DPI에 맞게 조정)
        this.preloadingPages = new Set(); // 현재 프리로딩 중인 페이지

        // 별색 관련 속성
        this.spotColors = [];           // 감지된 별색 이름 목록
        this.spotColorData = {};        // { 'PANTONE 186 C': Uint8Array (그레이스케일) }
        this.spotColorCheckboxes = {};  // { 'PANTONE 186 C': HTMLInputElement }
        this.spotColorRatios = {};      // { 'PANTONE 186 C': 15.3 }
        // 현재 활성 변형의 별색 저장소를 가리키는 참조
        this.pageSpotColorData = this.currentVariant().spot;  // { pageNum: { 'PANTONE 186 C': count } }

        // 스크롤 뷰어 매니저
        this.scrollManager = null;

        // 페이지 메타데이터 (MediaBox, TrimBox)
        this.pageMetadata = new Map(); // pageNum -> { mediaBox, trimBox }
        this.coverCalculatorInputs = { spine: 0, flap: 0, cover: 0, margin: 0 };
        this.renderDPI = 300; // 기본 DPI (300으로 상향)

        this.initializeElements();
        this.bindEvents();
        this.initializeScrollViewer();
        this.updatePageCacheSize();
        this.loadGhostscript();
    }

    // 렌더 DPI에 따라 페이지당 메모리가 제곱으로 커지므로 캐시 페이지 수를 예산 기반으로 조정.
    // (300dpi A4 한 페이지 ≈ CMYK 채널 4개 × 8.7M px ≈ 35MB — 고정 5장은 저DPI에서 너무 작고
    //  600dpi 이상에서는 오히려 너무 컸다)
    updatePageCacheSize() {
        const dpi = this.renderDPI || 300;
        const pxPerPage = (8.27 * dpi) * (11.69 * dpi); // A4 기준 추정
        const bytesPerPage = pxPerPage * 4;             // CMYK 4채널
        const budget = 400e6;                           // 약 400MB
        this.pageCacheSize = Math.max(3, Math.min(30, Math.floor(budget / bytesPerPage)));
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
        this.excludeTrimCheckbox = document.getElementById('exclude-trim-area');
        this.excludeAnnotationsCheckbox = document.getElementById('exclude-annotations');
        this.tacValueElement = document.getElementById('tac-value');
        this.cursorCoordsElement = document.getElementById('cursor-coords');

        // 뷰어 컨트롤
        this.zoomSlider = document.getElementById('zoom-slider');
        this.zoomValue = document.getElementById('zoom-value');
        this.zoomResetBtn = document.getElementById('zoom-reset-btn');

        // 줌 범위. 슬라이더 min/max는 이제 배율이 아니라 위치값(0~1000)이므로
        // 실제 한계는 여기서 관리한다. 휠/핀치 클램프도 이 값을 쓴다.
        this.minZoom = 0.25;
        this.maxZoom = 5.0;
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
        this.channelInkInfoContainer = document.getElementById('channel-ink-info');

        // 페이지 정보 요소 (New)
        this.mediaBoxDimElement = document.getElementById('mediabox-dim');
        this.trimBoxDimElement = document.getElementById('trimbox-dim');

        // 표지 계산기 요소 (New)
        this.spineInput = document.getElementById('spine-width');
        this.flapInput = document.getElementById('flap-width');
        this.coverInput = document.getElementById('cover-width');
        this.marginInput = null; // 날개 여백 제거
        this.marksSelect = null; // 드롭다운 제거
        this.showCandidatesToggle = document.getElementById('show-candidates-toggle');
        this.calcResultElement = document.getElementById('calc-result');

        // 표지 계산기 입력값 저장 (기본값 설정)
        this.coverCalculatorInputs = {
            spine: 0,
            flap: 0,
            cover: 0,
            margin: 0
        };

        // 표지 계산기 데이터 저장
        this.allCandidates = []; // 감지된 모든 후보점들
        this.finalMarks = [];    // 선택된 6개 점들 (x0~x5)

        if (this.showCandidatesToggle) {
            this.showCandidatesToggle.addEventListener('change', () => this.renderCropMarkers());
        }

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

        // 줌 컨트롤 — 휠/핀치와 같은 경로를 쓴다.
        //
        // 예전에는 input마다 updateZoom()을 불렀는데, 이게 모든 페이지의 캔버스를
        // 재합성해서 드래그 40번에 19초가 걸렸다(휠은 같은 조건에서 20ms).
        // 슬라이더는 커서 위치가 없으므로 뷰포트 중앙을 고정점으로 삼는다.
        let sliderRaf = null;
        let pendingSliderZoom = null;

        this.zoomSlider.addEventListener('input', (e) => {
            this.zoomLevel = this.snapZoom(this.sliderPosToZoom(parseInt(e.target.value)));
            this.zoomValue.textContent = `${Math.round(this.zoomLevel * 100)}%`;
            this.updateZoomResetBtn();

            if (!this.scrollManager || this.scrollManager.totalPages === 0) return;

            // 드래그는 픽셀마다 input을 쏘므로 프레임당 한 번만 반영한다
            pendingSliderZoom = this.zoomLevel;
            if (sliderRaf === null) {
                sliderRaf = requestAnimationFrame(() => {
                    sliderRaf = null;
                    this.scrollManager.updateZoomAnchored(pendingSliderZoom, null, null);
                });
            }

            // 드래그가 멎으면 관찰 범위 갱신 + 멈춰 둔 렌더 큐 처리
            clearTimeout(this._sliderZoomEndTimer);
            this._sliderZoomEndTimer = setTimeout(() => {
                this.scrollManager.finalizeZoom();
            }, 180);
        });

        if (this.zoomResetBtn) {
            this.zoomResetBtn.addEventListener('click', () => this.resetZoom());
            this.updateZoomResetBtn();
        }

        this.setupGestureZoom();

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

        // 페이지 번호 직접 입력 (입력값은 파일 기준 쪽번호)
        this.currentPageInput.addEventListener('change', (e) => {
            const pageNum = this.toPhysicalPage(parseInt(e.target.value));
            this.goToPage(pageNum);
        });
        this.currentPageInput.addEventListener('keydown', (e) => {

            if (e.key === 'Enter') {
                e.preventDefault(); // 폼 제출 방지
                e.stopPropagation(); // 이벤트 전파 차단
                const pageNum = this.toPhysicalPage(parseInt(e.target.value));

                this.goToPage(pageNum);
                e.target.blur(); // Enter 후 포커스 해제
            }
        });

        // 파일 기준 쪽번호 오프셋
        const pageOffsetInput = document.getElementById('page-number-offset');
        if (pageOffsetInput) {
            pageOffsetInput.addEventListener('change', (e) => this.setPageNumberOffset(e.target.value));
            pageOffsetInput.addEventListener('input', (e) => this.setPageNumberOffset(e.target.value));
        }

        // 채널 비율 클릭 → 페이지 목록 팝업
        for (const channel of ['cyan', 'magenta', 'yellow', 'black']) {
            const el = this.channelRatioElements[channel];
            this.attachPageListPopover(el, () => this.showChannelPageList(channel, el));
        }

        // 재단선 영역 제외 토글 — 저장된 카운트에서 즉시 재계산 (재스캔 불필요)
        if (this.excludeTrimCheckbox) {
            this.excludeTrimCheckbox.addEventListener('change', (e) => {
                this.excludeTrimArea = e.target.checked;
                this.updateChannelRatios(this.calculateTotalChannelRatios());
                this.updateSpotColorRatios(this.calculateSpotColorRatios());
            });
        }

        // 주석 제외 토글 — 주석 제거는 Ghostscript 렌더 단계에서만 가능해서 재렌더가 필요하지만,
        // on/off 각각의 측정 결과를 따로 들고 있으므로 한 번 스캔한 쪽으로 되돌아올 때는 즉시 반영된다.
        if (this.excludeAnnotationsCheckbox) {
            this.excludeAnnotationsCheckbox.addEventListener('change', (e) => {
                this.excludeAnnotations = e.target.checked;

                if (!this.currentPDFData) return;

                // 활성 슬롯 전환 — 이전 설정의 측정값은 버리지 않고 그대로 보존
                const variant = this.switchScanVariant();

                // 화면 렌더는 주석 포함 여부에 따라 픽셀이 달라지므로 항상 다시 그린다
                this.clearPageCache();
                if (this.scrollManager) {
                    this.scrollManager.updateAllVisiblePages(true); // Ghostscript 재렌더링 강제
                }

                if (variant.scanned) {
                    // 이미 측정해둔 변형 — 재스캔 없이 수치만 즉시 갱신
                    this.updateChannelRatios(this.calculateTotalChannelRatios());
                    this.updateSpotColorRatios(this.calculateSpotColorRatios());
                } else {
                    // 아직 측정 안 된 변형 — 재스캔.
                    // 진행률 바를 누른 즉시 띄워서 "아무 일도 안 일어나다가 결과가 툭 튀어나오는" 느낌을 없앤다.
                    // (이전 스캔이 부분적으로 남아 있으면 그 진행분부터 이어서 표시됨)
                    this.updateChannelRatios(null);
                    this.updateScanProgress(0, this.totalPages);
                    this.scanAllPagesInBackground();
                }
            });
        }

        // 페이지 목록 호버 팝업 초기화
        this.initPageListPopover();

        // 표지 계산기 입력 이벤트
        const updateCalcManual = () => {
            this.coverCalculatorInputs.spine = parseFloat(this.spineInput.value) || 0;
            this.coverCalculatorInputs.flap = parseFloat(this.flapInput.value) || 0;
            this.coverCalculatorInputs.cover = parseFloat(this.coverInput.value) || 0;
            this.calculateCoverSpread(true); // 수동 입력 모드로 호출
        };

        if (this.spineInput) this.spineInput.addEventListener('input', updateCalcManual);
        if (this.flapInput) this.flapInput.addEventListener('input', updateCalcManual);
        if (this.coverInput) this.coverInput.addEventListener('input', updateCalcManual);

        // 렌더링 화질 컨트롤 이벤트
        if (this.qualitySelect) {
            this.qualitySelect.addEventListener('change', (e) => {
                this.renderDPI = parseInt(e.target.value);
                this.updatePageCacheSize(); // DPI에 맞춰 캐시 페이지 수 재계산

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

        // 재단선 자동 감지 버튼
        const autoDetectBtn = document.getElementById('auto-detect-crop');
        if (autoDetectBtn) {
            autoDetectBtn.addEventListener('click', () => this.detectCropMarks());
        }

        // 이미지 내보내기 버튼 (홍보용 이미지 생성)
        const exportSpreadBtn = document.getElementById('export-spread');
        if (exportSpreadBtn) {
            exportSpreadBtn.addEventListener('click', () => this.exportSpreadImage());
        }

        const exportSpreadModeSel = document.getElementById('export-spread-mode');
        const exportSpreadRangeInp = document.getElementById('export-spread-range');
        if (exportSpreadModeSel && exportSpreadRangeInp) {
            exportSpreadModeSel.addEventListener('change', () => {
                exportSpreadRangeInp.style.display = exportSpreadModeSel.value === 'range' ? 'block' : 'none';
            });
        }

        const exportSeparatedBtn = document.getElementById('export-separated');
        if (exportSeparatedBtn) {
            exportSeparatedBtn.addEventListener('click', () => this.exportSeparatedImages());
        }

        const exportABTestBtn = document.getElementById('export-ab-test');
        if (exportABTestBtn) {
            exportABTestBtn.addEventListener('click', () => this.exportABTestCovers());
        }

        const exportPngZipBtn = document.getElementById('export-png-zip');
        if (exportPngZipBtn) {
            exportPngZipBtn.addEventListener('click', () => this.exportPagesAsPngZip());
        }

        // 3D 목업 조정 슬라이더 + 미리보기
        // 본 패널('')과 크게 보기 팝업('-z')에 같은 슬라이더 세트가 있고 항상 동기화된다.
        const MOCKUP_SLIDER_IDS = [
            'mockup-cover-width', 'mockup-spine-width', 'mockup-edge',
            'mockup-size', 'mockup-pos-x', 'mockup-pos-y'
        ];
        const MOCKUP_DEFAULTS = {
            'mockup-cover-width': 73,
            'mockup-spine-width': 76,
            'mockup-edge': 84,
            'mockup-size': 75,
            'mockup-pos-x': 50,
            'mockup-pos-y': 50
        };
        const syncMockupSlider = (id, value) => {
            for (const suffix of ['', '-z']) {
                const el = document.getElementById(id + suffix);
                if (el) el.value = String(value);
                const valEl = document.getElementById(id + suffix + '-val');
                if (valEl) valEl.textContent = value + '%';
            }
        };
        const refreshMockupPreview = () => {
            clearTimeout(this._mockupPreviewTimer);
            this._mockupPreviewTimer = setTimeout(() => {
                if (this._mockupPartsCache &&
                    document.getElementById('mockup-preview-wrap')?.style.display !== 'none') {
                    this.renderMockupPreview();
                }
            }, 150);
        };

        const mockupPreviewBtn = document.getElementById('mockup-preview-btn');
        if (mockupPreviewBtn) {
            mockupPreviewBtn.addEventListener('click', () => this.previewBookMockup());
        }
        const mockupZoomBtn = document.getElementById('mockup-zoom-btn');
        if (mockupZoomBtn) {
            mockupZoomBtn.addEventListener('click', () => {
                const canvas = document.getElementById('mockup-preview-canvas');
                const popup = document.getElementById('mockup-zoom-popup');
                const img = document.getElementById('mockup-zoom-img');
                if (!canvas || !popup || !img || canvas.width < 10) return;
                // 팝업 슬라이더를 본 패널 값으로 맞춘 뒤 열기
                for (const id of MOCKUP_SLIDER_IDS) {
                    const main = document.getElementById(id);
                    if (main) syncMockupSlider(id, main.value);
                }
                img.src = canvas.toDataURL('image/png');
                popup.classList.remove('hidden');
            });
        }
        const mockupZoomPopup = document.getElementById('mockup-zoom-popup');
        if (mockupZoomPopup) {
            // 어두운 배경(팝업 자체)을 클릭할 때만 닫힘 — 내부 컨트롤 클릭은 무시
            mockupZoomPopup.addEventListener('click', (e) => {
                if (e.target === mockupZoomPopup) mockupZoomPopup.classList.add('hidden');
            });
        }
        const mockupZoomCloseBtn = document.getElementById('mockup-zoom-close');
        if (mockupZoomCloseBtn && mockupZoomPopup) {
            mockupZoomCloseBtn.addEventListener('click', () => mockupZoomPopup.classList.add('hidden'));
        }
        const mockupZoomDownloadBtn = document.getElementById('mockup-zoom-download');
        if (mockupZoomDownloadBtn && mockupZoomPopup) {
            mockupZoomDownloadBtn.addEventListener('click', () => {
                mockupZoomPopup.classList.add('hidden');
                this.exportSeparatedImages();
            });
        }
        for (const btnId of ['mockup-reset-btn', 'mockup-reset-btn-z']) {
            const btn = document.getElementById(btnId);
            if (!btn) continue;
            btn.addEventListener('click', () => {
                for (const [id, val] of Object.entries(MOCKUP_DEFAULTS)) {
                    syncMockupSlider(id, val);
                }
                refreshMockupPreview();
            });
        }
        for (const id of MOCKUP_SLIDER_IDS) {
            for (const suffix of ['', '-z']) {
                const el = document.getElementById(id + suffix);
                if (!el) continue;
                el.addEventListener('input', () => {
                    syncMockupSlider(id, el.value);
                    // 미리보기가 열려 있으면 파트 캐시로 즉시 다시 워프 (렌더 재사용, 디바운스)
                    refreshMockupPreview();
                });
            }
        }

        // Drag and Drop & Clipboard
        this.setupDragAndDrop();
        this.setupClipboardPaste();
    }

    async loadGhostscript() {
        try {
            this.worker = new Worker('./ghostscript-worker.js', { type: 'module' });
            this.currentPDFData = null;
            this.requestId = 0;
            this.pendingRequests = new Map();

            // Worker 메시지 핸들러를 한 번만 설정
            this.worker.onmessage = (e) => {
                const { type, requestId, success, data, width, height, message, pageSize, pageCount, supported, files, devices, rawOutput, fileSize, format, channels, spotColors, spotPages, composite, dpi } = e.data;

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
                            pending.resolve({ channels, spotColors, composite, width, height, dpi });
                        } else {
                            pending.reject(new Error(message || 'tiffsep 처리 실패'));
                        }
                        this.pendingRequests.delete(requestId);
                    }
                } else if (type === 'probeSpotColors') {
                    const pending = this.pendingRequests.get(requestId);
                    if (pending) {
                        if (success) {
                            pending.resolve({ spotColors: spotColors || [], spotPages: spotPages || {} });
                        } else {
                            pending.reject(new Error(message || '별색 프로브 실패'));
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

            this.ghostscript = {
                loadPDF: async (data) => {
                    try {
                        this.currentPDFData = new Uint8Array(data);

                        // 워커들에 문서 바이트를 1회만 전송해 캐시 — 이후 작업 메시지는
                        // pdfData를 싣지 않아 호출당 수 MB 복제가 사라진다
                        this.worker.postMessage({ type: 'setPDF', data: { pdfData: this.currentPDFData } });
                        if (this.workerPool) {
                            this.workerPool.setPDFData(this.currentPDFData);
                        }

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

                    // Fast path: pdf-lib으로 페이지 트리에서 즉시 계산.
                    // gs 경로는 nullpage로 문서 전체를 순회해서 수백 페이지 문서에서 수 초가 걸린다.
                    try {
                        const { PDFDocument } = PDFLib;
                        const doc = await PDFDocument.load(this.currentPDFData);
                        const count = doc.getPageCount();
                        if (count > 0) return count;
                    } catch (e) {
                        console.warn('pdf-lib 페이지 수 계산 실패, gs로 대체:', e.message);
                    }

                    // Fallback: 손상됐거나 pdf-lib이 못 읽는 문서는 기존 gs 경로
                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject });

                        // pdfData는 loadPDF 때 setPDF로 캐시됨 — 재전송 안 함
                        this.worker.postMessage({
                            type: 'getPageCount',
                            requestId: reqId,
                            data: {}
                        });
                    });
                },

                getPageSize: async (pageNum) => {
                    if (!this.currentPDFData) {
                        throw new Error('PDF가 로딩되지 않았습니다');
                    }

                    // Fast path: 로딩 시 추출한 메타데이터에서 즉시 반환.
                    // 워커 프로브는 페이지 전체를 렌더해서 크기를 읽으므로 페이지당 ~300ms를 낭비한다.
                    // gs는 /Rotate 를 적용해 렌더하므로 90/270도 페이지는 가로세로를 맞바꾼다.
                    const meta = this.pageMetadata.get(pageNum);
                    if (meta && meta.mediaBox &&
                        typeof meta.mediaBox.width === 'number' && meta.mediaBox.width > 0 &&
                        typeof meta.mediaBox.height === 'number' && meta.mediaBox.height > 0) {
                        const swap = meta.rotate === 90 || meta.rotate === 270;
                        return {
                            width: swap ? meta.mediaBox.height : meta.mediaBox.width,
                            height: swap ? meta.mediaBox.width : meta.mediaBox.height
                        };
                    }

                    // Fallback: 메타데이터가 아직 없거나(추출 전) 실패한 경우 기존 워커 프로브
                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject });

                        this.worker.postMessage({
                            type: 'getPageSize',
                            requestId: reqId,
                            data: {
                                pageNum: pageNum
                            }
                        });
                    });
                },

                renderPage: async (pageNum, options) => {
                    if (!this.currentPDFData) {
                        throw new Error('PDF가 로딩되지 않았습니다');
                    }

                    const payloadOptions = { ...options, pageNum, excludeAnnots: this.excludeAnnotations };
                    const taskData = { options: payloadOptions, pageNum };

                    // 워커 풀에 우선순위로 배정 — 풀이 비면 최대 3페이지 동시 렌더.
                    // (단일 워커에 직렬화되던 것을 병렬화. 스캔 청크보다 항상 먼저 실행)
                    if (this.workerPool) {
                        try {
                            const result = await this.workerPool.runTask('process', taskData, { priority: true });
                            if (result && !result.cancelled) {
                                const w = result.width || payloadOptions.width || 800;
                                const h = result.height || payloadOptions.height || 600;
                                try {
                                    return result.format === 'tiff'
                                        ? await this.convertTIFFToCMYK(result.data, w, h)
                                        : await this.convertPNGToImageData(result.data, w, h);
                                } catch (convErr) {
                                    console.error('이미지 변환 실패:', convErr);
                                    return this.createDummyImageData(w, h);
                                }
                            }
                        } catch (error) {
                            console.error('Worker 처리 오류:', error.message);
                        }
                        return this.createDummyImageData(payloadOptions.width || 800, payloadOptions.height || 600);
                    }

                    // Fallback: 풀이 없으면 기존 단일 워커 경로
                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject, options: payloadOptions });

                        this.worker.postMessage({
                            type: 'process',
                            requestId: reqId,
                            data: {
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

                    // 현재 문서면 워커 캐시 사용, 다른 바이트가 명시되면 그것을 전달
                    const explicitPdf = dataToUse !== this.currentPDFData ? dataToUse : undefined;
                    const taskData = {
                        pdfData: explicitPdf,
                        pageNum: pageNum || 1,
                        dpi: dpi || 72,
                        excludeAnnots: this.excludeAnnotations
                    };

                    // 워커 풀에 우선순위로 배정 (별색 문서의 열람 렌더 병렬화)
                    if (this.workerPool) {
                        const result = await this.workerPool.runTask('processTiffsep', taskData, { priority: true });
                        if (result?.cancelled) {
                            throw new Error('작업이 취소되었습니다');
                        }
                        return {
                            channels: result.channels,
                            spotColors: result.spotColors,
                            composite: result.composite,
                            width: result.width,
                            height: result.height,
                            dpi: result.dpi
                        };
                    }

                    // Fallback: 풀이 없으면 기존 단일 워커 경로
                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject });

                        this.worker.postMessage({
                            type: 'processTiffsep',
                            requestId: reqId,
                            data: taskData
                        });
                    });
                },

                probeSpotColors: async (pdfData) => {
                    const dataToUse = pdfData || this.currentPDFData;
                    if (!dataToUse) {
                        throw new Error('PDF 데이터가 없습니다');
                    }

                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject });

                        this.worker.postMessage({
                            type: 'probeSpotColors',
                            requestId: reqId,
                            data: { pdfData: dataToUse !== this.currentPDFData ? dataToUse : undefined }
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
                const rawData = new Uint8Array(page.data);

                // 추출 + 반전을 한 루프에서 처리 (255=잉크없음 → 0=잉크없음)
                const channelData = new Uint8Array(pixelCount);
                if (rawData.length >= pixelCount * 4) {
                    for (let i = 0; i < pixelCount; i++) {
                        channelData[i] = 255 - rawData[i * 4];
                    }
                } else if (rawData.length >= pixelCount * 3) {
                    for (let i = 0; i < pixelCount; i++) {
                        channelData[i] = 255 - rawData[i * 3];
                    }
                } else {
                    for (let i = 0; i < pixelCount; i++) {
                        channelData[i] = 255 - rawData[i];
                    }
                }

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
        if (!file) return;

        // 안내 메시지 숨기기
        const welcomeMessage = document.getElementById('welcome-message');
        if (welcomeMessage) {
            welcomeMessage.classList.add('hidden');
        }

        if (file.type === 'application/pdf') {
            this.currentFileType = 'pdf';
            try {
                const arrayBuffer = await file.arrayBuffer();
                await this.loadPDF(arrayBuffer);
            } catch (error) {
                console.error('파일 로딩 실패:', error);
                this.showError('PDF 파일을 로딩할 수 없습니다.');
            }
        } else if (file.type.startsWith('image/')) {
            this.currentFileType = 'image';
            try {
                const arrayBuffer = await file.arrayBuffer();
                await this.loadImage(arrayBuffer, file.type);
            } catch (error) {
                console.error('이미지 로딩 실패:', error);
                this.showError('이미지 파일을 로딩할 수 없습니다.');
            }
        } else {
            this.showError('지원되지 않는 파일 형식입니다.');
        }
    }

    setupDragAndDrop() {
        const dropZone = document.body;

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('drag-over');
        });

        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');

            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                // 재사용을 위해 이벤트 객체 모방
                this.handleFileSelect({ target: { files: files } });
            }
        });
    }

    setupClipboardPaste() {
        document.addEventListener('paste', (e) => {
            const items = e.clipboardData.items;
            for (let i = 0; i < items.length; i++) {
                if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
                    const file = items[i].getAsFile();
                    this.handleFileSelect({ target: { files: [file] } });
                    break;
                }
            }
        });
    }

    async loadImage(data, mimeType) {
        try {
            this.showLoading('이미지 로딩 중...', '50%');

            const blob = new Blob([data], { type: mimeType });
            const img = new Image();
            const url = URL.createObjectURL(blob);

            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = url;
            });

            this.currentPDF = data; // 이미지 데이터 저장 (PDF 변수 재사용)
            this.totalPages = 1;
            this.currentPage = 1;
            this.resetPageNumberOffset();
            this.imgObject = img; // 원본 이미지 객체 보관

            // 페이지 캐시 클리어
            this.clearPageCache();
            this.resetScanVariants();

            // 메타데이터 설정 (이미지 크기)
            // 72 DPI 기준 포인트 단위로 변환 운운할 필요 없이 픽셀 그대로 사용하거나 A4 핏 등 고려
            // 여기서는 픽셀 크기를 그대로 포인트로 간주 (1:1)
            const width = img.width;
            const height = img.height;

            this.pageMetadata.clear();
            this.pageMetadata.set(1, {
                mediaBox: { width, height },
                trimBox: { width, height }
            });

            // 스크롤 뷰어 초기화
            const aspectRatio = width / height;
            this.scrollManager.init(this.totalPages, aspectRatio);
            this.updatePageControls();
            this.updatePageDimensionInfo();

            // 별색 및 분판 컨트롤 비활성화/초기화
            this.spotColors = [];
            this.spotColorData = {};
            this.updateSpotColorControls();

            // 이미지 스캔 (히스토그램용) - 간단히 캔버스에서 읽어서 처리
            this.scanImageForHistogram();

            this.hideLoading();

        } catch (error) {
            console.error('이미지 처리 오류:', error);
            this.hideLoading();
            this.showError('이미지를 처리할 수 없습니다.');
        }
    }

    scanImageForHistogram() {
        if (!this.imgObject) return;

        const canvas = document.createElement('canvas');
        canvas.width = this.imgObject.width;
        canvas.height = this.imgObject.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(this.imgObject, 0, 0);

        // 간단한 CMYK 변환 시뮬레이션 및 데이터 집계 구현 가능
        // 현재는 생략하거나 빈 데이터로 둠
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
                this.resetPageNumberOffset();


                // 페이지 캐시 클리어
                this.clearPageCache();

                // 전체 페이지 CMYK/별색 데이터 수집 초기화
                // (이전 문서의 페이지별 데이터가 남아있으면 새 문서 비율에 섞여 큰 오차 발생)
                // 주석 포함/제외 두 변형 모두 비운다 — 이전 문서의 캐시가 남으면 안 됨
                this.resetScanVariants();
                this.updateChannelRatios(null);

                // 2단계: 별색 프로브를 백그라운드로 시작 — 완료를 기다리지 않는다.
                // (문서 전체를 훑는 프로브는 수백 페이지에서 수 초가 걸려 로딩 화면을 붙잡았음)
                // 별색이 발견되면 그 시점까지 렌더된 페이지를 다시 그려 정확한 분판 채널을 반영한다.
                this.showLoading('초기화 중...', '66%');
                const probeDoc = this.currentPDFData;
                this.spotProbePromise = this.loadSpotColors()
                    .then(() => {
                        // 프로브 도중 다른 문서로 교체됐으면 이 결과는 무시
                        if (this.currentPDFData !== probeDoc) return;
                        if (this.spotColors && this.spotColors.length > 0) {
                            // 프로브 완료 전에 렌더된 페이지는 별색 채널 없이 그려졌으므로 재렌더
                            this.clearPageCache();
                            if (this.scrollManager && this.scrollManager.totalPages > 0) {
                                this.scrollManager.updateAllVisiblePages(true);
                            }
                        }
                    })
                    .catch(err => console.warn('별색 감지 실패:', err));

                // 3단계: 스크롤 뷰어 초기화 (100%)
                this.showLoading('뷰어 초기화 중...', '100%');

                // 첫 페이지 크기 가져오기
                let aspectRatio = 1 / 1.414; // A4 기본값
                try {
                    const pageSize = await this.ghostscript.getPageSize(1);
                    aspectRatio = pageSize.width / pageSize.height;
                } catch (e) {
                }

                // 스크롤 뷰어 초기화
                this.scrollManager.init(this.totalPages, aspectRatio);
                this.updatePageControls();

                // 렌더링 완료 후 로딩 숨김
                this.hideLoading();

                // 메타데이터(TrimBox)와 별색 프로브가 끝나면 백그라운드 스캔 시작
                // (재단선 제외 계산에 페이지별 TrimBox가, 스캔 방식 결정에 별색 유무가 필요)
                Promise.allSettled([this.extractPDFMetadata(), this.spotProbePromise])
                    .then(() => this.scanAllPagesInBackground());


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
        // 별색 프로브가 아직 진행 중이면 완료를 기다린다 — 별색 유무가 스캔 방식을 결정하므로
        // 프로브 전에 스캔하면 별색 문서를 CMYK 전용으로 잘못 측정해 캐시할 수 있다.
        if (this.spotProbePromise) {
            await this.spotProbePromise.catch(() => { });
        }

        // 별색 문서는 처음부터 tiffsep으로 스캔 (별색이 분리된 깨끗한 CMYK + 별색 채널을 한 번에 수집).
        // 예전처럼 tiff32nc로 먼저 스캔한 뒤 tiffsep으로 재교정하면 렌더링이 2배로 들고,
        // 수집 완료 후에도 수치가 계속 바뀌는 것처럼 보이는 문제가 있었음.
        const hasSpots = this.spotColors && this.spotColors.length > 0;
        const scanDpi = 72;      // 비율 계산용이므로 저해상도로 충분
        const chunkSize = 8;     // GS 1회 실행당 페이지 수 (모듈 초기화/PDF 파싱 비용 분산)

        // 이 스캔이 어떤 주석 설정으로 도는지 시작 시점에 고정.
        // 스캔 도중 사용자가 토글해도 이미 발주된 렌더 결과는 원래 변형에 들어가야 하고,
        // 늦게 도착한 결과가 다른 변형을 오염시키면 안 된다.
        const scanExcludeAnnots = this.excludeAnnotations;
        const targetVariant = this.currentVariant();
        const scanToken = ++this.scanGeneration;
        const isStale = () => this.scanGeneration !== scanToken;

        // WorkerPool에 PDF 데이터 설정
        if (this.workerPool && this.currentPDFData) {
            this.workerPool.setPDFData(this.currentPDFData);
            // 이전 스캔이 큐에 남겨둔 청크를 비운다.
            // 그대로 두면 워커가 계속 옛 설정으로 렌더하느라 새 스캔의 첫 결과가
            // 한참 뒤에야 도착해서 진행률이 0%에 멈춘 것처럼 보인다.
            this.workerPool.cancelQueuedTasks();
        }

        // 이전 스캔이 예약해둔 "3초 뒤 숨김" 타이머가 새 스캔의 진행률 바를 지우지 않도록 취소
        if (this.scanHideTimer) {
            clearTimeout(this.scanHideTimer);
            this.scanHideTimer = null;
        }

        const titleEl = document.getElementById('scan-progress-title');
        if (titleEl) {
            titleEl.textContent = hasSpots ? '분판 데이터 수집 (별색 포함)' : 'CMYK 데이터 수집';
        }

        let completedPages = 0;
        // 이전 스캔이 남긴 진행분이 있으면 0%가 아니라 거기서부터 보여준다
        this.updateScanProgress(
            Math.min(Object.keys(targetVariant.channel).length, this.totalPages),
            this.totalPages
        );

        // 페이지 하나 처리 완료 시 진행률/비율 갱신
        const onAnyPageDone = () => {
            completedPages++;
            // 다른 변형으로 전환된 뒤 도착한 결과 — 데이터는 원래 변형에 이미 들어갔으니
            // 화면 수치만 건드리지 않는다 (지금 보이는 값은 새 변형의 것이어야 함)
            if (isStale()) return;
            if (completedPages % 2 === 0 || completedPages >= this.totalPages) {
                this.updateChannelRatios(this.calculateTotalChannelRatios());
                if (hasSpots) {
                    const spotRatios = this.calculateSpotColorRatios();
                    if (spotRatios) this.updateSpotColorRatios(spotRatios);
                }
                this.updateScanProgress(Math.min(completedPages, this.totalPages), this.totalPages);
            }
        };

        try {
            if (this.workerPool) {
                // 청크 단위 병렬 스캔: 페이지 결과는 워커에서 스트리밍으로 도착.
                // 전 청크를 미리 큐에 넣으면 1→N 순서로 고정되어, 사용자가 300~400쪽으로
                // 점프했을 때 그 근처의 미리보기/잉크 데이터가 한참 뒤에야 생긴다.
                // 대신 워커가 빌 때마다 "현재 보고 있는 페이지에서 가장 가까운" 청크를 골라
                // 스캔이 사용자를 따라다니게 한다. (전체 완주는 동일하게 보장)
                const pagePromises = [];

                const chunks = [];
                for (let first = 1; first <= this.totalPages; first += chunkSize) {
                    chunks.push({ first, last: Math.min(first + chunkSize - 1, this.totalPages) });
                }

                const onPage = (page) => {
                    const p = (hasSpots
                        ? this.ingestTiffsepPageData(page, targetVariant)
                        : this.ingestScanPageData(page, targetVariant))
                        .catch(err => console.error(`페이지 ${page.pageNum} 스캔 처리 실패:`, err))
                        .finally(onAnyPageDone);
                    pagePromises.push(p);
                };

                const takeNearestChunk = () => {
                    const cur = this.currentPage || 1;
                    let bestIdx = 0, bestDist = Infinity;
                    for (let i = 0; i < chunks.length; i++) {
                        const c = chunks[i];
                        const d = cur < c.first ? c.first - cur : (cur > c.last ? cur - c.last : 0);
                        if (d < bestDist) { bestDist = d; bestIdx = i; if (d === 0) break; }
                    }
                    return chunks.splice(bestIdx, 1)[0];
                };

                const runner = async () => {
                    while (chunks.length > 0 && !isStale()) {
                        const { first, last } = takeNearestChunk();
                        try {
                            const res = await (hasSpots
                                ? this.workerPool.processTiffsepChunk(first, last, scanDpi, onPage, scanExcludeAnnots)
                                : this.workerPool.renderPagesChunk(first, last, scanDpi, onPage, scanExcludeAnnots));
                            if (res && res.cancelled) break; // 새 스캔이 시작돼 취소됨
                        } catch (err) {
                            console.error(`청크 스캔 실패 (${first}-${last}쪽):`, err);
                        }
                    }
                };

                const runners = [];
                for (let i = 0; i < this.workerPoolSize; i++) {
                    runners.push(runner());
                }
                await Promise.all(runners);
                await Promise.all(pagePromises);
            } else {
                // Fallback: 단일 워커 순차 처리
                for (let pageNum = 1; pageNum <= this.totalPages; pageNum++) {
                    try {
                        if (hasSpots) {
                            const result = await this.ghostscript.processTiffsep(this.currentPDFData, pageNum, scanDpi);
                            await this.ingestTiffsepPageData({
                                success: true,
                                pageNum,
                                channels: result.channels,
                                dpi: result.dpi || scanDpi
                            }, targetVariant);
                        } else {
                            const imageData = await this.ghostscript.renderPage(pageNum, {
                                useCMYK: true, dpi: scanDpi, pageNum,
                                width: 800, height: 600, separations: []
                            });
                            if (imageData && imageData.type === 'cmyk') {
                                this.accumulateChannelData(imageData, pageNum, scanDpi, targetVariant);
                            }
                        }
                    } catch (error) {
                        console.error(`페이지 ${pageNum} 스캔 실패:`, error);
                    }
                    onAnyPageDone();
                }
            }

            // 전체 페이지가 실제로 측정됐을 때만 "완료"로 표시.
            // 토글로 중간에 취소된 스캔은 일부 페이지만 채워져 있으므로 완료로 볼 수 없고,
            // 그대로 캐시하면 나중에 되돌아왔을 때 빠진 페이지가 누락된 수치가 나온다.
            const measuredPages = Object.keys(targetVariant.channel).length;
            if (measuredPages >= this.totalPages) {
                targetVariant.scanned = true;
            }

            // 최종 UI 업데이트 (그 사이 다른 변형으로 전환됐으면 건너뜀)
            if (!isStale()) {
                this.updateChannelRatios(this.calculateTotalChannelRatios());
                if (hasSpots) {
                    const spotRatios = this.calculateSpotColorRatios();
                    if (spotRatios) this.updateSpotColorRatios(spotRatios);
                }
                this.updateScanProgress(this.totalPages, this.totalPages);
            }
        } catch (error) {
            console.error('병렬 스캔 중 오류:', error);
        }

        // 새 스캔이 시작됐으면 진행률 바는 그쪽 소유이므로 건드리지 않는다
        if (isStale()) return;

        // 완료 후 3초 뒤에 진행률 바 숨김
        this.scanHideTimer = setTimeout(() => {
            this.scanHideTimer = null;
            if (!isStale()) this.hideScanProgress();
        }, 3000);
    }


    // 스캔 데이터(72dpi)를 축소해 페이지 미리보기로 보관.
    // 먼 페이지로 점프 시 GS 렌더를 기다리는 동안 즉시 표시하는 용도 —
    // renderToCanvas가 그대로 그릴 수 있도록 {imageData, spotColorData} 형태로 저장한다.
    storePagePreview(pageNum, cmykData, spotColorData = null) {
        if (!cmykData || cmykData.type !== 'cmyk' || !cmykData.width || !cmykData.height) return;

        // 대형 문서는 더 작게 (544p × 144px ≈ 70MB, 800p 초과 시 96px ≈ 절반)
        const targetW = (this.totalPages || 0) > 800 ? 96 : 144;
        const scale = Math.min(1, targetW / cmykData.width);
        const w = Math.max(1, Math.round(cmykData.width * scale));
        const h = Math.max(1, Math.round(cmykData.height * scale));
        const srcW = cmykData.width, srcH = cmykData.height;

        const sample = (src) => {
            if (!src) return null;
            const out = new Uint8Array(w * h);
            for (let y = 0; y < h; y++) {
                const sy = Math.min(srcH - 1, Math.floor(y / scale));
                const rowOff = sy * srcW;
                const outOff = y * w;
                for (let x = 0; x < w; x++) {
                    out[outOff + x] = src[rowOff + Math.min(srcW - 1, Math.floor(x / scale))];
                }
            }
            return out;
        };

        const preview = {
            imageData: {
                type: 'cmyk', width: w, height: h,
                channels: {
                    cyan: sample(cmykData.channels.cyan),
                    magenta: sample(cmykData.channels.magenta),
                    yellow: sample(cmykData.channels.yellow),
                    black: sample(cmykData.channels.black)
                }
            },
            spotColorData: {}
        };
        if (spotColorData) {
            for (const [name, data] of Object.entries(spotColorData)) {
                const s = sample(data);
                if (s) preview.spotColorData[name] = s;
            }
        }
        this.pagePreviews.set(pageNum, preview);
    }

    // 스캔 청크의 페이지 결과(tiff32nc TIFF)를 페이지별 잉크량 데이터로 반영
    async ingestScanPageData(page, variant = null) {
        if (!page.success || !page.data) {
            if (!page.success) console.error(`페이지 ${page.pageNum} 스캔 실패:`, page.message);
            return;
        }

        const imageData = await this.convertTIFFToCMYK(page.data);
        if (imageData && imageData.type === 'cmyk') {
            this.accumulateChannelData(imageData, page.pageNum, 72, variant);
            this.storePagePreview(page.pageNum, imageData);
        }
    }

    // tiffsep 청크의 페이지 결과(분판 TIFF들)를 페이지별 잉크량 데이터로 반영
    async ingestTiffsepPageData(page, variant = null) {
        if (!page.success || !page.channels) {
            if (!page.success) console.error(`페이지 ${page.pageNum} 분판 스캔 실패:`, page.message);
            return;
        }

        const pageNum = page.pageNum;
        const channelStore = (variant || this.currentVariant()).channel;

        // 열람 렌더(고해상도 tiffsep)로 이미 측정된 페이지는 유지 — 값이 다시 바뀌지 않도록
        const existing = channelStore[pageNum];
        if (existing && existing.fromTiffsep && (existing.trim || !this.hasTrimMargin(pageNum))) {
            return;
        }

        const dpi = page.dpi || 72;
        const channels = page.channels;

        const cyanParsed = await this.parseSpotColorTIFF(channels['Cyan'], 'Cyan');
        const magentaParsed = await this.parseSpotColorTIFF(channels['Magenta'], 'Magenta');
        const yellowParsed = await this.parseSpotColorTIFF(channels['Yellow'], 'Yellow');
        const blackParsed = await this.parseSpotColorTIFF(channels['Black'], 'Black');

        const cleanCmyk = {
            type: 'cmyk',
            width: cyanParsed.width,
            height: cyanParsed.height,
            channels: {
                cyan: cyanParsed.data,
                magenta: magentaParsed.data,
                yellow: yellowParsed.data,
                black: blackParsed.data
            }
        };

        this.replacePageChannelData(cleanCmyk, pageNum, dpi, variant);

        // 별색 채널 수집
        const spotColorData = {};
        for (const colorName of this.spotColors) {
            if (channels[colorName]) {
                const parsed = await this.parseSpotColorTIFF(channels[colorName], colorName);
                spotColorData[colorName] = parsed.data;
            }
        }
        this.accumulateSpotColorData(spotColorData, pageNum, cleanCmyk.width, cleanCmyk.height, dpi, variant);
        this.storePagePreview(pageNum, cleanCmyk, spotColorData);
    }


    // 별색 프로브를 워커 풀에 페이지 범위로 분할해 병렬 실행.
    // 단일 워커로 문서 전체를 훑는 것 대비 워커 수만큼 빨라진다 (544p 기준 ~5s → ~2s).
    async probeSpotColorsParallel() {
        // 풀이 없거나 작은 문서는 기존 단일 프로브 (분할 오버헤드가 더 큼)
        if (!this.workerPool || !this.totalPages || this.totalPages <= 12) {
            return this.ghostscript.probeSpotColors(this.currentPDFData);
        }

        // 워커 수보다 잘게 쪼갠다 — 우선순위로 끼어드는 열람 렌더가
        // 수백 페이지짜리 프로브 하나가 끝나기를 기다리지 않도록 (범위당 최대 ~48쪽)
        const per = Math.min(48, Math.ceil(this.totalPages / this.workerPoolSize));
        const jobs = [];
        for (let first = 1; first <= this.totalPages; first += per) {
            const last = Math.min(first + per - 1, this.totalPages);
            jobs.push(this.workerPool.runTask('probeSpotColors', { firstPage: first, lastPage: last }));
        }

        // 하나라도 실패하면 throw → 호출부의 정규식 폴백 체인으로 (단일 프로브 실패와 동일)
        const results = await Promise.all(jobs);

        const spotSet = new Set();
        const spotPages = {};
        for (const r of results) {
            if (!r || r.cancelled) throw new Error('별색 프로브가 취소되었습니다');
            for (const name of (r.spotColors || [])) spotSet.add(name);
            for (const [name, page] of Object.entries(r.spotPages || {})) {
                if (!spotPages[name] || page < spotPages[name]) spotPages[name] = page;
            }
        }
        return { spotColors: Array.from(spotSet), spotPages };
    }

    async loadSpotColors() {
        const docAtStart = this.currentPDFData;

        // 1차: tiffsep 프로브 (실제 생성되는 플레이트 이름 — 압축 스트림 PDF에서도 정확하고
        // 이후 tiffsep 스캔의 채널 이름과 반드시 일치)
        try {
            const probe = await this.probeSpotColorsParallel();
            // 프로브 도중 다른 문서가 로드됐으면 결과를 버림 (새 문서의 프로브가 따로 돈다)
            if (this.currentPDFData !== docAtStart) return;
            this.spotColors = (probe.spotColors || []).sort();
            this.spotColorSamplePages = probe.spotPages || {};
            this.spotColorData = {};
            this.updateSpotColorControls();

            // 팬톤 테이블에 없는 이름("변경색상" 등)은 문서 데이터에서 표시색 추정 (비동기)
            this.estimateUnknownSpotColors();
            return;
        } catch (error) {
            console.warn('별색 프로브 실패, 정규식 검색으로 대체:', error.message);
        }

        // 2차 (폴백): PDF 바이너리에서 /Separation 정규식 검색
        try {

            const spotColors = new Set();

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
                    // PDF Name 이스케이프 처리 (#XX → 바이트)
                    // 비ASCII 바이트가 포함되면 EUC-KR 디코딩 시도
                    const hasEscapedBytes = /#[0-9A-Fa-f]{2}/.test(name);
                    if (hasEscapedBytes) {
                        // #XX를 바이트 배열로 변환
                        const bytes = [];
                        let i = 0;
                        while (i < name.length) {
                            if (name[i] === '#' && i + 2 < name.length) {
                                bytes.push(parseInt(name.substring(i + 1, i + 3), 16));
                                i += 3;
                            } else {
                                bytes.push(name.charCodeAt(i));
                                i++;
                            }
                        }
                        const byteArray = new Uint8Array(bytes);
                        // 비ASCII 바이트가 있으면 EUC-KR 디코딩 시도
                        const hasNonAscii = bytes.some(b => b > 127);
                        if (hasNonAscii) {
                            try {
                                const euckrDecoder = new TextDecoder('euc-kr', { fatal: true });
                                name = euckrDecoder.decode(byteArray);
                            } catch {
                                // EUC-KR 실패 시 UTF-8 시도
                                try {
                                    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
                                    name = utf8Decoder.decode(byteArray);
                                } catch {
                                    // 둘 다 실패하면 Latin-1 폴백
                                    name = String.fromCharCode(...bytes);
                                }
                            }
                        } else {
                            name = String.fromCharCode(...bytes);
                        }
                    }

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

            // 레이블 생성 (CMYK와 동일한 스타일 + 별색 고유 색상)
            const label = document.createElement('label');
            label.htmlFor = checkbox.id;
            label.className = 'color-label spot-color';
            label.textContent = colorName;
            const spotRgb = getSpotColorRGB(colorName);
            label.style.backgroundColor = `rgba(${spotRgb.r}, ${spotRgb.g}, ${spotRgb.b}, 0.15)`;
            label.style.backgroundImage = `linear-gradient(to right, rgb(${spotRgb.r}, ${spotRgb.g}, ${spotRgb.b}), rgb(${spotRgb.r}, ${spotRgb.g}, ${spotRgb.b}))`;

            // 비율 표시 요소 생성
            const ratioSpan = document.createElement('span');
            ratioSpan.className = 'channel-ratio';
            ratioSpan.id = `${checkbox.id}-ratio`;
            ratioSpan.textContent = '-';

            // 별색 비율 클릭 → 페이지 목록 팝업
            this.attachPageListPopover(ratioSpan, () => this.showSpotColorPageList(colorName, ratioSpan));

            // 체크박스 참조 저장
            this.spotColorCheckboxes[colorName] = checkbox;

            // DOM에 추가
            controlDiv.appendChild(checkbox);
            controlDiv.appendChild(label);
            controlDiv.appendChild(ratioSpan);
            this.spotControlsContainer.appendChild(controlDiv);
        });


    }

    /**
     * 팬톤 테이블에 없는 별색의 화면 표시색을 문서 데이터에서 추정.
     * 해당 별색이 쓰인 페이지를 tiffsep으로 렌더해, 별색 잉크가 진하고 다른 잉크가 없는
     * 픽셀들의 합성판(CMYK composite) 평균색 = 별색의 대체색(Alternate) 근사값.
     * Acrobat이 별색을 제대로 표시하는 것과 같은 원리 (대체 색공간 기반).
     */
    async estimateUnknownSpotColors() {
        for (const colorName of this.spotColors || []) {
            if (hasSpotColorRGB(colorName)) continue;

            const samplePage = this.spotColorSamplePages && this.spotColorSamplePages[colorName];
            if (!samplePage) continue;

            try {
                const result = await this.ghostscript.processTiffsep(this.currentPDFData, samplePage, 72);
                if (!result || !result.channels || !result.channels[colorName] || !result.composite) continue;

                const spotParsed = await this.parseSpotColorTIFF(result.channels[colorName], colorName);
                const comp = await this.convertTIFFToCMYK(result.composite);
                if (!comp || comp.width !== spotParsed.width || comp.height !== spotParsed.height) continue;

                const cyanP = await this.parseSpotColorTIFF(result.channels['Cyan'], 'Cyan');
                const magentaP = await this.parseSpotColorTIFF(result.channels['Magenta'], 'Magenta');
                const yellowP = await this.parseSpotColorTIFF(result.channels['Yellow'], 'Yellow');
                const blackP = await this.parseSpotColorTIFF(result.channels['Black'], 'Black');

                const n = spotParsed.width * spotParsed.height;
                const sd = spotParsed.data;
                const sameSize = cyanP.data.length === n;

                // 별색이 진하게(78%+) 찍혔고 프로세스 잉크가 겹치지 않은 "순수" 픽셀 수집
                const sample = (pure) => {
                    let c = 0, m = 0, y = 0, k = 0, cnt = 0;
                    for (let i = 0; i < n; i++) {
                        if (sd[i] < 200) continue;
                        if (pure && sameSize &&
                            (cyanP.data[i] > 20 || magentaP.data[i] > 20 ||
                             yellowP.data[i] > 20 || blackP.data[i] > 20)) continue;
                        c += comp.channels.cyan[i];
                        m += comp.channels.magenta[i];
                        y += comp.channels.yellow[i];
                        k += comp.channels.black[i];
                        cnt++;
                    }
                    return cnt >= 10 ? { c: c / cnt, m: m / cnt, y: y / cnt, k: k / cnt, cnt } : null;
                };

                const avg = sample(true) || sample(false);
                if (!avg) continue;

                // 화면 표시색이므로 렌더링과 동일하게 Japan Color 기준으로 변환
                const est = cmykToRGB255(avg.c, avg.m, avg.y, avg.k);
                const rgb = {
                    r: Math.round(est.r),
                    g: Math.round(est.g),
                    b: Math.round(est.b)
                };
                registerSpotColorRGB(colorName, rgb);

                // 라벨 색상칩 갱신 + 현재 화면 재렌더
                this.refreshSpotColorSwatch(colorName);
                this.updateSeparation();
            } catch (error) {
                console.warn(`별색 "${colorName}" 표시색 추정 실패:`, error.message);
            }
        }
    }

    // 별색 라벨의 색상칩만 갱신 (체크박스/비율 표시는 유지)
    refreshSpotColorSwatch(colorName) {
        const checkbox = this.spotColorCheckboxes[colorName];
        if (!checkbox) return;
        const label = document.querySelector(`label[for="${checkbox.id}"]`);
        if (!label) return;
        const rgb = getSpotColorRGB(colorName);
        label.style.backgroundColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
        label.style.backgroundImage = `linear-gradient(to right, rgb(${rgb.r}, ${rgb.g}, ${rgb.b}), rgb(${rgb.r}, ${rgb.g}, ${rgb.b}))`;
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

                // 페이지 회전각 (gs 렌더 크기는 회전이 적용되지만 MediaBox는 아니므로 따로 보관)
                let rotate = 0;
                try {
                    rotate = ((page.getRotation().angle % 360) + 360) % 360;
                } catch (e) {
                }

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
                }

                // 유효성 검사: width/height가 없거나 숫자가 아니면 MediaBox 사용
                if (!trimBox || typeof trimBox.width !== 'number' || typeof trimBox.height !== 'number') {
                    trimBox = mediaBox;
                }

                this.pageMetadata.set(pageNum, {
                    mediaBox: {
                        x: mediaBox.x || 0,
                        y: mediaBox.y || 0,
                        width: mediaBox.width,
                        height: mediaBox.height
                    },
                    trimBox: {
                        x: trimBox.x || 0,
                        y: trimBox.y || 0,
                        width: trimBox.width,
                        height: trimBox.height
                    },
                    rotate: rotate
                });
            });


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
        const ptToMm = 25.4 / 72;

        const mediaW = (metadata.mediaBox.width * ptToMm).toFixed(2);
        const mediaH = (metadata.mediaBox.height * ptToMm).toFixed(2);

        const trimW = (metadata.trimBox.width * ptToMm).toFixed(2);
        const trimH = (metadata.trimBox.height * ptToMm).toFixed(2);

        if (this.mediaBoxDimElement) {
            this.mediaBoxDimElement.textContent = `${mediaW} × ${mediaH} mm`;
        }

        if (this.trimBoxDimElement) {
            this.trimBoxDimElement.textContent = `${trimW} × ${trimH} mm`;
        }

        // 페이지 변경 시 계산기도 업데이트 (TrimBox 기준이므로)
        this.calculateCoverSpread();

        // 페이지 변경 시 마커 제거
        this.clearCropMarkers();
    }

    clearCropMarkers() {
        document.querySelectorAll('.crop-marker').forEach(m => m.remove());
    }

    // 표지 펼침면 계산
    // 표지 펼침면 계산 (합계 방식)
    calculateCoverSpread(isManual = false) {
        if (!this.calcResultElement) return;

        // 현재 페이지의 TrimBox 높이 가져오기
        let trimHeightMm = 0;
        const pageNum = this.currentPage;
        const metadata = this.pageMetadata.get(pageNum);
        if (metadata && metadata.trimBox) {
            const ptToMm = 25.4 / 72;
            trimHeightMm = metadata.trimBox.height * ptToMm;
        }

        let spineWidth = 0, coverWidth = 0, flapWidth = 0;

        if (isManual) {
            // 수동 입력 시: 필드 값 우선 사용
            spineWidth = this.coverCalculatorInputs.spine;
            coverWidth = this.coverCalculatorInputs.cover;
            flapWidth = this.coverCalculatorInputs.flap;
        } else {
            // 자동 감지 시: finalMarks 기반 계산
            if (this.finalMarks.length < 4) {
                this.calcResultElement.textContent = `펼침면 너비 : 0.00 x 0.00 mm`;
                return;
            }

            // x 변환 비율 재계산 (최신 캔버스/메타데이터 기준)
            const pageObj = this.scrollManager.pageElements.get(pageNum);
            if (!pageObj || !pageObj.canvas || !metadata) return;
            const pxToMm = (metadata.mediaBox.width * (25.4 / 72)) / pageObj.canvas.width;

            const sortedMarks = [...this.finalMarks].sort((a, b) => a - b);
            const dists = [];
            for (let i = 1; i < sortedMarks.length; i++) {
                dists.push((sortedMarks[i] - sortedMarks[i - 1]) * pxToMm);
            }

            if (sortedMarks.length === 6) {
                flapWidth = (dists[0] + dists[4]) / 2;
                coverWidth = (dists[1] + dists[3]) / 2;
                spineWidth = dists[2];
            } else if (sortedMarks.length === 4) {
                coverWidth = (dists[0] + dists[2]) / 2;
                spineWidth = dists[1];
                flapWidth = 0;
            }

            // 입력 필드 동기화
            this.spineInput.value = spineWidth.toFixed(2);
            this.coverInput.value = coverWidth.toFixed(2);
            this.flapInput.value = flapWidth.toFixed(2);

            // 캐시 업데이트
            this.coverCalculatorInputs.spine = spineWidth;
            this.coverCalculatorInputs.cover = coverWidth;
            this.coverCalculatorInputs.flap = flapWidth;
        }

        const totalWidth = (coverWidth * 2) + (flapWidth * 2) + spineWidth;
        const totalW_fixed = totalWidth.toFixed(2);
        const height_fixed = trimHeightMm > 0 ? trimHeightMm.toFixed(2) : '0.00';

        this.calcResultElement.textContent = `펼침면 너비 : ${totalW_fixed} x ${height_fixed} mm`;
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
        // 이미지 모드인 경우
        if (this.currentFileType === 'image' && this.imgObject) {
            // 컨테이너 크기 확인
            const container = document.getElementById('scroll-viewport');
            const containerWidth = container ? container.clientWidth - 40 : 800; // 40px 패딩

            const imgWidth = this.imgObject.width;
            const imgHeight = this.imgObject.height;
            const aspectRatio = imgWidth / imgHeight;

            // 100% 줌일 때 컨테이너에 맞춤 (PDF와 동일 로직)
            const baseWidth = containerWidth;
            const baseHeight = Math.floor(baseWidth / aspectRatio);

            // 이미지 데이터 생성 (RGB)
            const canvas = document.createElement('canvas');
            canvas.width = baseWidth;
            canvas.height = baseHeight;
            const ctx = canvas.getContext('2d');

            // 이미지 스케일링하여 그리기
            ctx.drawImage(this.imgObject, 0, 0, baseWidth, baseHeight);
            const imageData = ctx.getImageData(0, 0, baseWidth, baseHeight);

            return { imageData, baseWidth, baseHeight, spotColorData: {} };
        }

        // PDF 페이지의 실제 크기 가져오기 (포인트 단위)
        let pageSize;
        let pdfAspectRatio;

        try {
            pageSize = await this.ghostscript.getPageSize(pageNum);
            pdfAspectRatio = pageSize.width / pageSize.height;
        } catch (error) {
            pdfAspectRatio = 1 / 1.414;
        }

        // 컨테이너 크기 확인 (스크롤 뷰포트 사용)
        const container = document.getElementById('scroll-viewport');
        const containerWidth = container ? container.clientWidth - 40 : 800; // 40px 패딩

        // 100% 줌일 때 컨테이너 가로에 꽉 차게 표시
        const baseWidth = containerWidth;
        const baseHeight = Math.floor(baseWidth / pdfAspectRatio);

        // 렌더링 해상도는 DPI 설정에 따름
        const scaleFactor = (this.renderDPI || 72) / 72;
        const pdfWidthPt = pageSize ? pageSize.width : baseWidth; // pageSize is in points
        const pdfHeightPt = pageSize ? pageSize.height : baseHeight;

        const renderWidth = Math.ceil(pdfWidthPt * scaleFactor);
        const renderHeight = Math.ceil(pdfHeightPt * scaleFactor);

        let imageData = null;
        let spotColorData = {};

        // 별색이 있으면 tiffsep으로 렌더링 시도
        const hasSpotColors = this.spotColors && this.spotColors.length > 0;
        let tiffsepSuccessful = false;

        if (hasSpotColors) {
            try {
                // 렌더 시작 시점의 주석 설정에 해당하는 변형을 고정.
                // 렌더 도중 토글되면 이 결과는 원래 변형에 들어가야 한다.
                const renderVariant = this.currentVariant();
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
                        } else {
                        }
                    }
                    tiffsepSuccessful = true;

                    // 아직 백그라운드 스캔이 측정하지 못한 페이지라면 이 렌더 결과로 잉크량을 채움.
                    // 이미 측정된 페이지는 다시 계산하지 않음 — 열람할 때마다 수치가 바뀌는 것을 방지.
                    const measured = renderVariant.channel[pageNum];
                    const alreadyMeasured = measured && measured.fromTiffsep &&
                        (measured.trim || !this.hasTrimMargin(pageNum));

                    // 스캔이 아직 안 지나간 페이지면 이 고해상도 렌더로 미리보기 생성
                    // (다음에 다시 방문할 때 캐시가 밀려났어도 즉시 표시 가능)
                    if (!this.pagePreviews.has(pageNum)) {
                        this.storePagePreview(pageNum, imageData, spotColorData);
                    }

                    if (!alreadyMeasured) {
                        // 워커는 tiffsep DPI를 300으로 캡하므로 실제 사용된 DPI를 기록해야 정규화가 맞음
                        const usedDpi = result.dpi || Math.min(this.renderDPI || 72, 300);
                        this.replacePageChannelData(imageData, pageNum, usedDpi, renderVariant);
                        this.accumulateSpotColorData(spotColorData, pageNum, imageData.width, imageData.height, usedDpi, renderVariant);

                        // 화면에 보이는 변형이 바뀌었다면 수치는 그쪽 기준이어야 하므로 갱신하지 않음
                        if (renderVariant === this.currentVariant()) {
                            const spotRatios = this.calculateSpotColorRatios();
                            if (spotRatios) {
                                this.updateSpotColorRatios(spotRatios);
                            }
                            const cmykRatios = this.calculateTotalChannelRatios();
                            if (cmykRatios) {
                                this.updateChannelRatios(cmykRatios);
                            }
                        }
                    }
                } else {
                }
            } catch (error) {
                console.error('[별색 디버그] tiffsep 렌더링 실패:', error.message, error);
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

            // 스캔이 아직 안 지나간 페이지면 이 렌더로 미리보기 생성
            if (imageData && imageData.type === 'cmyk' && !this.pagePreviews.has(pageNum)) {
                this.storePagePreview(pageNum, imageData);
            }
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

    // 재단선 자동 감지 (이미지 기반 감지 + 벡터 정밀 보정)
    async detectCropMarks() {
        this.showLoading('재단선 분석 중 (정밀 모드)...');
        const pageNum = this.currentPage;
        const pageObj = this.scrollManager.pageElements.get(pageNum);

        // 메타데이터가 없는 경우(이미지 파일 등)를 위한 Fallback
        if (!this.pageMetadata.has(pageNum)) {
            if (pageObj && pageObj.canvas) {
                const widthPt = pageObj.canvas.width * (72 / this.renderDPI);
                const heightPt = pageObj.canvas.height * (72 / this.renderDPI);
                this.pageMetadata.set(pageNum, {
                    mediaBox: { x: 0, y: 0, width: widthPt, height: heightPt },
                    trimBox: { x: 0, y: 0, width: widthPt, height: heightPt },
                    cropBox: { x: 0, y: 0, width: widthPt, height: heightPt }
                });
            }
        }

        const metadata = this.pageMetadata.get(pageNum);

        if (!pageObj || !pageObj.canvas || !metadata) {
            alert('현재 페이지의 이미지 또는 메타데이터를 찾을 수 없습니다.');
            this.hideLoading();
            return;
        }

        const canvas = pageObj.canvas;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const width = canvas.width;
        const height = canvas.height;

        // ── 1단계: 이미지 기반 감지 (검증된 기존 로직) ──
        const scanMaxY = Math.min(height, 50);
        const imageData = ctx.getImageData(0, 0, width, scanMaxY);
        const pixels = imageData.data;

        const colMinB = new Array(width).fill(255);
        const colBlackCount = new Array(width).fill(0);
        const colTopY = new Array(width).fill(999);

        const darkThreshold = 160;
        const extremeDarkThreshold = 75;

        for (let x = 0; x < width; x++) {
            for (let y = 0; y < scanMaxY; y++) {
                const idx = (y * width + x) * 4;
                const brightness = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
                if (brightness < darkThreshold) {
                    colBlackCount[x]++;
                    if (colTopY[x] === 999) colTopY[x] = y;
                }
                if (brightness < colMinB[x]) colMinB[x] = brightness;
            }
        }

        let rawCandidates = [];
        for (let x = 0; x < width; x++) {
            if ((colBlackCount[x] >= 20 || colMinB[x] <= extremeDarkThreshold) && colTopY[x] <= 50) {
                rawCandidates.push({ x, topY: colTopY[x], count: colBlackCount[x], minB: colMinB[x] });
            }
        }

        let candidates = [];
        if (rawCandidates.length > 0) {
            let group = [rawCandidates[0]];
            // 트림마크는 0.25~0.5pt 두께라 캔버스에서 폭 10px을 넘지 않음.
            // 검은 배경 영역이 통째로 한 그룹으로 묶여 가짜 무게중심을 만드는 것을 차단.
            const maxGroupSpan = 10;
            const processGroup = (g) => {
                if (g[g.length - 1].x - g[0].x > maxGroupSpan) return;
                const totalWeight = g.reduce((s, c) => s + (255 - c.minB) + c.count, 0);
                const avgX = totalWeight > 0
                    ? g.reduce((s, c) => s + c.x * ((255 - c.minB) + c.count), 0) / totalWeight
                    : g.reduce((s, c) => s + c.x, 0) / g.length;
                const minTopY = Math.min(...g.map(c => c.topY));
                const maxCount = Math.max(...g.map(c => c.count));
                const minMinB = Math.min(...g.map(c => c.minB));
                candidates.push({ x: avgX, topY: minTopY, count: maxCount, minB: minMinB });
            };
            for (let i = 1; i < rawCandidates.length; i++) {
                if (rawCandidates[i].x - rawCandidates[i - 1].x <= 5) {
                    group.push(rawCandidates[i]);
                } else { processGroup(group); group = [rawCandidates[i]]; }
            }
            processGroup(group);
        }

        // TrimBox 바깥(±2pt 초과)에 있는 후보 제거. 트림마크는 TrimBox 모서리/내부에만 그려짐.
        if (metadata && metadata.trimBox) {
            const pxToPt = metadata.mediaBox.width / width;
            const trimLeftPx = (metadata.trimBox.x - 2) / pxToPt;
            const trimRightPx = (metadata.trimBox.x + metadata.trimBox.width + 2) / pxToPt;
            candidates = candidates.filter(c => c.x >= trimLeftPx && c.x <= trimRightPx);
        }

        this.allCandidates = candidates;

        // 이미지 후보 부족 시 벡터 폴백: PDF 안의 짧은 세로선 중 페이지 모서리에 위치한 것을 클러스터링.
        // 배경에 트림마크가 시각적으로 묻혀 있어도 벡터 path는 정확히 남아 있어서 잡힘.
        if (candidates.length < 4) {
            try {
                const vectorMarks = await this._findTrimMarksFromVector(pageNum, metadata, canvas.width);
                if (vectorMarks && vectorMarks.length >= 4) {
                    candidates = vectorMarks;
                    this.allCandidates = candidates;
                    console.log(`벡터 폴백으로 ${vectorMarks.length}개 재단선 후보 추출`);
                } else {
                    alert(`재단선을 찾지 못했습니다.`);
                    this.hideLoading();
                    return;
                }
            } catch (e) {
                console.warn('벡터 폴백 실패:', e);
                alert(`재단선을 찾지 못했습니다.`);
                this.hideLoading();
                return;
            }
        }

        // 6점 선별
        candidates.sort((a, b) => a.x - b.x);

        let finalMarks = [];
        const xMin = candidates[0].x;
        const xMax = candidates[candidates.length - 1].x;
        const midPx = (xMin + xMax) / 2;
        const deadZone = 15;

        const leftGroup = candidates.filter(c => c.x < midPx - deadZone);
        const rightGroup = candidates.filter(c => c.x > midPx + deadZone);
        const getScore = (c) => (c.count * 1) + (255 - c.minB) * 0.8;

        if (leftGroup.length >= 2 && rightGroup.length >= 2) {
            const x0 = leftGroup[0].x;
            const x5 = rightGroup[rightGroup.length - 1].x;
            const x2 = leftGroup[leftGroup.length - 1].x;
            const x3 = rightGroup[0].x;

            const midLeftCand = leftGroup.filter(c => c.x > x0 && c.x < x2);
            const midRightCand = rightGroup.filter(c => c.x > x3 && c.x < x5);

            let x1, x4;
            if (midLeftCand.length > 0) {
                x1 = midLeftCand.sort((a, b) => getScore(b) - getScore(a))[0].x;
            } else {
                x1 = leftGroup[Math.floor(leftGroup.length / 2)].x;
            }
            if (midRightCand.length > 0) {
                x4 = midRightCand.sort((a, b) => getScore(b) - getScore(a))[0].x;
            } else {
                x4 = rightGroup[Math.floor(rightGroup.length / 2)].x;
            }

            finalMarks = [x0, x1, x2, x3, x4, x5];
        }

        if (finalMarks.length < 6 && candidates.length >= 4) {
            finalMarks = [candidates[0].x, candidates[1].x, candidates[candidates.length - 2].x, candidates[candidates.length - 1].x];
        }

        // ── 2단계: 벡터 정밀 보정 (px → pt 스냅) ──
        this.cropMarksInPt = false; // 기본은 px 단위
        try {
            const vectorLines = await this._extractVectorVerticalLines(pageNum, metadata);
            if (vectorLines && vectorLines.length > 0) {
                const pxToPt = metadata.mediaBox.width / canvas.width;
                let refinedCount = 0;

                for (let i = 0; i < finalMarks.length; i++) {
                    const markPt = finalMarks[i] * pxToPt; // px 위치를 pt로 환산
                    // 가장 가까운 벡터 선 찾기 (3pt 이내)
                    let bestDist = 3;
                    let bestX = null;
                    for (const vl of vectorLines) {
                        const dist = Math.abs(vl.x - markPt);
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestX = vl.x;
                        }
                    }
                    if (bestX !== null) {
                        // pt 좌표를 다시 px로 변환해서 저장 (기존 px 단위 유지)
                        finalMarks[i] = bestX / pxToPt;
                        refinedCount++;
                    }
                }
                if (refinedCount > 0) {
                    console.log(`재단선 ${refinedCount}/${finalMarks.length}개 벡터 보정 완료`);
                }
            }
        } catch (e) {
            console.warn('벡터 보정 실패 (이미지 좌표 유지):', e);
        }

        this.finalMarks = finalMarks;

        this.renderCropMarkers();
        this.calculateCoverSpread();
        this.showLoading(`분석 완료!`, '');
        setTimeout(() => this.hideLoading(), 1000);
    }

    // 벡터 수직선 좌표 추출 (보정용 — 필터 없이 모든 수직선 수집)
    async _extractVectorVerticalLines(pageNum, metadata) {
        if (!this.currentPDFData) return null;

        const pdf = await pdfjsLib.getDocument({ data: this.currentPDFData.slice(0) }).promise;
        const page = await pdf.getPage(pageNum);
        const ops = await page.getOperatorList();
        const OPS = pdfjsLib.OPS;

        const ctmStack = [];
        let ctm = [1, 0, 0, 1, 0, 0];
        const verticalLines = [];
        let pendingLines = [];
        let currentPoint = null;

        const applyCtm = (x, y) => [
            ctm[0] * x + ctm[2] * y + ctm[4],
            ctm[1] * x + ctm[3] * y + ctm[5]
        ];

        const flushLines = () => {
            for (const seg of pendingLines) {
                const dx = Math.abs(seg.x1 - seg.x0);
                const dy = Math.abs(seg.y1 - seg.y0);
                // 수직선: x 변화 작고 y 변화 있으면 무조건 수집
                if (dx < 1 && dy >= 2) {
                    const yMin = Math.min(seg.y0, seg.y1);
                    const yMax = Math.max(seg.y0, seg.y1);
                    verticalLines.push({ x: (seg.x0 + seg.x1) / 2, length: dy, yMin, yMax });
                }
            }
            pendingLines = [];
            currentPoint = null;
        };

        for (let i = 0; i < ops.fnArray.length; i++) {
            const fn = ops.fnArray[i];
            const args = ops.argsArray[i];

            switch (fn) {
                case OPS.save: ctmStack.push([...ctm]); break;
                case OPS.restore: if (ctmStack.length) ctm = ctmStack.pop(); break;
                case OPS.transform:
                    if (args?.length >= 6) {
                        const [a,b,c,d,e,f] = args;
                        ctm = [
                            ctm[0]*a+ctm[2]*b, ctm[1]*a+ctm[3]*b,
                            ctm[0]*c+ctm[2]*d, ctm[1]*c+ctm[3]*d,
                            ctm[0]*e+ctm[2]*f+ctm[4], ctm[1]*e+ctm[3]*f+ctm[5]
                        ];
                    }
                    break;
                case OPS.constructPath: {
                    const [subOps, subArgs] = args;
                    let ai = 0;
                    for (const subOp of subOps) {
                        if (subOp === OPS.moveTo) {
                            const [tx,ty] = applyCtm(subArgs[ai],subArgs[ai+1]);
                            currentPoint = {x:tx,y:ty}; ai+=2;
                        } else if (subOp === OPS.lineTo) {
                            const [tx,ty] = applyCtm(subArgs[ai],subArgs[ai+1]);
                            if (currentPoint) pendingLines.push({x0:currentPoint.x,y0:currentPoint.y,x1:tx,y1:ty});
                            currentPoint = {x:tx,y:ty}; ai+=2;
                        } else if (subOp === OPS.rectangle) {
                            const rx=subArgs[ai],ry=subArgs[ai+1],rw=subArgs[ai+2],rh=subArgs[ai+3];
                            const [cx0,cy0]=applyCtm(rx,ry), [cx1,cy1]=applyCtm(rx+rw,ry+rh);
                            if (Math.abs(cx1-cx0)<2 && Math.abs(cy1-cy0)>=2) {
                                pendingLines.push({x0:(cx0+cx1)/2,y0:cy0,x1:(cx0+cx1)/2,y1:cy1});
                            }
                            ai+=4;
                        } else if (subOp === OPS.curveTo) ai+=6;
                          else if (subOp === OPS.curveTo2) ai+=4;
                          else if (subOp === OPS.curveTo3) ai+=2;
                          else if (subOp === OPS.closePath) currentPoint=null;
                    }
                    break;
                }
                case OPS.stroke: case OPS.fill: case OPS.eoFill:
                case OPS.fillStroke: case OPS.eoFillStroke:
                case OPS.closeStroke: case OPS.closeFillStroke:
                    flushLines(); break;
                case OPS.endPath:
                    pendingLines = []; currentPoint = null; break;
            }
        }

        page.cleanup();
        pdf.destroy();
        return verticalLines;
    }

    // 벡터 라인 → 트림마크 후보 (이미지 감지가 실패했을 때 폴백).
    // 페이지 상/하단 모서리 영역에 있는 짧은 세로선을 x로 클러스터링하여 추출.
    async _findTrimMarksFromVector(pageNum, metadata, canvasWidth) {
        const lines = await this._extractVectorVerticalLines(pageNum, metadata);
        if (!lines || lines.length === 0) return null;

        const pageH = metadata.mediaBox.height;
        const trimY = metadata.trimBox.y;
        const trimLeft = metadata.trimBox.x;
        const trimRight = metadata.trimBox.x + metadata.trimBox.width;
        // TrimBox 바깥(여백)에만 있는 짧은 세로선. trimY가 곧 모서리 마진 두께.
        // x도 TrimBox 안쪽 ±2pt 범위로 제한 (트림마크는 TrimBox 모서리/내부에만 그려짐)
        const cornerMargin = Math.max(trimY - 1, 5);
        const cornerLines = lines.filter(l =>
            l.length >= 3 && l.length <= 15 &&
            l.x >= trimLeft - 2 && l.x <= trimRight + 2 &&
            (l.yMin < cornerMargin || l.yMax > pageH - cornerMargin)
        );
        if (cornerLines.length === 0) return null;

        // x 좌표로 클러스터링 (±2pt 이내면 같은 마크)
        cornerLines.sort((a, b) => a.x - b.x);
        const clusters = [];
        for (const l of cornerLines) {
            const last = clusters[clusters.length - 1];
            if (last && l.x - last.xLast < 2) {
                last.members.push(l);
                last.xLast = l.x;
                last.xSum += l.x;
            } else {
                clusters.push({ xLast: l.x, xSum: l.x, members: [l] });
            }
        }

        // 멤버 3개 이상인 클러스터만 트림마크 후보 (단일 그래픽 세로선 제외)
        const strong = clusters
            .filter(c => c.members.length >= 3)
            .map(c => ({ x: c.xSum / c.members.length, count: c.members.length }));
        if (strong.length < 4) return null;

        // pt → 캔버스 px 변환
        const ptToPx = canvasWidth / metadata.mediaBox.width;
        return strong.map(c => ({
            x: c.x * ptToPx,
            topY: 0,
            count: c.count,
            minB: 0
        }));
    }

    renderCropMarkers() {
        const pageNum = this.currentPage;
        const pageObj = this.scrollManager.pageElements.get(pageNum);
        if (!pageObj || !pageObj.wrapper || !pageObj.canvas) return;

        this.clearCropMarkers();

        const canvas = pageObj.canvas;
        const scaleX = canvas.clientWidth / canvas.width;
        const showAll = this.showCandidatesToggle?.checked;

        // 체크박스가 꺼져있으면 아무것도 표시 안 함
        if (!showAll) return;

        // 1. 선택된 점들 표시 (빨간색)
        this.finalMarks.forEach((x, idx) => {
            const marker = document.createElement('div');
            marker.className = 'crop-marker selected';
            marker.style.left = `${x * scaleX}px`;
            marker.style.top = '0px';
            marker.title = `선택됨 ${idx}번 (${Math.round(x)}px)`;
            pageObj.wrapper.appendChild(marker);
        });

        // 2. 나머지 후보 표시 (노란색) - 선택된 점은 제외
        this.allCandidates.forEach((cand) => {
            const isSelected = this.finalMarks.some(fx => Math.abs(fx - cand.x) < 2);
            if (isSelected) return;

            const marker = document.createElement('div');
            marker.className = 'crop-marker candidate';
            marker.style.left = `${cand.x * scaleX}px`;
            marker.style.top = '0px';
            marker.title = `기타 후보 (${Math.round(cand.x)}px) - 클릭하여 지정`;

            marker.onclick = (e) => {
                e.stopPropagation();
                const idxStr = prompt(`이 재단선을 몇 번 위치로 지정하시겠습니까?\n(0:왼쪽끝, 1:날개접지, 2:책등시작, 3:책등끝, 4:날개접지, 5:오른쪽끝)`);
                const idx = parseInt(idxStr);
                if (!isNaN(idx) && idx >= 0 && idx < 6) {
                    this.finalMarks[idx] = cand.x;
                    this.renderCropMarkers();
                    this.calculateCoverSpread();
                }
            };

            pageObj.wrapper.appendChild(marker);
        });
    }

    updateDetectedMarksDropdown(candidates) {
        // 기능 제거됨 - renderCropMarkers에서 처리
    }

    showCropMarker(pageNum, x) {
        const pageObj = this.scrollManager.pageElements.get(pageNum);
        if (!pageObj || !pageObj.wrapper || !pageObj.canvas) return;

        this.clearCropMarkers();

        const canvas = pageObj.canvas;
        const marker = document.createElement('div');
        marker.className = 'crop-marker';

        // 마커 위치 계산 (캔버스 기준 좌표를 wrapper 기준 비율 또는 픽셀로 변환)
        // wrapper는 canvas를 담고 있고, 캔버스는 스타일로 너비가 조정될 수 있음
        const scaleX = canvas.clientWidth / canvas.width;
        const leftPx = x * scaleX;

        marker.style.left = `${leftPx}px`;
        marker.style.top = '0px';

        pageObj.wrapper.style.position = 'relative'; // 보장
        pageObj.wrapper.appendChild(marker);

        // 1초 후 자동 제거는 하지 않음 (사용자가 계속 보고 싶을 수 있으므로)
        // 대신 스크롤 등으로 페이지가 넘어가면 clear됨
    }

    /**
     * 물리 페이지(1부터) -> 파일 기준 표시 쪽번호
     */
    toDisplayPage(physicalPage) {
        return physicalPage + this.pageNumberOffset - 1;
    }

    /**
     * 파일 기준 쪽번호 -> 물리 페이지(1부터)
     */
    toPhysicalPage(displayPage) {
        return displayPage - this.pageNumberOffset + 1;
    }

    /**
     * 새 파일을 열면 쪽번호 기준을 기본값으로 되돌린다
     */
    resetPageNumberOffset() {
        this.pageNumberOffset = 1;
        const input = document.getElementById('page-number-offset');
        if (input) input.value = 1;
        this.updatePageOffsetHints();
    }

    /**
     * 쪽번호 오프셋 변경 (네비게이터 입력)
     */
    setPageNumberOffset(value) {
        const parsed = parseInt(value, 10);
        // 쪽번호 입력 파서가 양수만 받으므로 1 미만은 허용하지 않는다
        // (0 이하로 두면 표시는 되는데 범위 입력창에 타이핑할 수 없는 쪽이 생긴다)
        this.pageNumberOffset = (isNaN(parsed) || parsed < 1) ? 1 : parsed;
        this.updatePageControls();
        this.updatePageOffsetHints();
    }

    /**
     * 오프셋이 적용된 범위를 안내 문구로 표시
     */
    updatePageOffsetHints() {
        const first = this.toDisplayPage(1);
        const last = this.toDisplayPage(this.totalPages);
        const isDefault = this.pageNumberOffset === 1;

        const exportLabel = document.getElementById('export-png-offset-label');
        if (exportLabel) {
            exportLabel.textContent = isDefault
                ? '파일 기준 쪽번호로 입력'
                : `파일 기준 쪽번호로 입력 (${first}~${last})`;
        }
    }

    goToPage(pageNum) {
        // 유효성 검증
        if (isNaN(pageNum) || pageNum < 1 || pageNum > this.totalPages) {
            // 현재 페이지로 되돌리기 (표시는 파일 기준 쪽번호)
            this.currentPageInput.value = this.toDisplayPage(this.currentPage);
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
        // 입력창·총쪽수는 파일 기준 쪽번호로 표시 (내부 currentPage는 물리 페이지 유지)
        this.currentPageInput.value = this.toDisplayPage(this.currentPage);
        this.currentPageInput.min = this.toDisplayPage(1);
        this.currentPageInput.max = this.toDisplayPage(this.totalPages);
        this.totalPagesSpan.textContent = this.toDisplayPage(this.totalPages);
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

        // 채널 포함 여부를 루프 밖에서 한 번만 판정 (픽셀마다 includes() 호출 방지)
        const useC = separations.includes('cyan');
        const useM = separations.includes('magenta');
        const useY = separations.includes('yellow');
        const useK = separations.includes('black');

        // Japan Color 2001 Coated 기준 CMYK → sRGB (아크로뱃 소프트프루프와 유사).
        // 픽셀당 함수 호출이 전체 비용의 절반 이상이라 테이블을 받아 루프에 인라인한다.
        const { cmy, kCurve, idxC, idxCT, idxM, idxY, STRIDE_C } = getColorTables();

        for (let i = 0; i < pixelCount; i++) {
            // CMYK 값 (0-255, 255 = 100% 잉크)
            const c = useC ? cyan[i] : 0;
            const m = useM ? magenta[i] : 0;
            const y = useY ? yellow[i] : 0;
            const k = useK ? black[i] : 0;

            const lo = idxC[c] + idxM[m] + idxY[y];
            const hi = lo + STRIDE_C;
            const ct = idxCT[c];
            const ko = k * 3;
            const o = i * 4;

            rgbData[o] = (cmy[lo] + (cmy[hi] - cmy[lo]) * ct) * kCurve[ko];
            rgbData[o + 1] = (cmy[lo + 1] + (cmy[hi + 1] - cmy[lo + 1]) * ct) * kCurve[ko + 1];
            rgbData[o + 2] = (cmy[lo + 2] + (cmy[hi + 2] - cmy[lo + 2]) * ct) * kCurve[ko + 2];
            rgbData[o + 3] = 255; // Alpha
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

        // 채널 포함 여부와 별색 RGB를 루프 밖에서 미리 확정
        const useC = separations.includes('cyan');
        const useM = separations.includes('magenta');
        const useY = separations.includes('yellow');
        const useK = separations.includes('black');

        const spotLayers = selectedSpotColors
            .map(name => ({ data: this.spotColorData[name], rgb: getSpotColorRGB(name) }))
            .filter(layer => layer.data);

        // 렌더 루프에 인라인 (renderCMYKWithSeparation과 동일한 이유)
        const { cmy, kCurve, idxC, idxCT, idxM, idxY, STRIDE_C } = getColorTables();

        for (let i = 0; i < pixelCount; i++) {
            // 1. Japan Color 기준 CMYK → sRGB (선택된 채널만)
            const c = useC ? cyan[i] : 0;
            const m = useM ? magenta[i] : 0;
            const y = useY ? yellow[i] : 0;
            const k = useK ? black[i] : 0;

            const lo = idxC[c] + idxM[m] + idxY[y];
            const hi = lo + STRIDE_C;
            const ct = idxCT[c];
            const ko = k * 3;

            let r = (cmy[lo] + (cmy[hi] - cmy[lo]) * ct) * kCurve[ko];
            let g = (cmy[lo + 1] + (cmy[hi + 1] - cmy[lo + 1]) * ct) * kCurve[ko + 1];
            let b = (cmy[lo + 2] + (cmy[hi + 2] - cmy[lo + 2]) * ct) * kCurve[ko + 2];

            // 2. 각 별색 적용 (곱셈 블렌딩으로 오버프린트 효과 시뮬레이션)
            for (let s = 0; s < spotLayers.length; s++) {
                // 별색의 그레이스케일 강도 (0-255) → 0-1 정규화
                const intensity = spotLayers[s].data[i] / 255;

                if (intensity > 0) {
                    const spotRGB = spotLayers[s].rgb;

                    // 곱셈 블렌딩: 별색이 있는 부분은 해당 색상으로 어둡게
                    // intensity가 1이면 완전히 별색, 0이면 영향 없음
                    r *= (1 - intensity) + intensity * (spotRGB.r / 255);
                    g *= (1 - intensity) + intensity * (spotRGB.g / 255);
                    b *= (1 - intensity) + intensity * (spotRGB.b / 255);
                }
            }

            rgbData[i * 4 + 0] = r; // R (Uint8ClampedArray가 반올림·클램프 처리)
            rgbData[i * 4 + 1] = g; // G
            rgbData[i * 4 + 2] = b; // B
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

        // 채널 포함 여부를 루프 밖에서 한 번만 판정
        const useC = separations.includes('cyan');
        const useM = separations.includes('magenta');
        const useY = separations.includes('yellow');
        const useK = separations.includes('black');

        // 모든 채널이 켜져 있으면 원본 그대로 (불필요한 왕복 변환 생략)
        if (useC && useM && useY && useK) {
            this.ctx.putImageData(filteredData, 0, 0);
            return;
        }

        // 이 경로는 CMYK 원본이 없는 RGB 렌더 결과에만 쓰인다(예: 별색 없는 RGB 미리보기).
        // 여기서 쓰는 RGB→CMYK는 실제 분판이 아니라 단순 GCR 추정이므로,
        // 되돌리는 변환도 같은 순수 반전을 써야 왕복이 항등이 된다.
        // Japan Color 프로파일은 진짜 CMYK 잉크 데이터가 있는 경로
        // (renderCMYKWithSeparation / renderWithSpotColors)에만 적용한다.
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
            const filteredC = useC ? c : 0;
            const filteredM = useM ? m : 0;
            const filteredY = useY ? y : 0;
            const filteredK = useK ? k : 0;

            // CMYK를 다시 RGB로 변환
            filteredData.data[i] = 255 * (1 - filteredC) * (1 - filteredK);
            filteredData.data[i + 1] = 255 * (1 - filteredM) * (1 - filteredK);
            filteredData.data[i + 2] = 255 * (1 - filteredY) * (1 - filteredK);
        }

        // 필터링된 이미지 표시 (캔버스 전체)
        this.ctx.putImageData(filteredData, 0, 0);
    }

    // 페이지에 재단 여백(TrimBox ≠ MediaBox)이 있는지 여부
    hasTrimMargin(pageNum) {
        const meta = this.pageMetadata.get(Number(pageNum));
        if (!meta || !meta.trimBox || !meta.mediaBox) return false;
        if (!meta.mediaBox.width || !meta.mediaBox.height) return false;

        // 1pt 미만 차이면 재단 여백이 없는 것으로 간주
        return Math.abs(meta.trimBox.width - meta.mediaBox.width) >= 1 ||
            Math.abs(meta.trimBox.height - meta.mediaBox.height) >= 1;
    }

    /**
     * TrimBox(재단면)를 렌더 픽셀 좌표 사각형으로 변환.
     * 메타데이터가 없거나 TrimBox가 MediaBox와 사실상 같으면(재단 여백 없음) null.
     */
    getTrimPixelRect(pageNum, width, height) {
        if (!this.hasTrimMargin(pageNum)) return null;

        const { mediaBox, trimBox } = this.pageMetadata.get(Number(pageNum));

        // 렌더 결과가 MediaBox 전체이므로 실제 래스터 크기 기준으로 스케일 계산
        const scaleX = width / mediaBox.width;
        const scaleY = height / mediaBox.height;

        // PDF 좌표(원점 좌하단, y 위쪽) → 이미지 좌표(원점 좌상단, y 아래쪽)
        const left = Math.max(0, Math.round((trimBox.x - mediaBox.x) * scaleX));
        const right = Math.min(width, Math.round((trimBox.x - mediaBox.x + trimBox.width) * scaleX));
        const top = Math.max(0, Math.round((mediaBox.y + mediaBox.height - trimBox.y - trimBox.height) * scaleY));
        const bottom = Math.min(height, Math.round((mediaBox.y + mediaBox.height - trimBox.y) * scaleY));

        if (right <= left || bottom <= top) return null;

        return { left, top, right, bottom, totalPixels: (right - left) * (bottom - top) };
    }

    // 재단선 제외 체크박스 상태에 따라 전체/재단면 내부 카운트 선택
    selectPageCounts(pd) {
        return (this.excludeTrimArea && pd && pd.trim) ? pd.trim : pd;
    }

    /**
     * CMYK 채널의 잉크량 합산 (전체 영역 + 재단면 내부).
     * 각 채널 값(0=잉크 없음 ~ 255=100% 잉크)을 전부 더해 저장하고,
     * 비율은 합계 / (픽셀 수 × 255) × 100 — 즉 페이지 평균 잉크량(%).
     * (예전의 "2% 이상 찍힌 픽셀 면적률" 방식은 사진이 깔린 페이지에서
     *  눈에 안 보이는 미량 잉크도 100%로 계산되는 문제가 있었음)
     */
    measureChannelInk(channels, width, height, pageNum) {
        const { cyan, magenta, yellow, black } = channels;
        const totalPixels = width * height;
        const COV_MIN = 12; // "실제로 찍힌" 픽셀로 보는 최소 잉크값 (약 5%)

        // 로컬 누산기로 캐싱 (property 접근 최소화)
        // 합계(잉크량)와 별도로, 잉크가 찍힌 픽셀 수(cov)도 기록 —
        // 아주 작은 개체(가는 선/로고)는 평균 잉크량으로는 0에 수렴해서 면적으로 잡아야 함
        let lc = 0, lm = 0, ly = 0, lk = 0;
        let cc = 0, cm = 0, cy = 0, ck = 0;
        for (let i = 0; i < totalPixels; i++) {
            lc += cyan[i];
            lm += magenta[i];
            ly += yellow[i];
            lk += black[i];
            if (cyan[i] > COV_MIN) cc++;
            if (magenta[i] > COV_MIN) cm++;
            if (yellow[i] > COV_MIN) cy++;
            if (black[i] > COV_MIN) ck++;
        }

        const counts = {
            cyan: lc,
            magenta: lm,
            yellow: ly,
            black: lk,
            totalPixels: totalPixels,
            cov: { cyan: cc, magenta: cm, yellow: cy, black: ck }
        };

        // 재단면 내부만 별도 합산 (재단 여백이 있는 페이지만)
        const rect = this.getTrimPixelRect(pageNum, width, height);
        if (rect) {
            let tc = 0, tm = 0, tYellow = 0, tk = 0;
            let tcc = 0, tcm = 0, tcy = 0, tck = 0;
            for (let row = rect.top; row < rect.bottom; row++) {
                const off = row * width;
                for (let col = rect.left; col < rect.right; col++) {
                    const i = off + col;
                    tc += cyan[i];
                    tm += magenta[i];
                    tYellow += yellow[i];
                    tk += black[i];
                    if (cyan[i] > COV_MIN) tcc++;
                    if (magenta[i] > COV_MIN) tcm++;
                    if (yellow[i] > COV_MIN) tcy++;
                    if (black[i] > COV_MIN) tck++;
                }
            }
            counts.trim = {
                cyan: tc,
                magenta: tm,
                yellow: tYellow,
                black: tk,
                totalPixels: rect.totalPixels,
                cov: { cyan: tcc, magenta: tcm, yellow: tcy, black: tck }
            };
        }

        return counts;
    }

    // 현재 주석 설정에 해당하는 변형 슬롯
    currentVariant() {
        return this.excludeAnnotations ? this.scanVariants.noAnnots : this.scanVariants.annots;
    }

    // 모든 변형의 측정 결과를 버림 (새 문서 로딩 시)
    resetScanVariants() {
        this.scanVariants = {
            annots: { channel: {}, spot: {}, scanned: false },
            noAnnots: { channel: {}, spot: {}, scanned: false }
        };
        this.pageChannelData = this.currentVariant().channel;
        this.pageSpotColorData = this.currentVariant().spot;
        // 미리보기도 문서 단위 데이터 — 함께 초기화
        // (주석 토글은 switchScanVariant만 타므로 미리보기가 유지되고, 재스캔이 서서히 갱신)
        if (this.pagePreviews) this.pagePreviews.clear();
    }

    // 활성 변형을 현재 주석 설정에 맞게 전환.
    // pageChannelData/pageSpotColorData 를 해당 슬롯의 객체로 갈아끼우기만 하므로
    // 이후 measure/calculate 코드는 변형의 존재를 몰라도 그대로 동작한다.
    switchScanVariant() {
        const variant = this.currentVariant();
        this.pageChannelData = variant.channel;
        this.pageSpotColorData = variant.spot;
        return variant;
    }

    accumulateChannelData(cmykData, pageNum, dpi = 72, variant = null) {
        // 페이지별 CMYK 사용 픽셀 수 기록 (호출당 페이지 전체 데이터이므로 교체 방식)
        if (!cmykData || cmykData.type !== 'cmyk') {
            return;
        }

        const store = (variant || this.currentVariant()).channel;

        // tiffsep으로 이미 교정된 페이지는 tiff32nc(별색 섞임) 데이터로 되돌리지 않음
        const existing = store[pageNum];
        if (existing && existing.fromTiffsep) {
            return;
        }

        const counts = this.measureChannelInk(cmykData.channels, cmykData.width, cmykData.height, pageNum);
        store[pageNum] = { ...counts, dpi: dpi };
    }

    /**
     * tiffsep의 깨끗한 CMYK 데이터로 해당 페이지의 기존 tiff32nc 데이터를 교체.
     * tiffsep CMYK에는 별색이 포함되어 있지 않으므로 정확한 프로세스 컬러 비율을 얻을 수 있음.
     */
    replacePageChannelData(cmykData, pageNum, dpi = 72, variant = null) {
        if (!cmykData || cmykData.type !== 'cmyk') return;

        // tiffsep CMYK로 새로 카운트하여 페이지 데이터 교체
        const counts = this.measureChannelInk(cmykData.channels, cmykData.width, cmykData.height, pageNum);
        (variant || this.currentVariant()).channel[pageNum] = { ...counts, dpi: dpi, fromTiffsep: true };
    }

    accumulateSpotColorData(spotColorChannels, pageNum, width, height, dpi = 72, variant = null) {
        // 페이지별 별색 데이터 기록 (호출당 페이지 전체 데이터이므로 교체 방식)
        // 별색이 안 쓰인 페이지도 기록해야 전체 별색 비율의 분모(문서 전체 면적)가 맞음
        if (!this.spotColors || this.spotColors.length === 0) {
            return;
        }
        if (!spotColorChannels) {
            spotColorChannels = {};
        }

        const totalPixels = width * height;
        const rect = this.getTrimPixelRect(pageNum, width, height);
        const COV_MIN = 12; // "실제로 찍힌" 픽셀로 보는 최소 잉크값 (약 5%)

        const entry = {
            totalPixels: totalPixels,
            dpi: dpi,
            cov: {}
        };
        if (rect) {
            entry.trim = { totalPixels: rect.totalPixels, cov: {} };
        }

        // 각 별색의 잉크량 합산 + 찍힌 픽셀 수 기록 (평균 잉크량/미세 면적 검출용)
        for (const colorName of this.spotColors) {
            const channelData = spotColorChannels[colorName];
            if (!channelData) continue;

            let sum = 0, covCount = 0;
            for (let i = 0; i < totalPixels; i++) {
                sum += channelData[i];
                if (channelData[i] > COV_MIN) covCount++;
            }
            entry[colorName] = sum;
            entry.cov[colorName] = covCount;

            // 재단면 내부만 별도 합산
            if (rect) {
                let trimSum = 0, trimCov = 0;
                for (let row = rect.top; row < rect.bottom; row++) {
                    const off = row * width;
                    for (let col = rect.left; col < rect.right; col++) {
                        trimSum += channelData[off + col];
                        if (channelData[off + col] > COV_MIN) trimCov++;
                    }
                }
                entry.trim[colorName] = trimSum;
                entry.trim.cov[colorName] = trimCov;
            }
        }

        (variant || this.currentVariant()).spot[pageNum] = entry;
    }



    calculateTotalChannelRatios() {
        // 페이지별 데이터로부터 전체 비율 계산.
        // 페이지마다 렌더 해상도가 다를 수 있으므로(백그라운드 스캔 72dpi, 열람 페이지 최대 300dpi)
        // 72dpi 기준 면적으로 정규화해 합산 — 고해상도 페이지가 과대 가중되는 것을 방지.
        let area = 0, c = 0, m = 0, y = 0, k = 0;
        let hasAnyTiffsep = false;

        for (const pageNum in this.pageChannelData) {
            const pd = this.pageChannelData[pageNum];
            if (!pd || !pd.totalPixels) continue;
            const counts = this.selectPageCounts(pd);
            const w = Math.pow(72 / (pd.dpi || 72), 2);
            area += counts.totalPixels * w;
            c += counts.cyan * w;
            m += counts.magenta * w;
            y += counts.yellow * w;
            k += counts.black * w;
            if (pd.fromTiffsep) hasAnyTiffsep = true;
        }

        if (area === 0) {
            return null;
        }

        // 평균 잉크량(%): 잉크값 합계 / (면적 x 255)
        const blackRatio = (k / (area * 255)) * 100;

        // 별색이 있고 아직 tiffsep 교체가 시작되지 않은 경우,
        // CMY 비율이 별색 기여분을 포함하고 있으므로 null 반환 (UI에 '분석 중...' 표시)
        if (this.spotColors && this.spotColors.length > 0 && !hasAnyTiffsep) {
            return {
                cyan: null,
                magenta: null,
                yellow: null,
                black: blackRatio
            };
        }

        return {
            cyan: (c / (area * 255)) * 100,
            magenta: (m / (area * 255)) * 100,
            yellow: (y / (area * 255)) * 100,
            black: blackRatio
        };
    }

    calculateSpotColorRatios() {
        // 페이지별 별색 데이터로부터 전체 비율 계산 (72dpi 기준 면적 정규화)
        if (!this.spotColors || this.spotColors.length === 0) {
            return null;
        }

        let area = 0;
        const counts = {};

        for (const pageNum in this.pageSpotColorData) {
            const pd = this.pageSpotColorData[pageNum];
            if (!pd || !pd.totalPixels) continue;
            const pc = this.selectPageCounts(pd);
            const w = Math.pow(72 / (pd.dpi || 72), 2);
            area += pc.totalPixels * w;
            for (const colorName of this.spotColors) {
                counts[colorName] = (counts[colorName] || 0) + (pc[colorName] || 0) * w;
            }
        }

        if (area === 0) {
            return null;
        }

        const ratios = {};
        for (const colorName of this.spotColors) {
            ratios[colorName] = ((counts[colorName] || 0) / (area * 255)) * 100;
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

        // 각 채널이 실제로 사용된 페이지 수를 표시 (별색과 동일한 기준)
        // 평균 잉크량은 툴팁으로 제공
        for (const channel of ['cyan', 'magenta', 'yellow', 'black']) {
            const el = this.channelRatioElements[channel];
            const label = document.querySelector(`.color-label.${channel}`);
            const ratio = ratios[channel];

            if (ratio === null) {
                // 별색 분리 전이라 아직 신뢰할 수 없는 채널
                if (el) el.textContent = '분석 중...';
                if (label) label.style.backgroundSize = '0% 100%';
                continue;
            }

            const usedPages = this.getChannelPageList(channel).length;
            if (el) {
                el.textContent = `${usedPages}쪽`;
                el.title = `이 채널이 사용된 페이지 수 (문서 평균 잉크량 ${ratio.toFixed(1)}%) — 클릭하면 목록`;
            }
            if (label) {
                const share = this.totalPages > 0 ? (usedPages / this.totalPages) * 100 : 0;
                label.style.backgroundSize = `${share}% 100%`;
            }
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

        // 각 별색이 사용된 페이지 수를 표시 (퍼센티지보다 실무에서 직관적)
        this.spotColors.forEach(colorName => {
            const usedPages = this.countSpotColorPages(colorName);
            const safeId = colorName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
            const ratioElement = document.getElementById(`spot-${safeId}-ratio`);

            if (ratioElement) {
                ratioElement.textContent = `${usedPages}쪽`;
                ratioElement.title = '이 별색이 사용된 페이지 수 — 클릭하면 목록';
            }

            // progress bar: 전체 페이지 대비 사용 페이지 비율로 시각화
            const checkbox = this.spotColorCheckboxes[colorName];
            if (checkbox) {
                const label = document.querySelector(`label[for="${checkbox.id}"]`);
                if (label) {
                    const share = this.totalPages > 0 ? (usedPages / this.totalPages) * 100 : 0;
                    label.style.backgroundSize = `${share}% 100%`;
                }
            }
        });

        // 별색 비율(평균 잉크량)은 내부 참조용으로 저장
        this.spotColorRatios = ratios;

    }

    // 별색이 실제로 사용된 페이지 수 (재단선 제외 체크박스 상태 반영)
    countSpotColorPages(colorName) {
        let count = 0;
        for (const pageNum in this.pageSpotColorData) {
            const counts = this.selectPageCounts(this.pageSpotColorData[pageNum]);
            if (counts && counts[colorName] > 0) {
                count++;
            }
        }
        return count;
    }

    createDummyImageData(width = 800, height = 600) {
        // 개발/테스트 목적의 더미 이미지 데이터 생성

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


    // 자주 쓰는 배율 근처(트랙 기준 ±1.2%)면 딱 떨어지게 붙인다.
    // 로그 슬라이더는 연속값이라 그냥 두면 100%에 손으로 맞추기 어렵다.
    snapZoom(zoom) {
        const stops = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5];
        const pos = this.zoomToSliderPos(zoom);
        for (const s of stops) {
            if (Math.abs(this.zoomToSliderPos(s) - pos) <= 12) return s;
        }
        return zoom;
    }

    // 슬라이더는 로그 스케일이다.
    //
    // 선형이면 25~100% 구간이 트랙의 16%밖에 안 돼서 낮은 배율은 손으로 잡기가
    // 어렵다. 로그로 두면 배율이 2배 되는 구간마다 폭이 같아져 25~100%가 트랙의
    // 46%를 차지하고, 100%가 거의 한가운데 온다.
    sliderPosToZoom(pos) {
        const t = Math.min(1, Math.max(0, pos / 1000));
        const lo = Math.log(this.minZoom);
        const hi = Math.log(this.maxZoom);
        return Math.exp(lo + (hi - lo) * t);
    }

    zoomToSliderPos(zoom) {
        const z = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
        const lo = Math.log(this.minZoom);
        const hi = Math.log(this.maxZoom);
        return Math.round(((Math.log(z) - lo) / (hi - lo)) * 1000);
    }

    // 슬라이더/라벨과 내부 배율을 함께 갱신.
    // 휠·핀치는 연속값이라 25% 단위인 슬라이더에는 가장 가까운 눈금만 반영한다.
    syncZoomUI() {
        this.zoomValue.textContent = `${Math.round(this.zoomLevel * 100)}%`;
        this.zoomSlider.value = String(this.zoomToSliderPos(this.zoomLevel));
        this.updateZoomResetBtn();
    }

    // 100%일 때는 되돌릴 것이 없으므로 버튼을 비활성화
    updateZoomResetBtn() {
        if (!this.zoomResetBtn) return;
        this.zoomResetBtn.disabled = Math.abs(this.zoomLevel - 1) < 0.005;
    }

    // 배율을 100%로 되돌린다
    resetZoom() {
        this.zoomLevel = 1.0;
        this.zoomSlider.value = String(this.zoomToSliderPos(1.0));
        this.zoomValue.textContent = '100%';
        this.updateZoomResetBtn();

        if (this.scrollManager && this.scrollManager.totalPages > 0) {
            // 슬라이더와 같은 경로 — 현재 페이지를 화면에 유지한 채 크기만 되돌린다
            this.scrollManager.zoomGestureActive = false;
            this.scrollManager.updateZoom(this.zoomLevel);
        }
    }

    // 커서를 고정점으로 배율을 곱하고 화면에 반영
    applyGestureZoom(factor, clientX, clientY) {
        if (!this.scrollManager || this.scrollManager.totalPages === 0) return;

        const min = this.minZoom;
        const max = this.maxZoom;
        const next = Math.min(max, Math.max(min, this.zoomLevel * factor));
        if (Math.abs(next - this.zoomLevel) < 0.0005) return;

        this.zoomLevel = next;
        this.syncZoomUI();
        this.scrollManager.updateZoomAnchored(next, clientX, clientY);

        // 제스처가 멎으면 관찰 범위와 렌더 해상도를 새 배율에 맞춘다
        clearTimeout(this._gestureZoomEndTimer);
        this._gestureZoomEndTimer = setTimeout(() => {
            this.scrollManager.finalizeZoom();
        }, 180);
    }

    // 트랙패드 핀치 / Cmd(Ctrl)+휠 줌
    setupGestureZoom() {
        const viewport = document.getElementById('scroll-viewport');
        if (!viewport) return;

        // 브라우저가 핀치를 페이지 전체 줌으로 가로채지 않게 한다
        viewport.style.touchAction = 'pan-x pan-y';

        // 휠 이벤트는 한 제스처에 수십 번 들어오므로 프레임당 한 번만 반영한다.
        // 누적 delta를 모아 rAF에서 한 번에 적용 — 300쪽 문서에서도 끊기지 않는다.
        let pendingDelta = 0;
        let pendingX = null;
        let pendingY = null;
        let rafId = null;

        const flush = () => {
            rafId = null;
            const delta = pendingDelta;
            pendingDelta = 0;
            if (!delta) return;

            // 지수 변환: 확대/축소가 대칭이 되고 delta가 커도 배율이 폭주하지 않는다.
            // 한 프레임 변화폭은 ±35%로 제한 — 이벤트가 한꺼번에 몰려도
            // 한 번에 크게 튀지 않게 하는 안전장치다.
            const raw = -delta / SENSITIVITY;
            const clamped = Math.max(-0.3, Math.min(0.3, raw));
            this.applyGestureZoom(Math.exp(clamped), pendingX, pendingY);
        };

        const queue = (delta, clientX, clientY) => {
            pendingDelta += delta;
            pendingX = clientX;
            pendingY = clientY;
            if (rafId === null) rafId = requestAnimationFrame(flush);
        };

        // 마우스 휠은 한 칸에 100~120 단위로 크게 들어오고, 트랙패드 핀치는
        // 1~10 단위로 잘게 들어온다. 같은 나눗수를 쓰면 한쪽이 반드시 과하거나
        // 둔해지므로 이벤트 크기를 보고 감도를 나눈다.
        const WHEEL_SENSITIVITY = 1260;
        const PINCH_SENSITIVITY = 250;
        let SENSITIVITY = PINCH_SENSITIVITY;

        viewport.addEventListener('wheel', (e) => {
            // 트랙패드 핀치는 브라우저가 ctrlKey=true인 wheel로 보낸다.
            // Cmd(맥)/Ctrl(윈도) + 휠도 같은 경로로 처리.
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();

            // deltaMode: 0=픽셀, 1=줄, 2=페이지 — 줄/페이지 단위는 픽셀로 환산
            let delta = e.deltaY;
            if (e.deltaMode === 1) delta *= 16;
            else if (e.deltaMode === 2) delta *= viewport.clientHeight;

            SENSITIVITY = Math.abs(delta) >= 40 ? WHEEL_SENSITIVITY : PINCH_SENSITIVITY;

            queue(delta, e.clientX, e.clientY);
        }, { passive: false });

        // Safari 전용 제스처 이벤트 (핀치를 wheel로 주지 않는 경우 대비)
        let gestureStartZoom = 1;
        let gestureCenter = { x: null, y: null };

        viewport.addEventListener('gesturestart', (e) => {
            e.preventDefault();
            gestureStartZoom = this.zoomLevel;
            gestureCenter = { x: e.clientX, y: e.clientY };
        });

        viewport.addEventListener('gesturechange', (e) => {
            e.preventDefault();
            if (!e.scale) return;
            // gesture 이벤트의 scale은 제스처 시작 기준 누적값이라
            // 현재 배율 대비 비율로 환산해서 넘긴다
            const target = gestureStartZoom * e.scale;
            this.applyGestureZoom(target / this.zoomLevel, gestureCenter.x, gestureCenter.y);
        });

        viewport.addEventListener('gestureend', (e) => e.preventDefault());
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

                // 채널별 잉크 비율 UI 업데이트
                this.updateChannelInkInfo(inkValues);

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

    /**
     * 마우스 위치의 채널별 잉크 비율 표시.
     * TAC는 합계만 보여주므로 어느 판에서 잉크가 오는지 알 수 없어, 채널별로 나눠 보여준다.
     * 스와치 색은 화면 렌더와 같은 Japan Color 변환을 써서 실제 표시색과 일치시킨다.
     */
    updateChannelInkInfo(inkValues) {
        if (!this.channelInkInfoContainer) return;

        if (!inkValues) {
            this.channelInkInfoContainer.innerHTML = '';
            this.channelInkInfoContainer.style.display = 'none';
            return;
        }

        const channels = [
            { key: 'cyan', label: 'C', cmyk: [255, 0, 0, 0] },
            { key: 'magenta', label: 'M', cmyk: [0, 255, 0, 0] },
            { key: 'yellow', label: 'Y', cmyk: [0, 0, 255, 0] },
            { key: 'black', label: 'K', cmyk: [0, 0, 0, 255] }
        ];

        const html = channels.map(({ key, label, cmyk }) => {
            const pct = inkValues[key] || 0;
            const rgb = cmykToRGB255(...cmyk);
            const color = `rgb(${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)})`;

            return `
                <div class="channel-ink-item">
                    <span class="channel-ink-swatch" style="background:${color}"></span>
                    <span class="channel-ink-label">${label}</span>
                    <span class="channel-ink-bar">
                        <span class="channel-ink-bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></span>
                    </span>
                    <span class="channel-ink-value">${pct.toFixed(1)}%</span>
                </div>
            `;
        }).join('');

        this.channelInkInfoContainer.style.display = 'block';
        this.channelInkInfoContainer.innerHTML = html;
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

        // 각 별색별로 잉크량 표시 (CMYK 패널과 같은 형태 — 스와치 + 막대 + 수치)
        const spotColorHTML = this.spotColors.map(colorName => {
            const inkValue = spotColorInkValues[colorName];
            if (inkValue === undefined) return '';

            const rgb = getSpotColorRGB(colorName);
            const color = `rgb(${rgb.r},${rgb.g},${rgb.b})`;

            return `
                <div class="channel-ink-item">
                    <span class="channel-ink-swatch" style="background:${color}"></span>
                    <span class="spot-ink-label" title="${colorName}">${colorName}</span>
                    <span class="channel-ink-bar">
                        <span class="channel-ink-bar-fill" style="width:${inkValue.toFixed(1)}%;background:${color}"></span>
                    </span>
                    <span class="channel-ink-value">${inkValue.toFixed(1)}%</span>
                </div>
            `;
        }).filter(html => html !== '').join('');

        // 실시간 업데이트
        this.spotInkInfoContainer.innerHTML = spotColorHTML;
    }

    clearMouseInfo() {
        this.cursorCoordsElement.textContent = '-';
        this.tacValueElement.textContent = '-';

        // 채널별 잉크 비율도 초기화 (커서가 벗어나면 이전 값이 남지 않도록)
        this.updateChannelInkInfo(null);

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
                this.updateChannelInkInfo(inkValues);
                this.updateSpotColorInkInfo(spotColorInkValues);
            }
        } catch (error) {
            console.error('잉크값 조회 실패:', error);
        }
    }



    // 페이지 목록용 퍼센티지 표기 (작은 값은 자릿수를 늘려 표시)
    formatPageRatio(ratio) {
        if (ratio >= 0.1) return `${ratio.toFixed(1)}%`;
        if (ratio >= 0.01) return `${ratio.toFixed(2)}%`;
        return '<0.01%';
    }

    /**
     * 채널이 실제로 사용된 페이지 목록 (사용량 순 정렬).
     * 라벨의 페이지 수 표시와 클릭 시 모달 목록이 같은 기준을 쓰도록 공용화.
     * 기준: 평균 잉크량 0.1% 초과 또는 찍힌 면적 0.5mm² 이상.
     */
    getChannelPageList(channel) {
        const pageList = [];
        for (const pageNum in this.pageChannelData) {
            const pageData = this.pageChannelData[pageNum];
            const pageCounts = this.selectPageCounts(pageData);
            let ratio = (pageCounts[channel] / (pageCounts.totalPixels * 255)) * 100;

            // tiffsep으로 교정되지 않은 페이지(tiff32nc, 별색이 CMY에 섞임)만
            // 별색 기여분을 근사 감산. tiffsep 데이터는 이미 별색이 분리된 깨끗한 CMYK이므로
            // 감산하면 오히려 이중 차감으로 큰 오차가 생김.
            if (!pageData.fromTiffsep &&
                ['cyan', 'magenta', 'yellow'].includes(channel) &&
                this.spotColors && this.spotColors.length > 0 &&
                this.pageSpotColorData[pageNum]) {
                const spotPageData = this.selectPageCounts(this.pageSpotColorData[pageNum]);
                for (const colorName of this.spotColors) {
                    const spotUsage = spotPageData[colorName] || 0;
                    if (spotUsage > 0 && spotPageData.totalPixels > 0) {
                        const spotCoverage = spotUsage / (spotPageData.totalPixels * 255);
                        const rgb = getSpotColorRGB(colorName);
                        const contribution = channel === 'cyan' ? (255 - rgb.r) / 255
                            : channel === 'magenta' ? (255 - rgb.g) / 255
                            : (255 - rgb.b) / 255;
                        ratio = Math.max(0, ratio - spotCoverage * contribution * 100);
                    }
                }
            }

            // 잉크가 찍힌 픽셀 수 → 실제 면적(mm²) — 가는 선/작은 로고 같은 미세 개체 검출용
            const pxPerMm = (pageData.dpi || 72) / 25.4;
            const covMm2 = ((pageCounts.cov && pageCounts.cov[channel]) || 0) / (pxPerMm * pxPerMm);

            if (ratio > 0.1 || covMm2 >= 0.5) {
                pageList.push({ pageNum: parseInt(pageNum), ratio, covMm2 });
            }
        }

        // 사용 비율 높은 순으로 정렬
        // (원시 픽셀 수는 페이지별 렌더 해상도가 달라 비교 불가 — 비율 기준으로 정렬)
        pageList.sort((a, b) => (b.ratio - a.ratio) || (b.covMm2 - a.covMm2));

        return pageList;
    }

    showChannelPageList(channel, anchorEl) {
        const channelNames = {
            cyan: 'Cyan (C)',
            magenta: 'Magenta (M)',
            yellow: 'Yellow (Y)',
            black: 'Black (K)'
        };

        const pageList = this.getChannelPageList(channel);
        this.showPageListPopover(
            anchorEl || this.channelRatioElements[channel],
            channelNames[channel],
            pageList,
            '이 채널을 사용하는 페이지가 없습니다.'
        );
    }

    showSpotColorPageList(colorName, anchorEl) {
        // 해당 별색을 사용하는 페이지별 사용량 수집
        const pageList = [];
        for (const pageNum in this.pageSpotColorData) {
            const entry = this.pageSpotColorData[pageNum];
            const pageData = this.selectPageCounts(entry);
            const usage = pageData[colorName];
            const pxPerMm = (entry.dpi || 72) / 25.4;
            const covMm2 = ((pageData.cov && pageData.cov[colorName]) || 0) / (pxPerMm * pxPerMm);
            if (usage && usage > 0) {
                const ratio = (usage / (pageData.totalPixels * 255)) * 100;
                pageList.push({ pageNum: parseInt(pageNum), ratio, covMm2 });
            }
        }

        this.showPageListPopover(anchorEl, colorName, pageList, '이 별색을 사용하는 페이지가 없습니다.');
    }

    // ===== 페이지 목록 호버 팝업 =====

    initPageListPopover() {
        this.pageListPopover = document.getElementById('page-list-popover');
        this.pageListSortMode = 'ratio'; // 'ratio' (사용률순) | 'page' (페이지순)
        this.currentPopover = null; // { anchorEl, title, pageList, emptyMsg }

        if (!this.pageListPopover) return;

        // 팝업 바깥 클릭 시 닫기 (앵커 클릭은 stopPropagation이라 여기 오지 않음)
        document.addEventListener('click', (e) => {
            if (this.currentPopover && !this.pageListPopover.contains(e.target)) {
                this.hidePageListPopover();
            }
        });

        document.getElementById('sort-by-ratio').addEventListener('click', () => this.setPageListSort('ratio'));
        document.getElementById('sort-by-page').addEventListener('click', () => this.setPageListSort('page'));

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.hidePageListPopover();
        });

        // 팝업이 position: fixed라 사이드바가 스크롤되면 앵커와 어긋남 → 닫는다.
        // 단, 팝업 내부 목록 스크롤은 예외.
        document.addEventListener('scroll', (e) => {
            if (this.currentPopover && !this.pageListPopover.contains(e.target)) {
                this.hidePageListPopover();
            }
        }, true);
    }

    // 라벨 클릭 → 팝업 토글 (같은 라벨을 다시 클릭하면 닫힘)
    attachPageListPopover(el, openFn) {
        // 이벤트 전파 차단하여 체크박스 해제 방지
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.currentPopover && this.currentPopover.anchorEl === el) {
                this.hidePageListPopover();
            } else {
                openFn();
            }
        });
    }

    showPageListPopover(anchorEl, title, pageList, emptyMsg) {
        if (!this.pageListPopover || !anchorEl) return;
        this.currentPopover = { anchorEl, title, pageList, emptyMsg };

        document.getElementById('popover-channel-name').textContent = title;
        this.renderPageListPopover();
        this.positionPageListPopover(anchorEl);
        this.pageListPopover.classList.remove('hidden');
    }

    renderPageListPopover() {
        if (!this.currentPopover) return;
        const { pageList, emptyMsg } = this.currentPopover;
        const pageListEl = document.getElementById('page-list');

        document.getElementById('sort-by-ratio').classList.toggle('active', this.pageListSortMode === 'ratio');
        document.getElementById('sort-by-page').classList.toggle('active', this.pageListSortMode === 'page');

        if (pageList.length === 0) {
            pageListEl.innerHTML = `<p class="no-pages">${emptyMsg}</p>`;
            return;
        }

        const sorted = [...pageList];
        if (this.pageListSortMode === 'page') {
            sorted.sort((a, b) => a.pageNum - b.pageNum);
        } else {
            sorted.sort((a, b) => (b.ratio - a.ratio) || (b.covMm2 - a.covMm2));
        }

        pageListEl.innerHTML = sorted.map(item =>
            `<div class="page-item" data-page="${item.pageNum}">
                페이지 ${item.pageNum} <span class="page-ratio">(${this.formatPageRatio(item.ratio)})</span>
            </div>`
        ).join('');

        // 팝업은 다른 UI를 막지 않으므로 페이지 이동 후에도 열어둔다
        // (여러 페이지를 연달아 확인 가능; 마우스가 벗어나면 자동으로 닫힘)
        pageListEl.querySelectorAll('.page-item').forEach(el => {
            el.addEventListener('click', () => {
                this.goToPage(parseInt(el.dataset.page));
            });
        });
    }

    setPageListSort(mode) {
        if (this.pageListSortMode === mode) return;
        this.pageListSortMode = mode;
        this.renderPageListPopover();
    }

    positionPageListPopover(anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        const pop = this.pageListPopover;

        // 크기를 측정하기 위해 보이지 않는 상태로 먼저 렌더
        pop.style.visibility = 'hidden';
        pop.classList.remove('hidden');
        const pw = pop.offsetWidth;
        const ph = pop.offsetHeight;

        // 기본은 앵커 왼쪽 (쪽수 라벨을 가리지 않도록), 공간이 없으면 오른쪽으로
        let left = rect.left - pw - 8;
        if (left < 8) {
            left = Math.min(rect.right + 8, window.innerWidth - pw - 8);
        }
        let top = rect.top;
        if (top + ph > window.innerHeight - 8) {
            top = Math.max(8, window.innerHeight - ph - 8);
        }

        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
        pop.style.visibility = '';
    }

    hidePageListPopover() {
        if (this.pageListPopover) this.pageListPopover.classList.add('hidden');
        this.currentPopover = null;
    }

    showError(message) {
        // 간단한 오류 표시 (실제 구현에서는 더 정교한 UI 사용)
        alert(message);
        console.error(message);
    }

    // 전역 접근용 tiffsep 테스트 메서드
    async testTiffsep() {
        try {
            const result = await this.ghostscript.testTiffsep();

            if (result.supported) {
                return { supported: true, files: result.files };
            } else {
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
            const result = await this.ghostscript.listDevices();
            return result;
        } catch (error) {
            console.error('❌ 디바이스 목록 조회 실패:', error);
            return { devices: [], error: error.message };
        }
    }

    // 특정 디바이스 테스트
    async testDevice(device, outputFile) {
        try {
            const result = await this.ghostscript.testDevice(device, outputFile);

            if (result.supported) {
                return { supported: true, files: result.files, fileSize: result.fileSize };
            } else {
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

            // 비-Latin 문자가 포함된 텍스트가 있으면 한글 폰트 로드
            const containsNonLatin = (text) => /[^\u0000-\u007F]/.test(text);
            const needsKoreanFont = emails.some(e => containsNonLatin(e));
            let koreanFontBytes = null;
            if (needsKoreanFont) {
                koreanFontBytes = await fetch('fonts/NotoSansKR-Regular.otf').then(r => r.arrayBuffer());
            }

            for (let i = 0; i < emails.length; i++) {
                const email = emails[i];
                this.wmStatus.textContent = `[${i + 1}/${emails.length}] ${email} 처리 중...`;

                // Load PDF
                const pdfDoc = await PDFDocument.load(originalPdfBytes);
                if (koreanFontBytes) pdfDoc.registerFontkit(fontkit);
                const pages = pdfDoc.getPages();
                const font = containsNonLatin(email)
                    ? await pdfDoc.embedFont(koreanFontBytes)
                    : await pdfDoc.embedFont(StandardFonts.Helvetica);

                const fontSize = parseInt(fontSizeInput.value) || 50;
                const opacityVal = parseFloat(opacityInput.value) || 0.3;

                // Draw watermark
                pages.forEach(page => {
                    const { width, height } = page.getSize();
                    const textWidth = font.widthOfTextAtSize(email, fontSize);

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
                        font: font,
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

    // ==========================================
    // Image Export Features (Spread & Separated)
    // ==========================================

    /**
     * 펼침면 저장 버튼 핸들러 (이제 PDF로 저장)
     */
    async exportSpreadImage() {
        await this.exportPDFTrimmed();
    }

    /**
     * 내부용: 분판 저장을 위해 고화질 펼침면 이미지를 생성합니다 (PNG)
     */
    async renderHighResSpread() {
        const pageNum = this.currentPage;
        const metadata = this.pageMetadata.get(pageNum);

        if (!this.currentPDFData) {
            alert('PDF 파일이 로드되지 않았습니다.');
            return null;
        }

        if (!metadata || !metadata.trimBox) {
            alert('재단 영역(TrimBox) 정보가 없습니다. 먼저 "자동 계산"을 실행하거나 값을 확인해주세요.');
            return null;
        }

        this.showLoading('고화질 렌더링 중...');

        try {
            // 1. 고화질로 페이지 재렌더링 (Ghostscript 사용)
            // pdf.js는 CMYK를 ICC 프로파일 없이 단순 변환해 색이 틀어진다
            // (리치 블랙이 푸르게 뜨는 등). 뷰어 본화면과 동일한 gs(pngalpha)
            // 경로를 쓰면 내보내기 색이 뷰어와 일치한다.
            // 인쇄용 600 DPI 또는 현재 설정된 DPI 중 높은 쪽 사용
            const exportDPI = Math.max(600, this.renderDPI);

            const renderWidth = Math.floor(metadata.mediaBox.width * exportDPI / 72);
            const renderHeight = Math.floor(metadata.mediaBox.height * exportDPI / 72);

            const gsImageData = await this.ghostscript.renderPage(pageNum, {
                dpi: exportDPI,
                width: renderWidth,
                height: renderHeight,
                pdfWidth: metadata.mediaBox.width,
                pdfHeight: metadata.mediaBox.height,
                opaque: true // 잉크 없는 영역을 투명 대신 종이 흰색으로 (JPG 검정 배경 방지)
            });

            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = renderWidth;
            tempCanvas.height = renderHeight;
            tempCanvas.getContext('2d').putImageData(gsImageData, 0, 0);

            // 2. TrimBox 영역 크롭
            const mediaBox = metadata.mediaBox;
            const trimBox = metadata.trimBox;

            const scaleX = renderWidth / mediaBox.width;
            const scaleY = renderHeight / mediaBox.height;

            let cropX = (trimBox.x - mediaBox.x) * scaleX;
            let cropW = trimBox.width * scaleX;
            let cropH = trimBox.height * scaleY;
            // PDF 좌표계(Bottom-Up) -> Canvas 좌표계(Top-Down) 변환
            let cropY = (mediaBox.height - (trimBox.y + trimBox.height)) * scaleY;

            const cropCanvas = document.createElement('canvas');
            cropCanvas.width = Math.floor(cropW);
            cropCanvas.height = Math.floor(cropH);
            const cropCtx = cropCanvas.getContext('2d');

            cropCtx.drawImage(tempCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

            this.hideLoading();

            return new Promise(r => cropCanvas.toBlob(b => r({ blob: b, width: cropW, height: cropH }), 'image/png'));

        } catch (error) {
            console.error('내보내기 실패:', error);
            alert('내보내기 중 오류가 발생했습니다: ' + error.message);
            this.hideLoading();
            return null;
        }
    }

    async exportSeparatedImages() {
        // 1. Get Inputs & Metadata
        const pageNum = this.currentPage;
        const metadata = this.pageMetadata.get(pageNum);

        // 최신 입력값으로 강제 업데이트 (수동 입력 반영용)
        this.coverCalculatorInputs.spine = parseFloat(this.spineInput.value) || 0;
        this.coverCalculatorInputs.cover = parseFloat(this.coverInput.value) || 0;
        this.coverCalculatorInputs.flap = parseFloat(this.flapInput.value) || 0;

        const spineMm = this.coverCalculatorInputs.spine;
        const coverMm = this.coverCalculatorInputs.cover;
        const flapMm = this.coverCalculatorInputs.flap;

        if (!this.currentPDFData) {
            alert('PDF 파일이 로드되지 않았습니다.');
            return;
        }

        if (!metadata || !metadata.trimBox) {
            alert('재단 영역(TrimBox) 정보가 없습니다. 먼저 "자동 계산"을 실행하거나 값을 확인해주세요.');
            return;
        }

        if (!spineMm && !coverMm) {
            alert('책등과 표지 너비가 설정되지 않았습니다. "자동 계산"을 먼저 실행하거나 값을 입력해주세요.');
            return;
        }

        // JSZip 확인
        if (!window.JSZip && typeof JSZip === 'undefined') {
            alert('JSZip 라이브러리가 로드되지 않았습니다.');
            return;
        }

        this.showLoading('원본 PDF 분할 중 (PDF Slicing)...');

        try {
            const { PDFDocument } = window.PDFLib;
            const ZipLib = window.JSZip || JSZip;
            const zip = new ZipLib();

            // 원본 PDF 로드
            const sourcePdf = await PDFDocument.load(this.currentPDFData);

            // TrimBox 및 스케일 계산 (PDF Unit 기준)
            const mediaBox = metadata.mediaBox || { x: 0, y: 0, width: 0, height: 0 };
            const trimBox = metadata.trimBox || { x: 0, y: 0, width: 0, height: 0 };

            // PDF 좌표계의 TrimBox 시작점 (x, y)
            // 주의: PDF 좌표계는 좌하단이 (0,0)임.
            const trimX = trimBox.x;
            const trimY = trimBox.y;
            const trimW = trimBox.width;
            const trimH = trimBox.height;

            // 전체 mm 너비 -> PDF Point 비율 계산
            const totalMm = (flapMm * 2) + (coverMm * 2) + spineMm; // 뒷날개+뒷표지+책등+앞표지+앞날개
            // 비율: 전체 TrimBox 너비(pt) / 전체 mm
            const ptPerMm = trimW / totalMm;

            const formatSel = document.getElementById('export-separated-format');
            const exportFormat = formatSel ? formatSel.value : 'jpg'; // 'jpg' | 'pdf'

            let currentX = trimX; // 크롭 시작 X 좌표 (PDF 좌표계)

            // 분할 파트 정의 (순서대로: 뒷날개 -> 뒷표지 -> 책등 -> 앞표지 -> 앞날개)
            let parts = [];
            // 좌표 이동은 왼쪽(TrimBox X)에서 오른쪽으로 진행
            if (flapMm > 0) {
                parts = [
                    { name: 'cover(표3)_책이름', widthMm: flapMm },
                    { name: 'cover(표4)_책이름', widthMm: coverMm },
                    { name: 'cover(책등)_책이름', widthMm: spineMm },
                    { name: 'cover(표1)_책이름', widthMm: coverMm },
                    { name: 'cover(표2)_책이름', widthMm: flapMm }
                ];
            } else {
                parts = [
                    { name: 'cover(표4)_책이름', widthMm: coverMm },
                    { name: 'cover(책등)_책이름', widthMm: spineMm },
                    { name: 'cover(표1)_책이름', widthMm: coverMm }
                ];
            }

            // JPG 내보내기용 고화질 펼침면 — GS 렌더 1회를 파트 JPG와 목업이 공유.
            // (파트별 PDF를 pdf.js로 각각 렌더하면 색이 틀어지고 N배 느리다)
            let spreadResult = null;
            let fullImage = null;
            if (exportFormat === 'jpg') {
                spreadResult = await this.renderHighResSpread();
                if (!spreadResult || !spreadResult.blob) {
                    throw new Error('고화질 펼침면 렌더링에 실패했습니다.');
                }
                fullImage = await createImageBitmap(spreadResult.blob);
            }

            // 각 파트별로 생성 (PDF: 벡터 크롭 / JPG: 펼침면 렌더에서 크롭)
            let currentMmX = 0;
            for (const part of parts) {
                if (exportFormat === 'pdf') {
                    const partWidthPt = part.widthMm * ptPerMm;

                    // 새 PDF 생성 및 페이지 복사
                    const newPdf = await PDFDocument.create();
                    const [copiedPage] = await newPdf.copyPages(sourcePdf, [pageNum - 1]);
                    newPdf.addPage(copiedPage);

                    // CropBox 설정
                    // x: 현재 x 위치
                    // y: trimBox의 y (높이는 전체 trimBox 높이 사용)
                    // width: 파트 너비
                    // height: trimBox 높이
                    copiedPage.setCropBox(currentX, trimY, partWidthPt, trimH);
                    copiedPage.setMediaBox(currentX, trimY, partWidthPt, trimH); // MediaBox도 맞춰줌 (뷰어 호환성)

                    const pdfBytes = await newPdf.save();
                    zip.file(`${part.name}.pdf`, pdfBytes);

                    currentX += partWidthPt;
                } else {
                    const pxPerMm = spreadResult.width / totalMm;
                    const x = Math.floor(currentMmX * pxPerMm);
                    const w = Math.floor(part.widthMm * pxPerMm);
                    const partCanvas = document.createElement('canvas');
                    partCanvas.width = w;
                    partCanvas.height = spreadResult.height;
                    const partCtx = partCanvas.getContext('2d');
                    // JPG는 알파가 없으므로 흰 배경을 깔고 합성
                    partCtx.fillStyle = '#ffffff';
                    partCtx.fillRect(0, 0, w, spreadResult.height);
                    partCtx.drawImage(
                        fullImage, x, 0, w, spreadResult.height, 0, 0, w, spreadResult.height);
                    const jpgBlob = await new Promise(resolve => partCanvas.toBlob(resolve, 'image/jpeg', 0.95));
                    zip.file(`${part.name}.jpg`, jpgBlob);
                }

                currentMmX += part.widthMm;
            }

            // -------------------------------------------------------------
            // Task: 목업 이미지 생성 및 추가 (2.5D Canvas Render)
            // -------------------------------------------------------------
            this.showLoading('목업 이미지 생성 중 (Canvas Rendering)...');
            try {
                // 1. 고화질 펼침면 이미지 (TrimBox 영역) — JPG 내보내기와 렌더 공유,
                //    PDF 모드였으면 여기서 생성
                if (!spreadResult) {
                    spreadResult = await this.renderHighResSpread();
                    if (spreadResult && spreadResult.blob) {
                        fullImage = await createImageBitmap(spreadResult.blob);
                    }
                }

                if (spreadResult && fullImage) {
                    // 2. 픽셀 단위 좌표 계산
                    // renderHighResSpread는 TrimBox 전체를 반환함.
                    // totalMm = 전체 너비 mm
                    const pxPerMm = spreadResult.width / totalMm;

                    // 파트별 오프셋 계산 (앞표지, 책등 위치 찾기)
                    // parts 배열은 [뒷날개?, 뒷표지, 책등, 앞표지, 앞날개?] 순서임.
                    // "책등"과 "앞표지"를 찾아야 함.
                    // parts 예: 
                    // Case A (날개O): [BackFlap, BackCover, Spine, FrontCover, FrontFlap]
                    // Case B (날개X): [BackCover, Spine, FrontCover]

                    let spinePart = parts.find(p => p.name.includes('책등'));
                    let frontPart = parts.find(p => p.name.includes('앞표지') || p.name.includes('표1'));

                    if (spinePart && frontPart) {
                        // 각 파트의 시작 X 좌표(mm)를 찾아야 함.
                        // parts 순회하며 누적
                        let currentMmX = 0;
                        let spineX = 0;
                        let frontX = 0;

                        for (const p of parts) {
                            if (p === spinePart) spineX = currentMmX;
                            if (p === frontPart) frontX = currentMmX;
                            currentMmX += p.widthMm;
                        }

                        // 3. 서브 이미지 추출 (Canvas using drawImage with sub-rect)
                        const extractSubImage = (xMm, wMm) => {
                            const x = Math.floor(xMm * pxPerMm);
                            const w = Math.floor(wMm * pxPerMm);
                            const h = spreadResult.height;

                            const cvs = document.createElement('canvas');
                            cvs.width = w;
                            cvs.height = h;
                            const ctx = cvs.getContext('2d');
                            ctx.drawImage(fullImage, x, 0, w, h, 0, 0, w, h);
                            return cvs; // returns Canvas Element (valid image source)
                        };

                        const spineImg = extractSubImage(spineX, spinePart.widthMm);
                        const frontImg = extractSubImage(frontX, frontPart.widthMm);

                        // 4. 목업 생성 (BookMockupGenerator, 면별 원근 워프)
                        // 슬라이더로 조정한 값으로 그림자 없는/있는 버전을 모두 생성
                        const mockupOptions = this.getMockupOptions();
                        const mockupBlob = await renderBookMockup(
                            frontImg,
                            spineImg,
                            frontImg.width,
                            spineImg.width,
                            frontImg.height,
                            mockupOptions
                        );
                        const mockupShadowBlob = await renderBookMockup(
                            frontImg,
                            spineImg,
                            frontImg.width,
                            spineImg.width,
                            frontImg.height,
                            { ...mockupOptions, shadow: true }
                        );

                        // 5. ZIP에 추가
                        zip.file('cover 3D(그림자X)_책이름.png', mockupBlob);
                        zip.file('cover 3D(그림자O)_책이름.png', mockupShadowBlob);
                    }
                }
            } catch (mockupError) {
                console.error('목업 생성 실패:', mockupError);
                alert('목업 생성 실패: ' + mockupError.message);
                // 목업 실패해도 전체 ZIP 다운로드는 진행
            }

            // ZIP 다운로드
            const content = await zip.generateAsync({ type: "blob" });
            this.downloadBlob(content, `separated_parts_${this.currentPage}.zip`);

            this.hideLoading();

        } catch (error) {
            console.error('PDF 분할 실패:', error);
            alert('PDF 분할 중 오류가 발생했습니다: ' + error.message);
            this.hideLoading();
        }
    }

    /**
     * 3D 목업 조정 슬라이더 값 → renderBookMockup 옵션
     * 책등 원근은 실측 관계(표지 수렴량의 1/3)로 연동한다.
     */
    getMockupOptions() {
        const pct = (id, fallback) => {
            const el = document.getElementById(id);
            const v = el ? parseInt(el.value, 10) : NaN;
            return (Number.isFinite(v) ? v : fallback) / 100;
        };
        const edge = pct('mockup-edge', 84);
        return {
            coverWidthFactor: pct('mockup-cover-width', 73),
            spineWidthFactor: pct('mockup-spine-width', 76),
            coverEdgeRatio: edge,
            spineEdgeRatio: 1 - (1 - edge) / 3,
            sizeRatio: pct('mockup-size', 75),
            posX: pct('mockup-pos-x', 50),
            posY: pct('mockup-pos-y', 50)
        };
    }

    /**
     * 3D 목업 미리보기
     * 저해상도(150 DPI) 펼침면을 1회 렌더해 표1/책등 파트를 캐시하고,
     * 슬라이더 조정 시에는 캐시된 파트로 워프만 다시 수행한다.
     */
    async previewBookMockup() {
        const pageNum = this.currentPage;
        const metadata = this.pageMetadata.get(pageNum);

        if (!this.currentPDFData) {
            alert('PDF 파일이 로드되지 않았습니다.');
            return;
        }
        if (!metadata || !metadata.trimBox || !metadata.mediaBox) {
            alert('재단 영역(TrimBox) 정보가 없습니다. 먼저 "자동 계산"을 실행하거나 값을 확인해주세요.');
            return;
        }

        const spineMm = parseFloat(this.spineInput.value) || 0;
        const coverMm = parseFloat(this.coverInput.value) || 0;
        const flapMm = parseFloat(this.flapInput.value) || 0;
        if (!spineMm && !coverMm) {
            alert('책등과 표지 너비가 설정되지 않았습니다. "자동 계산"을 먼저 실행하거나 값을 입력해주세요.');
            return;
        }

        const cacheKey = `${pageNum}|${spineMm}|${coverMm}|${flapMm}`;
        if (!this._mockupPartsCache || this._mockupPartsCache.key !== cacheKey) {
            this.showLoading('목업 미리보기 렌더링 중...');
            try {
                const previewDPI = 150;
                const mediaBox = metadata.mediaBox;
                const trimBox = metadata.trimBox;
                const renderWidth = Math.floor(mediaBox.width * previewDPI / 72);
                const renderHeight = Math.floor(mediaBox.height * previewDPI / 72);

                const gsImageData = await this.ghostscript.renderPage(pageNum, {
                    dpi: previewDPI,
                    width: renderWidth,
                    height: renderHeight,
                    pdfWidth: mediaBox.width,
                    pdfHeight: mediaBox.height,
                    opaque: true
                });
                const pageCanvas = document.createElement('canvas');
                pageCanvas.width = renderWidth;
                pageCanvas.height = renderHeight;
                pageCanvas.getContext('2d').putImageData(gsImageData, 0, 0);

                // TrimBox 크롭 좌표 (renderHighResSpread와 동일한 변환)
                const scaleX = renderWidth / mediaBox.width;
                const scaleY = renderHeight / mediaBox.height;
                const trimXpx = (trimBox.x - mediaBox.x) * scaleX;
                const trimYpx = (mediaBox.height - (trimBox.y + trimBox.height)) * scaleY;
                const trimWpx = trimBox.width * scaleX;
                const trimHpx = trimBox.height * scaleY;

                const totalMm = (flapMm * 2) + (coverMm * 2) + spineMm;
                const pxPerMm = trimWpx / totalMm;
                const spineStartMm = flapMm + coverMm;
                const frontStartMm = flapMm + coverMm + spineMm;

                const extract = (xMm, wMm) => {
                    const c = document.createElement('canvas');
                    c.width = Math.max(1, Math.floor(wMm * pxPerMm));
                    c.height = Math.max(1, Math.floor(trimHpx));
                    c.getContext('2d').drawImage(
                        pageCanvas,
                        trimXpx + xMm * pxPerMm, trimYpx, c.width, c.height,
                        0, 0, c.width, c.height);
                    return c;
                };

                this._mockupPartsCache = {
                    key: cacheKey,
                    spineC: extract(spineStartMm, spineMm),
                    frontC: extract(frontStartMm, coverMm)
                };
            } catch (error) {
                console.error('목업 미리보기 준비 실패:', error);
                alert('목업 미리보기 준비 중 오류가 발생했습니다: ' + error.message);
                this.hideLoading();
                return;
            }
            this.hideLoading();
        }

        const wrap = document.getElementById('mockup-preview-wrap');
        if (wrap) wrap.style.display = 'block';
        await this.renderMockupPreview();
    }

    /**
     * 캐시된 파트로 목업을 워프해 미리보기 캔버스에 그린다 (슬라이더 조정 시 호출)
     */
    async renderMockupPreview() {
        const cache = this._mockupPartsCache;
        const canvas = document.getElementById('mockup-preview-canvas');
        if (!cache || !canvas) return;

        try {
            const blob = await renderBookMockup(
                cache.frontC, cache.spineC,
                cache.frontC.width, cache.spineC.width, cache.frontC.height,
                this.getMockupOptions()
            );
            const bmp = await createImageBitmap(blob);
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bmp, 0, 0);

            // 크게 보기 팝업이 열려 있으면 함께 갱신
            const popup = document.getElementById('mockup-zoom-popup');
            const zoomImg = document.getElementById('mockup-zoom-img');
            if (popup && zoomImg && !popup.classList.contains('hidden')) {
                zoomImg.src = canvas.toDataURL('image/png');
            }
        } catch (error) {
            console.error('목업 미리보기 렌더 실패:', error);
        }
    }

    /**
     * AB 테스트용 표지 내려받기
     * 모든 페이지에서 앞표지(표1) 영역만 잘라서 ZIP으로 내려받기
     */
    async exportABTestCovers() {
        // 입력값 업데이트
        this.coverCalculatorInputs.spine = parseFloat(this.spineInput.value) || 0;
        this.coverCalculatorInputs.cover = parseFloat(this.coverInput.value) || 0;
        this.coverCalculatorInputs.flap = parseFloat(this.flapInput.value) || 0;

        const spineMm = this.coverCalculatorInputs.spine;
        const coverMm = this.coverCalculatorInputs.cover;
        const flapMm = this.coverCalculatorInputs.flap;

        if (!this.currentPDFData) {
            alert('PDF 파일이 로드되지 않았습니다.');
            return;
        }

        if (!spineMm && !coverMm) {
            alert('책등과 표지 너비가 설정되지 않았습니다. "자동 계산"을 먼저 실행하거나 값을 입력해주세요.');
            return;
        }

        if (!window.JSZip && typeof JSZip === 'undefined') {
            alert('JSZip 라이브러리가 로드되지 않았습니다.');
            return;
        }

        this.showLoading('AB 테스트용 앞표지 추출 중...');

        try {
            const ZipLib = window.JSZip || JSZip;
            const zip = new ZipLib();

            const totalPages = this.totalPages;
            const exportDPI = 600;

            // 앞표지 시작 오프셋 (mm): 뒷날개 + 뒷표지 + 책등
            const frontCoverOffsetMm = (flapMm > 0 ? flapMm : 0) + coverMm + spineMm;
            const totalMm = (flapMm > 0 ? flapMm * 2 : 0) + (coverMm * 2) + spineMm;

            for (let i = 0; i < totalPages; i++) {
                const pageNum = i + 1;
                this.showLoading(`AB 테스트용 앞표지 추출 중... (${pageNum}/${totalPages})`);

                // 해당 페이지의 metadata에서 trimBox 가져오기
                const metadata = this.pageMetadata.get(pageNum);
                if (!metadata || !metadata.trimBox || !metadata.mediaBox) {
                    console.warn(`페이지 ${pageNum}: TrimBox 없음, 건너뜀`);
                    continue;
                }

                const mediaBox = metadata.mediaBox;
                const trimBox = metadata.trimBox;
                const ptPerMm = trimBox.width / totalMm;
                const frontCoverX = trimBox.x + (frontCoverOffsetMm * ptPerMm);
                const frontCoverW = coverMm * ptPerMm;

                // 페이지 전체를 GS로 렌더 후 앞표지 영역만 크롭
                // (pdf.js는 CMYK 색이 틀어짐 — renderHighResSpread와 동일 경로 사용)
                const renderWidth = Math.floor(mediaBox.width * exportDPI / 72);
                const renderHeight = Math.floor(mediaBox.height * exportDPI / 72);
                const gsImageData = await this.ghostscript.renderPage(pageNum, {
                    dpi: exportDPI,
                    width: renderWidth,
                    height: renderHeight,
                    pdfWidth: mediaBox.width,
                    pdfHeight: mediaBox.height,
                    opaque: true
                });
                const pageCanvas = document.createElement('canvas');
                pageCanvas.width = renderWidth;
                pageCanvas.height = renderHeight;
                pageCanvas.getContext('2d').putImageData(gsImageData, 0, 0);

                const scaleX = renderWidth / mediaBox.width;
                const scaleY = renderHeight / mediaBox.height;
                const cropX = (frontCoverX - mediaBox.x) * scaleX;
                // PDF 좌표계(Bottom-Up) -> Canvas 좌표계(Top-Down) 변환
                const cropY = (mediaBox.height - (trimBox.y + trimBox.height)) * scaleY;
                const cropW = frontCoverW * scaleX;
                const cropH = trimBox.height * scaleY;

                const partCanvas = document.createElement('canvas');
                partCanvas.width = Math.floor(cropW);
                partCanvas.height = Math.floor(cropH);
                const partCtx = partCanvas.getContext('2d');
                // JPG는 알파가 없으므로 흰 배경을 깔고 합성
                partCtx.fillStyle = '#ffffff';
                partCtx.fillRect(0, 0, partCanvas.width, partCanvas.height);
                partCtx.drawImage(pageCanvas, cropX, cropY, cropW, cropH, 0, 0, partCanvas.width, partCanvas.height);
                const jpgBlob = await new Promise(resolve => partCanvas.toBlob(resolve, 'image/jpeg', 0.95));
                zip.file(`cover_${String(pageNum).padStart(3, '0')}.jpg`, jpgBlob);
            }

            const content = await zip.generateAsync({ type: "blob" });
            this.downloadBlob(content, `ab_test_covers.zip`);

            this.hideLoading();

        } catch (error) {
            console.error('AB 테스트 표지 추출 실패:', error);
            alert('AB 테스트 표지 추출 중 오류가 발생했습니다: ' + error.message);
            this.hideLoading();
        }
    }

    /**
     * 지정한 쪽들을 각각 PNG로 변환해 ZIP으로 내려받습니다.
     * TrimBox가 있는 페이지는 재단선을 제외한 영역만 크롭합니다.
     */
    async exportPagesAsPngZip() {
        if (!this.currentPDFData) {
            alert('PDF 파일이 로드되지 않았습니다.');
            return;
        }

        if (!this.ghostscript) {
            alert('Ghostscript가 초기화되지 않았습니다.');
            return;
        }

        if (!window.JSZip && typeof JSZip === 'undefined') {
            alert('JSZip 라이브러리가 로드되지 않았습니다.');
            return;
        }

        const rangeInp = document.getElementById('export-png-range');
        const dpiSel = document.getElementById('export-png-dpi');
        const offsetChk = document.getElementById('export-png-use-offset');
        const rangeStr = rangeInp ? rangeInp.value.trim() : '';
        const exportDPI = dpiSel ? parseInt(dpiSel.value, 10) : 300;
        const useOffset = offsetChk ? offsetChk.checked : false;

        // 비워두면 전체 페이지
        let targetPages;
        try {
            if (!rangeStr) {
                targetPages = Array.from({ length: this.totalPages }, (_, i) => i + 1);
            } else if (useOffset) {
                // 입력값이 파일 기준 쪽번호 -> 물리 페이지로 변환해서 파싱
                const minDisplay = this.toDisplayPage(1);
                const maxDisplay = this.toDisplayPage(this.totalPages);
                const displayPages = this.parsePageRange(rangeStr, Number.MAX_SAFE_INTEGER);
                const outOfRange = displayPages.filter(p => p < minDisplay || p > maxDisplay);
                targetPages = displayPages
                    .filter(p => p >= minDisplay && p <= maxDisplay)
                    .map(p => this.toPhysicalPage(p));

                if (outOfRange.length > 0 && targetPages.length === 0) {
                    alert(`입력한 쪽번호가 범위를 벗어났습니다. 파일 기준 ${minDisplay}~${maxDisplay}쪽 중에서 지정해주세요.`);
                    return;
                }
                if (outOfRange.length > 0) {
                    const shown = outOfRange.slice(0, 10).join(', ');
                    const more = outOfRange.length > 10 ? ` 외 ${outOfRange.length - 10}개` : '';
                    alert(`범위를 벗어난 쪽은 제외했습니다: ${shown}${more}\n(파일 기준 ${minDisplay}~${maxDisplay}쪽)`);
                }
            } else {
                targetPages = this.parsePageRange(rangeStr, this.totalPages);
            }
        } catch (e) {
            alert(e.message);
            return;
        }

        if (targetPages.length === 0) {
            alert('유효한 쪽 번호가 없습니다.');
            return;
        }

        this.showLoading('PNG 변환 준비 중...');

        try {
            const ZipLib = window.JSZip || JSZip;
            const zip = new ZipLib();
            const scaleFactor = exportDPI / 72;

            let trimmedCount = 0;
            for (let i = 0; i < targetPages.length; i++) {
                const pageNum = targetPages[i];
                this.showLoading(`PNG 변환 중... (${i + 1}/${targetPages.length})`);

                // GS로 렌더 (pdf.js는 CMYK 색이 틀어짐 — 뷰어와 동일 경로 사용)
                const metadata = this.pageMetadata.get(pageNum);
                const pageSize = (metadata && metadata.mediaBox)
                    ? { width: metadata.mediaBox.width, height: metadata.mediaBox.height }
                    : await this.ghostscript.getPageSize(pageNum);

                const renderWidth = Math.floor(pageSize.width * scaleFactor);
                const renderHeight = Math.floor(pageSize.height * scaleFactor);
                const gsImageData = await this.ghostscript.renderPage(pageNum, {
                    dpi: exportDPI,
                    width: renderWidth,
                    height: renderHeight,
                    pdfWidth: pageSize.width,
                    pdfHeight: pageSize.height,
                    opaque: true
                });
                const gsCanvas = document.createElement('canvas');
                gsCanvas.width = renderWidth;
                gsCanvas.height = renderHeight;
                gsCanvas.getContext('2d').putImageData(gsImageData, 0, 0);

                const canvas = document.createElement('canvas');
                canvas.width = renderWidth;
                canvas.height = renderHeight;
                const ctx = canvas.getContext('2d');

                // 투명 PNG로 나오지 않도록 흰 배경을 먼저 깔아준다
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(gsCanvas, 0, 0);

                // TrimBox가 있으면 재단선 제외 영역만 크롭
                let outCanvas = canvas;

                if (metadata && metadata.trimBox && metadata.mediaBox) {
                    const mediaBox = metadata.mediaBox;
                    const trimBox = metadata.trimBox;

                    const scaleX = canvas.width / mediaBox.width;
                    const scaleY = canvas.height / mediaBox.height;

                    const cropX = (trimBox.x - mediaBox.x) * scaleX;
                    // PDF 좌표계(Bottom-Up) -> Canvas 좌표계(Top-Down) 변환
                    const cropY = (mediaBox.height - (trimBox.y - mediaBox.y + trimBox.height)) * scaleY;
                    const cropW = trimBox.width * scaleX;
                    const cropH = trimBox.height * scaleY;

                    if (cropW >= 1 && cropH >= 1) {
                        const cropCanvas = document.createElement('canvas');
                        cropCanvas.width = Math.floor(cropW);
                        cropCanvas.height = Math.floor(cropH);
                        const cropCtx = cropCanvas.getContext('2d');
                        cropCtx.drawImage(
                            canvas,
                            cropX, cropY, cropW, cropH,
                            0, 0, cropCanvas.width, cropCanvas.height
                        );
                        outCanvas = cropCanvas;
                        trimmedCount++;
                    }
                }

                // 파일명도 사용자가 지정한 기준(파일 쪽번호/물리 페이지)에 맞춘다
                const labelNum = useOffset ? this.toDisplayPage(pageNum) : pageNum;
                const blob = await new Promise(resolve => outCanvas.toBlob(resolve, 'image/png'));
                zip.file(`page_${String(labelNum).padStart(3, '0')}.png`, blob);
            }

            this.showLoading('ZIP 압축 중...');
            const content = await zip.generateAsync({ type: 'blob' });
            this.downloadBlob(content, `pages_png_${exportDPI}dpi.zip`);

            this.hideLoading();

            const untrimmed = targetPages.length - trimmedCount;
            if (untrimmed > 0) {
                alert(`${targetPages.length}쪽 중 ${untrimmed}쪽은 TrimBox 정보가 없어 재단선을 제외하지 않고 전체 영역으로 저장했습니다.`);
            }
        } catch (error) {
            console.error('PNG ZIP 내보내기 실패:', error);
            alert('PNG 변환 중 오류가 발생했습니다: ' + error.message);
            this.hideLoading();
        }
    }

    /**
     * 원본 PDF를 가져와서 TrimBox 크기로 크롭하여 내보냅니다.
     * (벡터 정보 및 원본 색상 프로파일 보존)
     */
    parsePageRange(rangeStr, maxPage) {
        const result = new Set();
        const parts = (rangeStr || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const part of parts) {
            const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
            if (m) {
                let a = parseInt(m[1], 10);
                let b = parseInt(m[2], 10);
                if (a > b) [a, b] = [b, a];
                for (let i = a; i <= b; i++) {
                    if (i >= 1 && i <= maxPage) result.add(i);
                }
            } else if (/^\d+$/.test(part)) {
                const n = parseInt(part, 10);
                if (n >= 1 && n <= maxPage) result.add(n);
            } else {
                throw new Error(`잘못된 범위 형식: "${part}"`);
            }
        }
        return Array.from(result).sort((a, b) => a - b);
    }

    async exportPDFTrimmed() {
        if (!this.currentPDFData) {
            alert('PDF 파일이 로드되지 않았습니다.');
            return;
        }

        const modeSel = document.getElementById('export-spread-mode');
        const rangeInp = document.getElementById('export-spread-range');
        const mode = modeSel ? modeSel.value : 'current';

        let targetPages = [];
        try {
            if (mode === 'current') {
                targetPages = [this.currentPage];
            } else if (mode === 'all') {
                targetPages = Array.from({ length: this.totalPages }, (_, i) => i + 1);
            } else if (mode === 'range') {
                const rangeStr = rangeInp ? rangeInp.value.trim() : '';
                if (!rangeStr) {
                    alert('쪽수 범위를 입력해주세요. (예: 1-3,5,7-9)');
                    return;
                }
                targetPages = this.parsePageRange(rangeStr, this.totalPages);
                if (targetPages.length === 0) {
                    alert('유효한 쪽 번호가 없습니다.');
                    return;
                }
            }
        } catch (e) {
            alert(e.message);
            return;
        }

        const missing = targetPages.filter(p => {
            const md = this.pageMetadata.get(p);
            return !md || !md.trimBox;
        });
        if (missing.length === targetPages.length) {
            alert('재단 영역(TrimBox) 정보가 없습니다. 먼저 "자동 계산"을 실행해주세요.');
            return;
        }

        this.showLoading('원본 PDF 처리 중...');

        try {
            const { PDFDocument } = window.PDFLib;
            const sourcePdf = await PDFDocument.load(this.currentPDFData);
            const exportPdf = await PDFDocument.create();

            const validPages = targetPages.filter(p => {
                const md = this.pageMetadata.get(p);
                return md && md.trimBox;
            });

            const copiedPages = await exportPdf.copyPages(sourcePdf, validPages.map(p => p - 1));
            copiedPages.forEach((page, i) => {
                const md = this.pageMetadata.get(validPages[i]);
                const { x, y, width, height } = md.trimBox;
                page.setCropBox(x, y, width, height);
                page.setMediaBox(x, y, width, height);
                exportPdf.addPage(page);
            });

            const pdfBytes = await exportPdf.save();
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });

            let filename;
            if (mode === 'current') {
                filename = `cover_original_trimmed_${this.currentPage}.pdf`;
            } else if (mode === 'all') {
                filename = `cover_original_trimmed_all.pdf`;
            } else {
                filename = `cover_original_trimmed_p${validPages[0]}-${validPages[validPages.length - 1]}.pdf`;
            }
            this.downloadBlob(blob, filename);

            this.hideLoading();

            if (missing.length > 0) {
                alert(`${missing.length}개 페이지는 TrimBox 정보가 없어 제외되었습니다: ${missing.join(', ')}`);
            }
        } catch (error) {
            console.error('PDF 내보내기 실패:', error);
            alert('PDF 처리 중 오류가 발생했습니다: ' + error.message);
            this.hideLoading();
        }
    }

    // Helper for downloading blobs
    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }
}

// Selection Manager - Drag-to-Select Logic
