export class OverprintComparison {
    constructor(manager) {
        this.manager = manager;
        this.viewer = manager.viewer;
        this.enabled = false;
        this.position = 50;
        this.toggle = document.getElementById('overprint-compare-toggle');
        this.status = document.getElementById('overprint-compare-status');
        this.toggle.addEventListener('click', () => this.setEnabled(!this.enabled));
        this.syncAvailability();
    }

    syncAvailability() {
        this.toggle.disabled = this.viewer.currentFileType !== 'pdf' || !this.viewer.currentPDFData;
        if (this.toggle.disabled) this.setEnabled(false);
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        this.toggle.setAttribute('aria-pressed', String(enabled));
        this.manager.content.classList.toggle('comparison-active', enabled);
        if (enabled) this.prepareVisiblePages();
        this.updateStatus();
    }

    setPosition(value) {
        this.position = Math.max(0, Math.min(100, value));
        // 드래그 중 GS 호출, ImageData 합성, canvas 복사는 전혀 하지 않는다.
        this.manager.content.style.setProperty('--comparison-position', `${this.position}%`);
        for (const el of this.manager.pageElements.values()) {
            if (el.comparison) this.updateHandle(el.comparison.handle);
        }
    }

    prepareVisiblePages() {
        if (this.toggle.disabled) return;
        for (const [pageNum, el] of this.manager.pageElements) {
            if (el.status === 'rendered' && this.manager.isWrapperInViewport(el.wrapper)) {
                this.prepare(pageNum, el);
            }
        }
    }

