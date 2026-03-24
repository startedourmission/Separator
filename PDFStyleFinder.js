/**
 * PDFStyleFinder - PDF 텍스트 스타일 분석기
 * pdf.js를 사용하여 텍스트의 폰트, 크기, 색상을 추출하고 매칭
 */
export class PDFStyleFinder {
    constructor(viewer) {
        this.viewer = viewer;
        this.styles = new Map();      // styleKey -> StyleEntry
        this.pageSpans = new Map();   // pageNum -> SpanRecord[]
        this.isAnalyzed = false;
        this.isAnalyzing = false;
        this.aborted = false;

        this.modal = document.getElementById('style-finder-modal');
        this.modalContent = this.modal.querySelector('.style-finder-modal-content');
        this.openBtn = document.getElementById('btn-style-finder');

        this.openBtn.addEventListener('click', () => this.openModal());
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.closeModal();
        });
    }

    reset() {
        this.styles.clear();
        this.pageSpans.clear();
        this.isAnalyzed = false;
        this.isAnalyzing = false;
        this.aborted = false;
    }

    // ── 폰트명 정규화 ──
    normalizeFontName(name) {
        if (!name) return 'Unknown';
        // ABCDEF+ 서브셋 접두사 제거
        return name.replace(/^[A-Z]{6}\+/, '');
    }

    // ── 스타일 키 생성 ──
    makeStyleKey(fontName, fontSize, color) {
        const r = color.r, g = color.g, b = color.b;
        return `${fontName}|${fontSize}|${r},${g},${b}`;
    }

    // ── 색상을 hex로 변환 ──
    colorToHex(color) {
        const toHex = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
        return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
    }

    // ── 페이지 분석: 텍스트 + 색상 추출 ──
    async extractPageStyleData(pdf, pageNum) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const ops = await page.getOperatorList();

        // Phase 1: operator list에서 색상 상태 추적
        const OPS = pdfjsLib.OPS;
        const textOps = [];
        let currentColor = { r: 0, g: 0, b: 0 };
        let currentFont = '';
        let currentFontSize = 0;
        const stateStack = [];

        for (let i = 0; i < ops.fnArray.length; i++) {
            const fn = ops.fnArray[i];
            const args = ops.argsArray[i];

            switch (fn) {
                case OPS.save:
                    stateStack.push({
                        color: { ...currentColor },
                        font: currentFont,
                        fontSize: currentFontSize
                    });
                    break;
                case OPS.restore:
                    if (stateStack.length > 0) {
                        const s = stateStack.pop();
                        currentColor = s.color;
                        currentFont = s.font;
                        currentFontSize = s.fontSize;
                    }
                    break;
                case OPS.setFillRGBColor:
                    currentColor = {
                        r: Math.round(args[0] * 255),
                        g: Math.round(args[1] * 255),
                        b: Math.round(args[2] * 255)
                    };
                    break;
                case OPS.setFillGrayColor:
                    const gray = Math.round(args[0] * 255);
                    currentColor = { r: gray, g: gray, b: gray };
                    break;
                case OPS.setFillCMYKColor:
                    if (args.length >= 4) {
                        const [c, m, y, k] = args;
                        currentColor = {
                            r: Math.round(255 * (1 - c) * (1 - k)),
                            g: Math.round(255 * (1 - m) * (1 - k)),
                            b: Math.round(255 * (1 - y) * (1 - k))
                        };
                    }
                    break;
                case OPS.setFont:
                    if (args[0]) currentFont = args[0];
                    if (args[1]) currentFontSize = args[1];
                    break;
                case OPS.showText:
                case OPS.showSpacedText:
                    textOps.push({
                        color: { ...currentColor },
                        font: currentFont,
                        fontSize: currentFontSize
                    });
                    break;
            }
        }

        // Phase 2: textContent items와 매칭
        const spans = [];
        const items = textContent.items;
        let textOpIdx = 0;
        const useFallback = textOps.length !== items.length;

        // 폰트 이름 resolve 캐시
        const fontNameCache = new Map();

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item.str || item.str.trim() === '') {
                if (!useFallback) textOpIdx++;
                continue;
            }

            // 색상: 매칭 또는 폴백
            let color;
            if (!useFallback && textOpIdx < textOps.length) {
                color = textOps[textOpIdx].color;
                textOpIdx++;
            } else if (useFallback && textOps.length > 0) {
                // 폴백: 비율 기반 인덱스
                const ratio = items.length > 1 ? i / (items.length - 1) : 0;
                const idx = Math.min(Math.round(ratio * (textOps.length - 1)), textOps.length - 1);
                color = textOps[idx].color;
            } else {
                color = { r: 0, g: 0, b: 0 };
            }

            // 폰트명 resolve
            let fontName = item.fontName || 'Unknown';
            if (!fontNameCache.has(fontName)) {
                const resolved = this.normalizeFontName(fontName);
                fontNameCache.set(fontName, resolved);
            }
            fontName = fontNameCache.get(fontName);

            // 크기: transform[0] 또는 transform[3]
            const fontSize = Math.round(Math.abs(item.transform[3] || item.transform[0]) * 10) / 10;

            const styleKey = this.makeStyleKey(fontName, fontSize, color);

            spans.push({
                pageNum,
                text: item.str,
                fontName,
                fontSize,
                color,
                styleKey,
                bbox: {
                    x: item.transform[4],
                    y: item.transform[5],
                    width: item.width || 0,
                    height: item.height || fontSize
                }
            });
        }

        page.cleanup();
        return spans;
    }

    // ── 전체 문서 분석 ──
    async analyzeDocument() {
        if (!this.viewer.currentPDFData) {
            this.renderMessage('먼저 PDF 파일을 열어주세요.');
            return;
        }

        this.isAnalyzing = true;
        this.aborted = false;
        this.styles.clear();
        this.pageSpans.clear();

        this.renderProgress(0, '분석 준비 중...');

        try {
            const pdf = await pdfjsLib.getDocument({ data: this.viewer.currentPDFData.slice(0) }).promise;
            const total = pdf.numPages;

            for (let p = 1; p <= total; p++) {
                if (this.aborted) {
                    this.renderMessage('분석이 취소되었습니다.');
                    this.isAnalyzing = false;
                    return;
                }

                this.renderProgress(p / total, `${p} / ${total} 페이지 분석 중...`);
                const spans = await this.extractPageStyleData(pdf, p);
                this.pageSpans.set(p, spans);

                // 스타일 집계
                for (const span of spans) {
                    if (!this.styles.has(span.styleKey)) {
                        this.styles.set(span.styleKey, {
                            styleKey: span.styleKey,
                            fontName: span.fontName,
                            fontSize: span.fontSize,
                            color: span.color,
                            count: 0,
                            spans: []
                        });
                    }
                    const entry = this.styles.get(span.styleKey);
                    entry.count++;
                    entry.spans.push(span);
                }

                // UI 블로킹 방지
                await new Promise(r => setTimeout(r, 0));
            }

            pdf.destroy();
            this.isAnalyzed = true;
            this.isAnalyzing = false;
            this.renderStyleList();
        } catch (err) {
            console.error('스타일 분석 오류:', err);
            this.isAnalyzing = false;
            this.renderMessage('분석 중 오류가 발생했습니다: ' + err.message);
        }
    }

    // ── UI: 모달 열기/닫기 ──
    openModal() {
        this.modal.classList.remove('hidden');
        if (this.isAnalyzed) {
            this.renderStyleList();
        } else if (this.isAnalyzing) {
            // 분석 진행 중이면 그대로 둠
        } else {
            this.renderStartScreen();
        }
    }

    closeModal() {
        this.modal.classList.add('hidden');
    }

    // ── UI: 시작 화면 ──
    renderStartScreen() {
        this.modalContent.innerHTML = `
            <div class="sf-header">
                <h3>텍스트 스타일 분석</h3>
                <button class="sf-close-btn" title="닫기">✕</button>
            </div>
            <div class="sf-body" style="text-align: center; padding: 40px 20px;">
                <p style="color: #7f8c8d; margin-bottom: 20px;">PDF에서 사용된 텍스트 스타일(폰트, 크기, 색상)을 분석합니다.</p>
                <button class="sf-analyze-btn">분석 시작</button>
            </div>
        `;
        this.modalContent.querySelector('.sf-close-btn').addEventListener('click', () => this.closeModal());
        this.modalContent.querySelector('.sf-analyze-btn').addEventListener('click', () => this.analyzeDocument());
    }

    // ── UI: 진행률 ──
    renderProgress(ratio, text) {
        const pct = Math.round(ratio * 100);
        const existing = this.modalContent.querySelector('.sf-progress-bar-fill');
        if (existing) {
            existing.style.width = pct + '%';
            this.modalContent.querySelector('.sf-progress-text').textContent = text;
            return;
        }

        this.modalContent.innerHTML = `
            <div class="sf-header">
                <h3>텍스트 스타일 분석</h3>
                <button class="sf-close-btn" title="닫기">✕</button>
            </div>
            <div class="sf-body" style="padding: 40px 20px;">
                <div class="sf-progress-bar"><div class="sf-progress-bar-fill" style="width: ${pct}%"></div></div>
                <p class="sf-progress-text" style="text-align: center; margin-top: 12px; color: #555;">${text}</p>
                <div style="text-align: center; margin-top: 16px;">
                    <button class="sf-cancel-btn">취소</button>
                </div>
            </div>
        `;
        this.modalContent.querySelector('.sf-close-btn').addEventListener('click', () => this.closeModal());
        this.modalContent.querySelector('.sf-cancel-btn').addEventListener('click', () => { this.aborted = true; });
    }

    // ── UI: 메시지 표시 ──
    renderMessage(msg) {
        this.modalContent.innerHTML = `
            <div class="sf-header">
                <h3>텍스트 스타일 분석</h3>
                <button class="sf-close-btn" title="닫기">✕</button>
            </div>
            <div class="sf-body" style="text-align: center; padding: 40px 20px; color: #7f8c8d;">${msg}</div>
        `;
        this.modalContent.querySelector('.sf-close-btn').addEventListener('click', () => this.closeModal());
    }

    // ── UI: 탭 헤더 생성 ──
    _renderTabs(activeTab) {
        return `
            <div class="sf-header">
                <h3>텍스트 스타일 분석</h3>
                <div class="sf-header-actions">
                    <button class="sf-export-btn" title="내보내기">내보내기</button>
                    <button class="sf-close-btn" title="닫기">✕</button>
                </div>
            </div>
            <div class="sf-tabs">
                <button class="sf-tab ${activeTab === 'styles' ? 'active' : ''}" data-tab="styles">스타일 목록</button>
                <button class="sf-tab ${activeTab === 'pages' ? 'active' : ''}" data-tab="pages">페이지별 보기</button>
            </div>
        `;
    }

    _bindTabEvents() {
        this.modalContent.querySelector('.sf-close-btn').addEventListener('click', () => this.closeModal());
        this.modalContent.querySelectorAll('.sf-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const t = tab.dataset.tab;
                if (t === 'styles') this.renderStyleList();
                else if (t === 'pages') this.renderPageDump(1);
            });
        });
        const exportBtn = this.modalContent.querySelector('.sf-export-btn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportToClipboard());
        }
    }

    // ── UI: 스타일 목록 ──
    renderStyleList() {
        const sorted = [...this.styles.values()].sort((a, b) => b.count - a.count);

        let html = this._renderTabs('styles');
        html += '<div class="sf-body sf-style-list">';

        if (sorted.length === 0) {
            html += '<p style="text-align: center; color: #7f8c8d; padding: 20px;">텍스트 스타일이 발견되지 않았습니다.</p>';
        } else {
            html += `<p class="sf-summary">${sorted.length}개 스타일, 총 ${[...this.styles.values()].reduce((s, e) => s + e.count, 0)}개 텍스트 span</p>`;
            for (const entry of sorted) {
                const hex = this.colorToHex(entry.color);
                const textColor = this._contrastColor(entry.color);
                html += `
                    <div class="sf-style-item" data-key="${this._escAttr(entry.styleKey)}">
                        <span class="sf-color-swatch" style="background:${hex}; color:${textColor};">Aa</span>
                        <span class="sf-style-info">
                            <span class="sf-font-name">${this._esc(entry.fontName)}</span>
                            <span class="sf-font-size">${entry.fontSize}pt</span>
                            <span class="sf-font-color">${hex}</span>
                        </span>
                        <span class="sf-style-count">${entry.count}</span>
                    </div>
                `;
            }
        }

        html += '</div>';
        this.modalContent.innerHTML = html;
        this._bindTabEvents();

        // 스타일 항목 클릭 이벤트
        this.modalContent.querySelectorAll('.sf-style-item').forEach(el => {
            el.addEventListener('click', () => {
                const key = el.dataset.key;
                this.renderSpanMatches(key);
            });
        });
    }

    // ── UI: 스타일 매칭 결과 ──
    renderSpanMatches(styleKey) {
        const entry = this.styles.get(styleKey);
        if (!entry) return;

        const hex = this.colorToHex(entry.color);
        let html = this._renderTabs('styles');

        html += `<div class="sf-body">`;
        html += `<div class="sf-match-header">
            <button class="sf-back-btn">← 목록으로</button>
            <div class="sf-match-info">
                <span class="sf-color-swatch" style="background:${hex}; color:${this._contrastColor(entry.color)};">Aa</span>
                <strong>${this._esc(entry.fontName)}</strong> ${entry.fontSize}pt ${hex}
                <span class="sf-style-count">${entry.count}</span>
            </div>
        </div>`;

        html += '<div class="sf-match-list">';
        const MAX_SHOW = 200;
        const spans = entry.spans;
        const showCount = Math.min(spans.length, MAX_SHOW);

        for (let i = 0; i < showCount; i++) {
            const span = spans[i];
            const truncated = span.text.length > 80 ? span.text.substring(0, 80) + '...' : span.text;
            html += `
                <div class="sf-span-item" data-page="${span.pageNum}">
                    <span class="sf-span-page">p.${span.pageNum}</span>
                    <span class="sf-span-text">${this._esc(truncated)}</span>
                </div>
            `;
        }

        if (spans.length > MAX_SHOW) {
            html += `<p class="sf-more-text">외 ${spans.length - MAX_SHOW}개 더...</p>`;
        }

        html += '</div></div>';
        this.modalContent.innerHTML = html;
        this._bindTabEvents();

        this.modalContent.querySelector('.sf-back-btn').addEventListener('click', () => this.renderStyleList());

        // span 클릭 시 페이지 이동
        this.modalContent.querySelectorAll('.sf-span-item').forEach(el => {
            el.addEventListener('click', () => {
                const pageNum = parseInt(el.dataset.page);
                if (this.viewer.scrollManager) {
                    this.viewer.scrollManager.scrollToPage(pageNum);
                }
            });
        });
    }

    // ── UI: 페이지별 보기 ──
    renderPageDump(pageNum) {
        const totalPages = this.viewer.totalPages || this.pageSpans.size;
        pageNum = Math.max(1, Math.min(pageNum, totalPages));

        let html = this._renderTabs('pages');
        html += `<div class="sf-body">`;
        html += `<div class="sf-page-nav">
            <button class="sf-page-prev" ${pageNum <= 1 ? 'disabled' : ''}>◀</button>
            <span>페이지 <input type="number" class="sf-page-input" value="${pageNum}" min="1" max="${totalPages}"> / ${totalPages}</span>
            <button class="sf-page-next" ${pageNum >= totalPages ? 'disabled' : ''}>▶</button>
        </div>`;

        const spans = this.pageSpans.get(pageNum) || [];

        if (spans.length === 0) {
            html += '<p style="text-align:center; color:#7f8c8d; padding:20px;">이 페이지에 텍스트가 없습니다.</p>';
        } else {
            html += `<p class="sf-summary">${spans.length}개 텍스트 span</p>`;
            html += '<div class="sf-dump-table"><table><thead><tr><th>텍스트</th><th>폰트</th><th>크기</th><th>색상</th></tr></thead><tbody>';
            for (const span of spans) {
                const hex = this.colorToHex(span.color);
                const truncated = span.text.length > 60 ? span.text.substring(0, 60) + '...' : span.text;
                html += `<tr>
                    <td class="sf-cell-text">${this._esc(truncated)}</td>
                    <td>${this._esc(span.fontName)}</td>
                    <td>${span.fontSize}</td>
                    <td><span class="sf-color-dot" style="background:${hex};"></span>${hex}</td>
                </tr>`;
            }
            html += '</tbody></table></div>';
        }

        html += '</div>';
        this.modalContent.innerHTML = html;
        this._bindTabEvents();

        // 페이지 네비게이션
        this.modalContent.querySelector('.sf-page-prev')?.addEventListener('click', () => this.renderPageDump(pageNum - 1));
        this.modalContent.querySelector('.sf-page-next')?.addEventListener('click', () => this.renderPageDump(pageNum + 1));
        const input = this.modalContent.querySelector('.sf-page-input');
        input?.addEventListener('change', () => {
            const val = parseInt(input.value);
            if (val >= 1 && val <= totalPages) this.renderPageDump(val);
        });
    }

    // ── 내보내기 ──
    exportToClipboard() {
        if (!this.isAnalyzed) return;

        const sorted = [...this.styles.values()].sort((a, b) => b.count - a.count);
        let text = '폰트\t크기\t색상\t횟수\n';
        for (const entry of sorted) {
            text += `${entry.fontName}\t${entry.fontSize}\t${this.colorToHex(entry.color)}\t${entry.count}\n`;
        }

        navigator.clipboard.writeText(text).then(() => {
            const btn = this.modalContent.querySelector('.sf-export-btn');
            if (btn) {
                const orig = btn.textContent;
                btn.textContent = '복사 완료!';
                setTimeout(() => { btn.textContent = orig; }, 1500);
            }
        }).catch(() => {
            // 클립보드 실패 시 다운로드
            const blob = new Blob([text], { type: 'text/tab-separated-values' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'text_styles.tsv';
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    // ── 유틸: HTML 이스케이프 ──
    _esc(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    _escAttr(str) {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    _contrastColor(color) {
        const lum = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255;
        return lum > 0.5 ? '#000' : '#fff';
    }
}
