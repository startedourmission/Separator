import { getSpotColorRGB } from './constants.js';
import { getColorTables } from './color-profile.js';

// Virtual Scroll Manager - 스크롤 기반 PDF 뷰어
export class VirtualScrollManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.viewport = document.getElementById('scroll-viewport');
        this.content = document.getElementById('scroll-content');
        this.pageElements = new Map(); // pageNum -> { wrapper, canvas, status }
        this.observer = null;
        this.pageWidth = 0;
        this.pageHeight = 0;
        this.pageGap = 20;
        this.bufferPages = 2;
        this.totalPages = 0;
        this.pageAspectRatio = 1 / 1.414; // A4 기본값
        this.renderQueue = new Set(); // 렌더링 대기 큐
        this.isRendering = false;
        // 워커 풀 크기에 맞춰 동시 렌더 수 결정 (풀 워커 수만큼 병렬 GS 렌더 가능)
        this.maxConcurrentRenders = viewer.workerPoolSize || 2;
        this.activeRenders = 0;
        this.displayMode = 'single'; // 'single' | 'two-page'
        this.deferredComposites = new Set(); // 분판 변경 시 화면 밖 페이지의 지연 재합성 큐
        this.zoomGestureActive = false; // 줌 제스처 중 렌더 큐 정지 플래그
        this._deferredScheduled = false;
    }

    // 초기화
    init(totalPages, aspectRatio) {
        this.totalPages = totalPages;
        this.pageAspectRatio = aspectRatio || 1 / 1.414;

        // 페이지 크기 계산
        this.recalculatePageDimensions();

        // placeholder 생성
        this.createPagePlaceholders();

        // Intersection Observer 설정
        this.setupIntersectionObserver();

        // 스크롤 이벤트 (현재 페이지 추적)
        this.viewport.addEventListener('scroll', this.debounce(() => {
            this.updateCurrentPage();
        }, 100));

        // 창 크기 변경 시 리사이징
        window.addEventListener('resize', this.debounce(() => {
            this.updateZoom(this.viewer.zoomLevel);
        }, 200));

        // 초기 첫 페이지 즉시 렌더링 (로딩 완료 직후 바로 표시)
        this.priorityRenderFirstPages();

    }

    // 모드 설정
    setDisplayMode(mode) {
        if (this.displayMode === mode) return;
        this.displayMode = mode;

        if (mode === 'two-page') {
            this.content.classList.add('two-page-view');
        } else {
            this.content.classList.remove('two-page-view');
        }

        // 줌 업데이트 호출하여 크기 재계산 및 리렌더링
        this.updateZoom(this.viewer.zoomLevel);
    }

    // 첫 페이지들 우선 렌더링 (워커 풀로 병렬 실행 — 순차 대기 없이 동시에 시작)
    async priorityRenderFirstPages() {
        const pagesToRender = Math.min(3, this.totalPages);
        const jobs = [];
        for (let i = 1; i <= pagesToRender; i++) {
            const pageEl = this.pageElements.get(i);
            if (pageEl && pageEl.status === 'placeholder') {
                // 렌더링 큐 대신 직접 렌더링
                this.activeRenders++;
                jobs.push(
                    this.renderPage(i)
                        .catch(error => console.error(`초기 페이지 ${i} 렌더링 실패:`, error))
                        .finally(() => { this.activeRenders--; })
                );
            }
        }
        await Promise.all(jobs);
    }

    // 페이지 크기 재계산
    recalculatePageDimensions() {
        const viewportWidth = this.viewport.clientWidth;
        const padding = 40; // 좌우 패딩

        if (this.displayMode === 'two-page') {
            // 2페이지 모드: 뷰포트 너비의 절반 (여백 고려)
            // gap 고려: (width - padding - gap) / 2
            const availableWidth = viewportWidth - padding - 20; // 20 is grid gap
            this.pageWidth = Math.floor((availableWidth / 2) * this.viewer.zoomLevel);
        } else {
            // 싱글 모드: 기존 로직
            this.pageWidth = Math.floor((viewportWidth - padding) * this.viewer.zoomLevel);
        }

        this.pageHeight = Math.floor(this.pageWidth / this.pageAspectRatio);
    }

    // 모든 페이지 placeholder 생성
    createPagePlaceholders() {
        this.content.innerHTML = '';
        this.pageElements.clear();

        for (let i = 1; i <= this.totalPages; i++) {
            const wrapper = document.createElement('div');
            wrapper.className = 'page-wrapper loading';
            wrapper.dataset.page = i;
            wrapper.style.width = `${this.pageWidth}px`;
            wrapper.style.height = `${this.pageHeight}px`;

            if (i === 1) {
                wrapper.classList.add('cover-page');
            }

            const pageLabel = document.createElement('div');
            pageLabel.className = 'page-label';
            pageLabel.textContent = `${i} / ${this.totalPages}`;
            wrapper.appendChild(pageLabel);

            this.content.appendChild(wrapper);

            this.pageElements.set(i, {
                wrapper,
                canvas: null,
                status: 'placeholder' // 'placeholder' | 'loading' | 'rendered'
            });
        }
    }

    // Intersection Observer 설정
    setupIntersectionObserver() {
        if (this.observer) {
            this.observer.disconnect();
        }

        const options = {
            root: this.viewport,
            rootMargin: `${this.bufferPages * this.pageHeight}px 0px`,
            threshold: 0.01
        };

        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const pageNum = parseInt(entry.target.dataset.page);

                if (entry.isIntersecting) {
                    this.queuePageRender(pageNum);
                    // 분판 변경이 지연돼 있던 페이지가 다시 보이면 즉시 재합성
                    this.flushDeferredComposite(pageNum);
                } else {
                    this.handlePageHidden(pageNum);
                }
            });
        }, options);

        this.pageElements.forEach((el) => {
            this.observer.observe(el.wrapper);
        });
    }

    // 렌더링 큐에 페이지 추가
    queuePageRender(pageNum) {
        const pageEl = this.pageElements.get(pageNum);
        if (!pageEl || pageEl.status !== 'placeholder') return;

        this.renderQueue.add(pageNum);
        this.processRenderQueue();
    }

    // 렌더링 큐 처리
    async processRenderQueue() {
        // 줌 제스처 중에는 새 렌더를 시작하지 않는다.
        // 확대하면 페이지가 커지면서 IntersectionObserver가 새 페이지를 계속
        // 물어오는데, 한 장당 GS 렌더 + CMYK 합성이 ~90ms라 제스처가 그만큼 밀린다.
        // 큐에는 그대로 쌓아두고 손을 뗀 뒤(finalizeZoom) 한꺼번에 처리한다.
        if (this.zoomGestureActive) return;
        if (this.activeRenders >= this.maxConcurrentRenders) return;
        if (this.renderQueue.size === 0) return;

        // 현재 뷰포트에 가장 가까운 페이지 우선
        const currentPage = this.getCurrentVisiblePage();
        const sortedQueue = Array.from(this.renderQueue).sort((a, b) => {
            return Math.abs(a - currentPage) - Math.abs(b - currentPage);
        });

        // 빈 슬롯을 한 번에 채운다.
        // 한 호출당 한 장만 시작하면, 여러 장이 동시에 큐에 들어왔을 때 남은 장들은
        // 다른 렌더가 끝나 finally가 다시 돌 때까지 대기한다. 그 체인이 끊기면
        // (renderPage가 이미 rendered라 즉시 반환하는 등) 큐가 그대로 멈춰 버린다.
        const slots = this.maxConcurrentRenders - this.activeRenders;
        const batch = sortedQueue.slice(0, Math.max(1, slots));

        batch.forEach((pageNum) => {
            this.renderQueue.delete(pageNum);
            this.activeRenders++;

            Promise.resolve()
                .then(() => this.renderPage(pageNum))
                .catch((error) => console.error(`페이지 ${pageNum} 렌더링 실패:`, error))
                .finally(() => {
                    this.activeRenders--;
                    this.processRenderQueue();
                });
        });
    }

    // 페이지 렌더링
    async renderPage(pageNum) {
        const pageEl = this.pageElements.get(pageNum);
        if (!pageEl || pageEl.status === 'rendered') return;

        pageEl.status = 'loading';

        try {
            // 캐시 확인
            let pageData = this.viewer.pageCache.get(pageNum);

            if (!pageData) {
                // GS 렌더(~1초)를 기다리는 동안 스캔 미리보기가 있으면 즉시 표시 —
                // 먼 페이지로 점프해도 빈 화면 대신 흐릿한 페이지가 0ms에 뜨고,
                // 아래에서 선명한 렌더가 끝나면 교체된다. (분판 토글 상태도 반영됨)
                const preview = this.viewer.pagePreviews && this.viewer.pagePreviews.get(pageNum);
                if (preview) {
                    const pvCanvas = document.createElement('canvas');
                    pvCanvas.className = 'page-canvas';
                    this.renderToCanvas(pvCanvas, preview);
                    pageEl.wrapper.innerHTML = '';
                    pageEl.wrapper.appendChild(pvCanvas);
                    pageEl.wrapper.classList.remove('loading');
                }

                // 렌더링 데이터 가져오기
                pageData = await this.viewer.renderPageData(pageNum);
                this.viewer.addToCache(pageNum, pageData);
            }

            // 캔버스 생성
            const canvas = document.createElement('canvas');
            canvas.className = 'page-canvas';
            canvas.width = this.pageWidth;
            canvas.height = this.pageHeight;

            // 분판 적용하여 캔버스에 렌더링
            this.renderToCanvas(canvas, pageData);

            // DOM에 삽입
            pageEl.wrapper.innerHTML = '';
            pageEl.wrapper.appendChild(canvas);
            pageEl.wrapper.classList.remove('loading');
            pageEl.canvas = canvas;
            pageEl.pageData = pageData;
            pageEl.status = 'rendered';

            // 마우스 이벤트 바인딩
            canvas.addEventListener('mousemove', (e) => {
                this.viewer.handleCanvasMouseMove(e, pageNum, canvas, pageData);
            });
            canvas.addEventListener('mouseleave', () => {
                this.viewer.clearMouseInfo();
            });

        } catch (error) {
            console.error(`페이지 ${pageNum} 렌더링 실패:`, error);
            pageEl.status = 'placeholder';
        }
    }

    // 캔버스에 렌더링 (분판 적용)
    renderToCanvas(canvas, pageData) {
        const ctx = canvas.getContext('2d');
        const { imageData } = pageData;

        if (!imageData) {
            // 이미지 데이터가 없으면 기본 크기로 설정 및 회색 배경
            if (canvas.width !== this.pageWidth) canvas.width = this.pageWidth;
            if (canvas.height !== this.pageHeight) canvas.height = this.pageHeight;

            ctx.fillStyle = '#f0f0f0';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return;
        }

        // 일반 RGB ImageData 처리 (이미지 파일 등)
        if (imageData.type !== 'cmyk') {
            if (canvas.width !== imageData.width || canvas.height !== imageData.height) {
                canvas.width = imageData.width;
                canvas.height = imageData.height;
            }
            ctx.putImageData(imageData, 0, 0);
            return;
        }

        // 캔버스 버퍼 크기를 고해상도 이미지 데이터에 맞춤
        if (canvas.width !== imageData.width || canvas.height !== imageData.height) {
            canvas.width = imageData.width;
            canvas.height = imageData.height;
        }

        // 현재 분판 설정 가져오기
        const separations = this.viewer.getCurrentSeparations();
        const spotColorData = pageData.spotColorData || {};

        // CMYK 렌더링
        const srcWidth = imageData.width;
        const srcHeight = imageData.height;
        const dstWidth = canvas.width;
        const dstHeight = canvas.height;

        // 임시 캔버스/버퍼 재사용 (크기 변경 시에만 재생성 — 페이지당 수십 MB 할당 방지)
        if (!this._tempCanvas || this._tempW !== srcWidth || this._tempH !== srcHeight) {
            this._tempCanvas = document.createElement('canvas');
            this._tempCanvas.width = srcWidth;
            this._tempCanvas.height = srcHeight;
            this._tempCtx = this._tempCanvas.getContext('2d');
            this._tempW = srcWidth;
            this._tempH = srcHeight;
            this._tempImageData = null;
        }
        const tempCanvas = this._tempCanvas;
        const tempCtx = this._tempCtx;
        if (!this._tempImageData) {
            this._tempImageData = tempCtx.createImageData(srcWidth, srcHeight);
        }
        const tempImageData = this._tempImageData;

        const { cyan, magenta, yellow, black } = imageData.channels;
        const pixels = tempImageData.data;

        // 분판 플래그 캐싱 (매 픽셀 property 접근 방지)
        const showC = separations.cyan;
        const showM = separations.magenta;
        const showY = separations.yellow;
        const showK = separations.black;

        // 별색 데이터 준비 (RGB 컴포넌트를 플랫 배열로 사전 추출)
        const hasSpotData = Object.keys(spotColorData).length > 0;
        const activeSpots = [];
        if (hasSpotData) {
            for (const [colorName, colorData] of Object.entries(spotColorData)) {
                if (separations.spotColors && separations.spotColors[colorName]) {
                    const rgb = getSpotColorRGB(colorName);
                    // CMY 기여분도 사전 계산
                    activeSpots.push({
                        data: colorData,
                        r: rgb.r, g: rgb.g, b: rgb.b,
                        cContrib: (255 - rgb.r) / 255,
                        mContrib: (255 - rgb.g) / 255,
                        yContrib: (255 - rgb.b) / 255
                    });
                }
            }
        }

        const totalPixels = srcWidth * srcHeight;
        const hasActiveSpots = hasSpotData && activeSpots.length > 0;

        // Japan Color 변환 테이블 — 픽셀당 함수 호출을 피하려고 루프에 인라인한다
        const { cmy, kCurve, idxC, idxCT, idxM, idxY, STRIDE_C } = getColorTables();

        for (let i = 0; i < totalPixels; i++) {
            let c = showC ? cyan[i] : 0;
            let m = showM ? magenta[i] : 0;
            let y = showY ? yellow[i] : 0;
            let k = showK ? black[i] : 0;

            const idx = i * 4;

            if (hasActiveSpots) {
                // CMY에서 별색 기여분 제거
                for (let s = 0; s < activeSpots.length; s++) {
                    const spot = activeSpots[s];
                    const sv = spot.data[i];
                    if (sv > 0) {
                        c = c - spot.cContrib * sv > 0 ? c - spot.cContrib * sv : 0;
                        m = m - spot.mContrib * sv > 0 ? m - spot.mContrib * sv : 0;
                        y = y - spot.yContrib * sv > 0 ? y - spot.yContrib * sv : 0;
                    }
                }

                // Japan Color 2001 Coated 기준 변환 (메인 뷰와 동일).
                // 별색 감산 결과는 소수라 정수로 내림 — 인덱스 표는 0-255 정수만 받는다.
                const ci = c | 0, mi = m | 0, yi = y | 0;
                const lo = idxC[ci] + idxM[mi] + idxY[yi];
                const hi = lo + STRIDE_C;
                const ct = idxCT[ci];
                const ko = k * 3;

                let r = (cmy[lo] + (cmy[hi] - cmy[lo]) * ct) * kCurve[ko];
                let g = (cmy[lo + 1] + (cmy[hi + 1] - cmy[lo + 1]) * ct) * kCurve[ko + 1];
                let b = (cmy[lo + 2] + (cmy[hi + 2] - cmy[lo + 2]) * ct) * kCurve[ko + 2];

                // 별색 RGB 블렌딩 (같은 순회 데이터 재사용)
                for (let s = 0; s < activeSpots.length; s++) {
                    const spot = activeSpots[s];
                    const sv = spot.data[i];
                    if (sv > 0) {
                        const sk = sv / 255;
                        const isk = 1 - sk;
                        r = r * isk + spot.r * sk;
                        g = g * isk + spot.g * sk;
                        b = b * isk + spot.b * sk;
                    }
                }

                pixels[idx] = r > 255 ? 255 : r < 0 ? 0 : r;
                pixels[idx + 1] = g > 255 ? 255 : g < 0 ? 0 : g;
                pixels[idx + 2] = b > 255 ? 255 : b < 0 ? 0 : b;
                pixels[idx + 3] = 255;
            } else {
                const lo = idxC[c] + idxM[m] + idxY[y];
                const hi = lo + STRIDE_C;
                const ct = idxCT[c];
                const ko = k * 3;

                pixels[idx] = (cmy[lo] + (cmy[hi] - cmy[lo]) * ct) * kCurve[ko];
                pixels[idx + 1] = (cmy[lo + 1] + (cmy[hi + 1] - cmy[lo + 1]) * ct) * kCurve[ko + 1];
                pixels[idx + 2] = (cmy[lo + 2] + (cmy[hi + 2] - cmy[lo + 2]) * ct) * kCurve[ko + 2];
                pixels[idx + 3] = 255;
            }
        }

        // 크기가 같으면 임시 캔버스를 거치지 않고 바로 출력 (전체 픽셀 복사 1회 절약)
        if (dstWidth === srcWidth && dstHeight === srcHeight) {
            ctx.putImageData(tempImageData, 0, 0);
        } else {
            tempCtx.putImageData(tempImageData, 0, 0);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(tempCanvas, 0, 0, dstWidth, dstHeight);
        }
    }

    // 페이지 언마운트
    handlePageHidden(pageNum) {
        const pageEl = this.pageElements.get(pageNum);
        if (!pageEl || pageEl.status === 'placeholder') return;

        // 렌더링 큐에서 제거
        this.renderQueue.delete(pageNum);

        // 메모리 해제 (단, 일정 범위는 유지)
        const currentPage = this.getCurrentVisiblePage();
        const distance = Math.abs(pageNum - currentPage);

        if (distance > this.bufferPages + 2) {
            if (pageEl.canvas) {
                const ctx = pageEl.canvas.getContext('2d');
                ctx.clearRect(0, 0, pageEl.canvas.width, pageEl.canvas.height);
                pageEl.canvas.width = 0;
                pageEl.canvas.height = 0;
                pageEl.wrapper.innerHTML = '';

                const pageLabel = document.createElement('div');
                pageLabel.className = 'page-label';
                pageLabel.textContent = `${pageNum} / ${this.totalPages}`;
                pageEl.wrapper.appendChild(pageLabel);
                pageEl.wrapper.classList.add('loading');

                pageEl.canvas = null;
                pageEl.pageData = null;
                pageEl.status = 'placeholder';
            }
        }
    }

    // 페이지 번호 → 세로 행 번호 (0부터).
    // 두 페이지 모드는 2단 그리드에 표지(1쪽)가 한 행을 단독 차지:
    //   0행=[1], 1행=[2,3], 2행=[4,5], ... → n쪽(n≥2)은 floor(n/2)행
    pageToRow(pageNum) {
        if (this.displayMode === 'two-page') {
            return pageNum <= 1 ? 0 : Math.floor(pageNum / 2);
        }
        return pageNum - 1;
    }

    // 현재 보이는 페이지 계산
    getCurrentVisiblePage() {
        const scrollTop = this.viewport.scrollTop;
        const viewportHeight = this.viewport.clientHeight;
        const pageFullHeight = this.pageHeight + this.pageGap;

        // 화면 중앙에 있는 행
        const centerY = scrollTop + viewportHeight / 2;
        const row = Math.floor(centerY / pageFullHeight);

        // 두 페이지 모드: 행 번호를 그 행의 왼쪽 페이지로 환산
        // (한 페이지 모드 계산을 그대로 쓰면 쪽수가 2배 속도로 어긋난다)
        const pageNum = this.displayMode === 'two-page'
            ? (row <= 0 ? 1 : row * 2)
            : row + 1;

        return Math.max(1, Math.min(this.totalPages, pageNum));
    }

    // 현재 페이지 업데이트
    updateCurrentPage() {
        const newPage = this.getCurrentVisiblePage();
        if (newPage !== this.viewer.currentPage) {
            this.viewer.currentPage = newPage;
            this.viewer.updatePageControls();
            this.viewer.updatePageDimensionInfo(); // 페이지 변경 시 치수 정보 업데이트

            // 스크롤이 멎으면 인접 페이지를 미리 렌더해 캐시 —
            // 다음 스크롤 때 GS 렌더 없이 즉시 표시된다 (워커 풀 유휴 시간 활용)
            this.viewer.preloadAdjacentPages();
        }
    }

    // 특정 페이지로 스크롤
    scrollToPage(pageNum) {
        const pageEl = this.pageElements.get(pageNum);
        if (!pageEl) return;

        const pageFullHeight = this.pageHeight + this.pageGap;
        // 두 페이지 모드는 행 기준으로 위치 계산 (한 페이지 모드 수식이면 2배 아래로 감)
        const targetY = this.pageToRow(pageNum) * pageFullHeight;

        // 먼 페이지는 즉시 점프 — 수백 페이지를 스무스 스크롤로 지나가면
        // 중간 페이지들이 IntersectionObserver에 걸려 렌더 큐만 오염시키고 도착도 늦다
        const distance = Math.abs(pageNum - this.getCurrentVisiblePage());
        this.viewport.scrollTo({
            top: targetY,
            behavior: distance > 5 ? 'auto' : 'smooth'
        });
    }

    // 줌 변경
    updateZoom(zoomLevel) {
        const currentPage = this.getCurrentVisiblePage();

        // 크기 재계산
        this.recalculatePageDimensions();

        // 모든 wrapper 크기 업데이트
        this.pageElements.forEach((el, pageNum) => {
            el.wrapper.style.width = `${this.pageWidth}px`;
            el.wrapper.style.height = `${this.pageHeight}px`;

            if (el.canvas) {
                // 고해상도 데이터가 있으면 캔버스 버퍼 크기 유지, 없으면 뷰어 크기에 맞춤
                if (el.pageData && el.pageData.imageData) {
                    el.canvas.width = el.pageData.imageData.width;
                    el.canvas.height = el.pageData.imageData.height;
                } else {
                    el.canvas.width = this.pageWidth;
                    el.canvas.height = this.pageHeight;
                }

                // 리렌더링
                if (el.pageData) {
                    this.renderToCanvas(el.canvas, el.pageData);
                }
            }
        });

        // Observer 재설정 (rootMargin 변경)
        this.setupIntersectionObserver();

        // 현재 페이지로 스크롤 복원
        requestAnimationFrame(() => {
            this.scrollToPage(currentPage);
        });
    }

    // 커서 아래(또는 가장 가까운) 페이지와 그 안에서의 상대 위치를 찾는다.
    // 페이지 사이 간격에 커서가 놓였을 때도 가장 가까운 페이지를 기준으로 잡는다.
    findAnchorPage(cursorX, cursorY, vpRect) {
        let best = null;
        let bestDist = Infinity;

        this.pageElements.forEach((el, pageNum) => {
            const r = el.wrapper.getBoundingClientRect();
            if (!r.height) return;
            const top = r.top - vpRect.top;
            const bottom = r.bottom - vpRect.top;
            // 커서가 페이지 세로 범위 밖이면 그 거리를, 안이면 0을 쓴다
            const dist = cursorY < top ? top - cursorY : (cursorY > bottom ? cursorY - bottom : 0);
            if (dist < bestDist) {
                bestDist = dist;
                best = {
                    pageNum,
                    fracX: r.width ? (cursorX - (r.left - vpRect.left)) / r.width : 0.5,
                    fracY: r.height ? (cursorY - top) / r.height : 0.5
                };
            }
        });

        return best;
    }

    // 커서 위치를 고정점으로 삼는 줌 (휠/핀치 제스처용)
    //
    // updateZoom()과 달리 현재 페이지로 스크롤을 되돌리지 않는다. 제스처 중에는
    // 커서 아래 있던 지점이 그 자리에 머물러야 하고, 매 틱마다 scrollToPage()가
    // 끼어들면 화면이 페이지 경계로 튄다. 캔버스 재합성도 보이는 페이지로만
    // 제한한다 — 300쪽 문서에서 전 페이지를 매 틱 재합성하면 제스처가 멎는다.
    updateZoomAnchored(zoomLevel, clientX, clientY) {
        const vpRect = this.viewport.getBoundingClientRect();
        const oldPageWidth = this.pageWidth;
        const oldPageHeight = this.pageHeight;

        // 커서의 뷰포트 내 위치
        const cursorX = clientX == null ? this.viewport.clientWidth / 2 : clientX - vpRect.left;
        const cursorY = clientY == null ? this.viewport.clientHeight / 2 : clientY - vpRect.top;

        if (!oldPageWidth || !oldPageHeight) {
            this.viewer.zoomLevel = zoomLevel;
            this.updateZoom(zoomLevel);
            return;
        }

        this.zoomGestureActive = true;

        // 커서 아래 페이지와, 그 페이지 안에서의 상대 위치(0~1)를 기억한다.
        // 스크롤 좌표를 배율로 곱하는 방식은 콘텐츠 패딩(20px)과 중앙 정렬 여백이
        // 배율에 따라 변하지 않아 어긋난다. 실제 요소 위치를 재는 편이 정확하다.
        const anchor = this.findAnchorPage(cursorX, cursorY, vpRect);

        this.viewer.zoomLevel = zoomLevel;
        this.recalculatePageDimensions();

        // wrapper 크기만 먼저 갱신 (캔버스 버퍼는 그대로 두고 CSS가 늘려 보여준다)
        this.pageElements.forEach((el) => {
            el.wrapper.style.width = `${this.pageWidth}px`;
            el.wrapper.style.height = `${this.pageHeight}px`;
        });

        // 레이아웃이 반영된 뒤 같은 지점이 커서 아래 오도록 스크롤 보정
        if (anchor) {
            const el = this.pageElements.get(anchor.pageNum);
            if (el) {
                const r = el.wrapper.getBoundingClientRect();
                const targetX = r.left - vpRect.left + anchor.fracX * r.width;
                const targetY = r.top - vpRect.top + anchor.fracY * r.height;
                this.viewport.scrollLeft += targetX - cursorX;
                this.viewport.scrollTop += targetY - cursorY;
            }
        }

        // 제스처 중에는 캔버스를 건드리지 않는다.
        //
        // 줌은 캔버스의 '표시 크기'만 바꿀 뿐 픽셀 내용은 그대로다. 이미 그려진
        // 버퍼를 CSS가 늘려 보여주므로 재합성할 이유가 없다. 특히 canvas.width에
        // 값을 대입하면 캔버스가 통째로 지워져서 반드시 재합성(수백만 픽셀
        // CMYK→RGB 변환)이 뒤따르는데, 이게 제스처가 밀리던 원인이었다.
        // 해상도 보정은 손을 뗀 뒤 finalizeZoom()에서 한 번만 한다.
        this.updateCurrentPage();
    }

    // 제스처가 끝난 뒤 정리 — 관찰 범위(rootMargin)를 새 페이지 높이에 맞추고,
    // 제스처 중 멈춰 뒀던 렌더 큐를 다시 돌린다.
    //
    // 배율을 올려도 재렌더는 하지 않는다. 렌더 해상도는 줌이 아니라 DPI 설정
    // (renderDPI)으로 정해지므로, 다시 렌더해도 같은 크기의 버퍼가 나올 뿐
    // 페이지당 ~90ms만 쓰고 선명해지지 않는다. 더 선명하게 보려면 DPI를 올려야 한다.
    finalizeZoom() {
        this.zoomGestureActive = false;
        this.setupIntersectionObserver();
        this.updateCurrentPage();

        // 제스처 중 멈춰 있던 큐를 이제 처리한다
        this.processRenderQueue();
    }

    // 모든 보이는 페이지 리렌더링 (분판 변경 또는 화질 변경 시)
    updateAllVisiblePages(forceGsRender = false) {
        this.pageElements.forEach((el, pageNum) => {
            if (el.status === 'rendered') {
                if (forceGsRender) {
                    // Ghostscript 재렌더링 필요 시 상태 초기화 후 큐에 추가
                    el.status = 'placeholder';
                    el.wrapper.classList.add('loading');
                    this.queuePageRender(pageNum);
                } else if (el.canvas && el.pageData) {
                    // 분판 변경: 화면에 보이는 페이지만 즉시 재합성.
                    // 버퍼에만 있는 페이지까지 동기로 돌리면 페이지당 수백만 픽셀 연산이
                    // 겹쳐 토글이 수 초씩 걸리므로, 화면 밖 페이지는 유휴 시간에 처리.
                    if (this.isWrapperInViewport(el.wrapper)) {
                        this.renderToCanvas(el.canvas, el.pageData);
                        this.deferredComposites.delete(pageNum);
                    } else {
                        this.deferredComposites.add(pageNum);
                        this.scheduleDeferredComposites();
                    }
                }
            }
        });
    }

    // 래퍼가 뷰포트(여유 100px 포함) 안에 보이는지
    isWrapperInViewport(wrapper) {
        const vp = this.viewport.getBoundingClientRect();
        const r = wrapper.getBoundingClientRect();
        return r.bottom > vp.top - 100 && r.top < vp.bottom + 100;
    }

    // 화면 밖 페이지의 분판 재합성을 유휴 시간에 하나씩 처리
    scheduleDeferredComposites() {
        if (this._deferredScheduled) return;
        this._deferredScheduled = true;

        const runOne = () => {
            this._deferredScheduled = false;
            const next = this.deferredComposites.values().next();
            if (next.done) return;

            const pageNum = next.value;
            this.deferredComposites.delete(pageNum);

            const el = this.pageElements.get(pageNum);
            if (el && el.status === 'rendered' && el.canvas && el.pageData) {
                this.renderToCanvas(el.canvas, el.pageData);
            }

            if (this.deferredComposites.size > 0) {
                this.scheduleDeferredComposites();
            }
        };

        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(runOne, { timeout: 2000 });
        } else {
            setTimeout(runOne, 50);
        }
    }

    // 지연돼 있던 페이지가 다시 보이게 되면 즉시 재합성 (낡은 분판 상태 노출 방지)
    flushDeferredComposite(pageNum) {
        if (!this.deferredComposites.has(pageNum)) return;
        this.deferredComposites.delete(pageNum);

        const el = this.pageElements.get(pageNum);
        if (el && el.status === 'rendered' && el.canvas && el.pageData) {
            this.renderToCanvas(el.canvas, el.pageData);
        }
    }

    // 디바운스 유틸리티
    debounce(func, wait) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    // 정리
    destroy() {
        if (this.observer) {
            this.observer.disconnect();
        }
        this.pageElements.clear();
        this.renderQueue.clear();
        this.content.innerHTML = '';
    }
}