    async prepare(pageNum, el) {
        if (this.toggle.disabled || !el.pageData || el.comparisonPending) return;
        if (el.comparison) {
            if (this.enabled) this.refreshAlternate(el);
            this.selectMode(pageNum, el);
            return;
        }
        const token = {};
        const generation = this.viewer.renderGeneration;
        const base = el.pageData;
        const settings = { ...base.renderSettings, overprint: !base.renderSettings.overprint };
        el.comparisonPending = token;
        el.comparisonError = false;
        this.updateStatus();
        try {
            const data = await this.viewer.renderPageData(pageNum, settings);
            if (generation !== this.viewer.renderGeneration || el.pageData !== base ||
                el.comparisonPending !== token || this.manager.pageElements.get(pageNum) !== el) return;
            const canvas = document.createElement('canvas');
            canvas.className = `page-canvas comparison-layer ${settings.overprint ? 'comparison-right' : 'comparison-left'}`;
            canvas.setAttribute('aria-hidden', 'true');
            this.manager.renderToCanvas(canvas, data);
            const divider = document.createElement('div');
            divider.className = 'comparison-divider';
            const handle = document.createElement('button');
            handle.className = 'comparison-handle';
            handle.type = 'button';
            handle.textContent = '↔';
            handle.setAttribute('role', 'slider');
            handle.setAttribute('aria-label', `${pageNum}쪽 녹아웃·오버프린트 비교 경계`);
            handle.setAttribute('aria-valuemin', '0');
            handle.setAttribute('aria-valuemax', '100');
            this.updateHandle(handle);
            const move = event => {
                const rect = el.wrapper.getBoundingClientRect();
                this.setPosition((event.clientX - rect.left) / rect.width * 100);
            };
            handle.addEventListener('pointerdown', event => {
                event.preventDefault();
                event.stopPropagation();
                handle.setPointerCapture(event.pointerId);
                move(event);
            });
            handle.addEventListener('pointermove', event => {
                if (handle.hasPointerCapture(event.pointerId)) move(event);
            });
            handle.addEventListener('pointerup', event => {
                if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
            });
            handle.addEventListener('keydown', event => {
                const values = { ArrowLeft: this.position - 1, ArrowRight: this.position + 1, Home: 0, End: 100 };
                if (event.key in values) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.setPosition(values[event.key]);
                }
            });
            divider.appendChild(handle);
            el.wrapper.append(canvas, divider);
            el.comparison = { canvas, divider, handle, data };
            this.selectMode(pageNum, el);
        } catch (error) {
            if (el.comparisonPending === token) {
                el.comparisonError = true;
                console.error('오버프린트 비교 준비 실패:', error);
            }
        } finally {
            if (el.comparisonPending === token) el.comparisonPending = null;
            this.updateStatus();
        }
    }

    updateHandle(handle) {
        handle.setAttribute('aria-valuenow', String(this.position));
        handle.setAttribute('aria-valuetext', `왼쪽 녹아웃 ${this.position}%, 오른쪽 오버프린트 ${100 - this.position}%`);
    }

    // 완성된 두 캔버스의 역할만 교환한다. 픽셀 합성/복사나 PDF 렌더는 하지 않는다.
    selectMode(pageNum, el) {
        if (!el.comparison || el.pageData.renderSettings.overprint === this.viewer.overprintPreview) return;
        this.refreshAlternate(el);
        const alternate = el.comparison;
        [el.canvas, alternate.canvas] = [alternate.canvas, el.canvas];
        [el.pageData, alternate.data] = [alternate.data, el.pageData];
        el.canvas.className = 'page-canvas';
        el.canvas.removeAttribute('aria-hidden');
        alternate.canvas.className = `page-canvas comparison-layer ${alternate.data.renderSettings.overprint ? 'comparison-right' : 'comparison-left'}`;
        alternate.canvas.setAttribute('aria-hidden', 'true');
        el.wrapper.prepend(el.canvas);
        this.viewer.addToCache(pageNum, el.pageData);
    }

    switchMode() {
        for (const [pageNum, el] of this.manager.pageElements) {
            if (el.status !== 'rendered') continue;
            this.selectMode(pageNum, el);
        }
        // 표시 중인 페이지만 반대 버전을 미리 준비한다. 미완료 작업은 최신 선택을 따른다.
        this.prepareVisiblePages();
        this.updateStatus();
    }

    refreshAlternate(el) {
        if (!el.comparison?.dirty) return;
        this.manager.renderToCanvas(el.comparison.canvas, el.comparison.data);
        el.comparison.dirty = false;
    }

    recompose(el) {
        const alternate = el.comparison;
        if (!alternate) return;
        alternate.dirty = true;
        if (this.enabled) { this.refreshAlternate(el); return; }
        // 먼저 선택한 화면을 보여준다. 숨겨진 화면은 최신 체크 상태로 한 번만 갱신한다.
        if (alternate.scheduled) return;
        alternate.scheduled = true;
        const refresh = () => {
            alternate.scheduled = false;
            if (el.comparison === alternate) this.refreshAlternate(el);
        };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(refresh, {timeout: 1000});
        else setTimeout(refresh, 50);
    }

    dataAtPointer(el, event) {
        if (!this.enabled || !el.comparison) return el.pageData;
        const rect = el.canvas.getBoundingClientRect();
        const overprint = (event.clientX - rect.left) / rect.width * 100 >= this.position;
        return overprint === el.pageData.renderSettings.overprint ? el.pageData : el.comparison.data;
    }

    release(el) {
        el.comparisonPending = null;
        if (el.comparison) {
            el.comparison.canvas.width = 0;
            el.comparison.canvas.height = 0;
            el.comparison.canvas.remove();
            el.comparison.divider.remove();
            el.comparison = null;
        }
    }

    updateStatus() {
        if (this.toggle.disabled) {
            this.status.hidden = true;
            this.status.textContent = '';
            return;
        }
        const visible = [...this.manager.pageElements.values()]
            .filter(el => this.manager.isWrapperInViewport(el.wrapper));
        const pending = visible.some(el => el.status === 'rendered' && !el.comparison);
        const failed = visible.some(el => el.comparisonError);
        this.status.hidden = !pending && !failed;
        this.status.textContent = failed
            ? '준비 실패 · 좌우 비교를 눌러 다시 시도하세요'
            : pending ? '두 화면 준비 중…' : '';
    }
}
