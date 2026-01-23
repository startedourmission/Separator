import { getSpotColorRGB } from './constants.js';

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
        this.maxConcurrentRenders = 2;
        this.activeRenders = 0;
        this.displayMode = 'single'; // 'single' | 'two-page'
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

        console.log(`VirtualScrollManager 초기화: ${totalPages}페이지, 비율 ${aspectRatio.toFixed(3)}`);
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

    // 첫 페이지들 우선 렌더링
    async priorityRenderFirstPages() {
        const pagesToRender = Math.min(3, this.totalPages);
        for (let i = 1; i <= pagesToRender; i++) {
            const pageEl = this.pageElements.get(i);
            if (pageEl && pageEl.status === 'placeholder') {
                // 렌더링 큐 대신 직접 렌더링
                this.activeRenders++;
                try {
                    await this.renderPage(i);
                } catch (error) {
                    console.error(`초기 페이지 ${i} 렌더링 실패:`, error);
                } finally {
                    this.activeRenders--;
                }
            }
        }
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
        if (this.activeRenders >= this.maxConcurrentRenders) return;
        if (this.renderQueue.size === 0) return;

        // 현재 뷰포트에 가장 가까운 페이지 우선
        const currentPage = this.getCurrentVisiblePage();
        const sortedQueue = Array.from(this.renderQueue).sort((a, b) => {
            return Math.abs(a - currentPage) - Math.abs(b - currentPage);
        });

        const pageNum = sortedQueue[0];
        this.renderQueue.delete(pageNum);

        this.activeRenders++;
        try {
            await this.renderPage(pageNum);
        } finally {
            this.activeRenders--;
            this.processRenderQueue();
        }
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

        // 임시 캔버스에 원본 크기로 렌더링
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = srcWidth;
        tempCanvas.height = srcHeight;
        const tempCtx = tempCanvas.getContext('2d');
        const tempImageData = tempCtx.createImageData(srcWidth, srcHeight);

        const { cyan, magenta, yellow, black } = imageData.channels;
        const pixels = tempImageData.data;

        for (let i = 0; i < srcWidth * srcHeight; i++) {
            let c = separations.cyan ? cyan[i] : 0;
            let m = separations.magenta ? magenta[i] : 0;
            let y = separations.yellow ? yellow[i] : 0;
            let k = separations.black ? black[i] : 0;

            // 별색 합성
            for (const [colorName, colorData] of Object.entries(spotColorData)) {
                if (separations.spotColors && separations.spotColors[colorName]) {
                    const spotValue = colorData[i] || 0;
                    if (spotValue > 0) {
                        const rgb = getSpotColorRGB(colorName);
                        const spotK = spotValue / 255;
                        c = Math.min(255, c + (255 - rgb.r) * spotK);
                        m = Math.min(255, m + (255 - rgb.g) * spotK);
                        y = Math.min(255, y + (255 - rgb.b) * spotK);
                    }
                }
            }

            // CMYK to RGB
            const kFactor = 1 - k / 255;
            const r = Math.max(0, Math.min(255, 255 * (1 - c / 255) * kFactor));
            const g = Math.max(0, Math.min(255, 255 * (1 - m / 255) * kFactor));
            const b = Math.max(0, Math.min(255, 255 * (1 - y / 255) * kFactor));

            const idx = i * 4;
            pixels[idx] = r;
            pixels[idx + 1] = g;
            pixels[idx + 2] = b;
            pixels[idx + 3] = 255;
        }

        tempCtx.putImageData(tempImageData, 0, 0);

        // 스케일링하여 최종 캔버스에 그리기
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(tempCanvas, 0, 0, dstWidth, dstHeight);
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

    // 현재 보이는 페이지 계산
    getCurrentVisiblePage() {
        const scrollTop = this.viewport.scrollTop;
        const viewportHeight = this.viewport.clientHeight;
        const pageFullHeight = this.pageHeight + this.pageGap;

        // 화면 중앙에 있는 페이지
        const centerY = scrollTop + viewportHeight / 2;
        const pageNum = Math.floor(centerY / pageFullHeight) + 1;

        return Math.max(1, Math.min(this.totalPages, pageNum));
    }

    // 현재 페이지 업데이트
    updateCurrentPage() {
        const newPage = this.getCurrentVisiblePage();
        if (newPage !== this.viewer.currentPage) {
            this.viewer.currentPage = newPage;
            this.viewer.updatePageControls();
            this.viewer.updatePageDimensionInfo(); // 페이지 변경 시 치수 정보 업데이트
        }
    }

    // 특정 페이지로 스크롤
    scrollToPage(pageNum) {
        const pageEl = this.pageElements.get(pageNum);
        if (!pageEl) return;

        const pageFullHeight = this.pageHeight + this.pageGap;
        const targetY = (pageNum - 1) * pageFullHeight;

        this.viewport.scrollTo({
            top: targetY,
            behavior: 'smooth'
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
                    // 단순 분판 변경 시 (기존 로직)
                    this.renderToCanvas(el.canvas, el.pageData);
                }
            }
        });
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
