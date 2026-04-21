/**
 * PDFStyleFinder - PDF 텍스트 스타일 분석기
 * pdf.js를 사용하여 텍스트의 폰트, 크기, 색상을 추출하고 매칭
 */
export class PDFStyleFinder {
    constructor(viewer) {
        this.viewer = viewer;
        this.styles = new Map();      // styleKey -> StyleEntry
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
    makeStyleKey(fontName, fontSize) {
        return `${fontName}|${fontSize}`;
    }

    // ── operatorList + commonObjs에서 실제 폰트명 맵 구축 ──
    // 주의: page.render() 완료 후 호출해야 commonObjs가 채워져 있음
    async buildFontNameMap(page) {
        try {
            const ops = await page.getOperatorList();
            const OPS = pdfjsLib.OPS;
            const refToName = new Map();
            for (let i = 0; i < ops.fnArray.length; i++) {
                if (ops.fnArray[i] === OPS.setFont) {
                    const fontRef = ops.argsArray[i][0];
                    if (refToName.has(fontRef)) continue;
                    try {
                        const font = page.commonObjs.get(fontRef);
                        if (font?.name) {
                            refToName.set(fontRef, this.normalizeFontName(font.name));
                        }
                    } catch(e) { /* 개별 폰트 실패 무시 */ }
                }
            }

            const suffixToName = new Map();
            for (const [ref, name] of refToName) {
                const m = ref.match(/f(\d+)$/);
                if (m) suffixToName.set(m[1], name);
            }
            return suffixToName;
        } catch(e) {
            // operatorList 자체 실패 시 빈 맵 반환 (폰트명은 fallback 사용)
            return new Map();
        }
    }

    // ── textContent fontName → 실제 폰트명 해석 ──
    resolveFontFamily(fontKey, styles, fontMap) {
        // fontMap에서 fN 접미사로 매칭
        if (fontMap) {
            const m = fontKey.match(/f(\d+)$/);
            if (m && fontMap.has(m[1])) return fontMap.get(m[1]);
        }
        // fallback: textContent.styles
        if (styles?.[fontKey]) {
            const family = styles[fontKey].fontFamily;
            if (family && family !== 'monospace' && family !== 'sans-serif' && family !== 'serif') {
                return family;
            }
        }
        const cleaned = this.normalizeFontName(fontKey);
        if (/^g_d\d+_f\d+$/.test(cleaned)) return styles?.[fontKey]?.fontFamily || 'sans-serif';
        return cleaned;
    }

    // ── 인접 item 병합: 같은 스타일의 쪼개진 텍스트를 합침 ──
    mergeAdjacentSpans(rawSpans) {
        if (rawSpans.length === 0) return rawSpans;

        const merged = [rawSpans[0]];
        for (let i = 1; i < rawSpans.length; i++) {
            const prev = merged[merged.length - 1];
            const curr = rawSpans[i];

            // 같은 페이지, 같은 스타일, Y좌표 비슷하고, X좌표가 이어지는 경우 병합
            const sameStyle = prev.fontName === curr.fontName &&
                              prev.fontSize === curr.fontSize;
            const sameLine = Math.abs(prev.bbox.y - curr.bbox.y) < prev.fontSize * 0.5;
            const adjacent = (curr.bbox.x - (prev.bbox.x + prev.bbox.width)) < prev.fontSize * 1.5;

            if (sameStyle && sameLine && adjacent) {
                prev.text += curr.text;
                prev.bbox.width = (curr.bbox.x + curr.bbox.width) - prev.bbox.x;
            } else {
                merged.push(curr);
            }
        }
        return merged;
    }

    // ── 페이지 분석: 텍스트 + 폰트/크기 추출 ──
    async extractPageStyleData(pdf, pageNum) {
        const page = await pdf.getPage(pageNum);

        // 극소 해상도로 render해서 commonObjs에 폰트 데이터 채우기
        const viewport = page.getViewport({ scale: 0.1 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        canvas.width = canvas.height = 0; // 즉시 해제

        const [textContent, fontMap] = await Promise.all([
            page.getTextContent(),
            this.buildFontNameMap(page)
        ]);

        const spans = [];
        const items = textContent.items;
        const styles = textContent.styles;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item.str || item.str.trim() === '') continue;

            const fontName = this.resolveFontFamily(item.fontName, styles, fontMap);
            const fontSize = Math.round(Math.abs(item.transform[3] || item.transform[0]) * 100) / 100;
            const styleKey = `${fontName}|${fontSize}`;

            spans.push({
                pageNum,
                text: item.str,
                fontName,
                fontSize,
                styleKey,
                bbox: {
                    x: item.transform[4],
                    y: item.transform[5],
                    width: item.width || 0,
                    height: item.height || fontSize
                }
            });
        }

        const merged = this.mergeAdjacentSpans(spans);
        page.cleanup();
        return merged;
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

        this.renderProgress(0, '분석 준비 중...');

        try {
            const pdf = await pdfjsLib.getDocument({ data: this.viewer.currentPDFData.slice(0) }).promise;
            const total = pdf.numPages;
            const BATCH = 4; // 동시 처리 페이지 수

            for (let start = 1; start <= total; start += BATCH) {
                if (this.aborted) {
                    this.renderMessage('분석이 취소되었습니다.');
                    this.isAnalyzing = false;
                    return;
                }

                const end = Math.min(start + BATCH - 1, total);
                this.renderProgress(end / total, `${end} / ${total} 페이지 분석 중...`);

                // 배치 병렬 처리 (개별 페이지 실패 시 빈 결과로 대체)
                const batch = [];
                for (let p = start; p <= end; p++) {
                    batch.push(
                        this.extractPageStyleData(pdf, p)
                            .then(spans => ({ p, spans }))
                            .catch(() => ({ p, spans: [] }))
                    );
                }
                const results = await Promise.all(batch);

                for (const { p, spans } of results) {
                    for (const span of spans) {
                        if (!this.styles.has(span.styleKey)) {
                            this.styles.set(span.styleKey, {
                                styleKey: span.styleKey,
                                fontName: span.fontName,
                                fontSize: span.fontSize,
                                count: 0,
                                spans: []
                            });
                        }
                        const entry = this.styles.get(span.styleKey);
                        entry.count++;
                        entry.spans.push(span);
                    }
                }

                // UI 업데이트 기회
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

    // ── UI: 헤더 + 탭 생성 ──
    _renderHeader(activeTab = 'styles') {
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
                <button class="sf-tab ${activeTab === 'numbering' ? 'active' : ''}" data-tab="numbering">번호 검증</button>
            </div>
        `;
    }

    _bindHeaderEvents() {
        this.modalContent.querySelector('.sf-close-btn').addEventListener('click', () => this.closeModal());
        this.modalContent.querySelectorAll('.sf-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const t = tab.dataset.tab;
                if (t === 'styles') this.renderStyleList();
                else if (t === 'numbering') this.renderNumberingCheck();
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

        let html = this._renderHeader();
        html += '<div class="sf-body sf-style-list">';

        if (sorted.length === 0) {
            html += '<p style="text-align: center; color: #7f8c8d; padding: 20px;">텍스트 스타일이 발견되지 않았습니다.</p>';
        } else {
            html += `<p class="sf-summary">${sorted.length}개 스타일, 총 ${[...this.styles.values()].reduce((s, e) => s + e.count, 0)}개 텍스트 span</p>`;
            for (const entry of sorted) {
                // 대표 텍스트 미리보기 (처음 3개 span)
                const previews = entry.spans.slice(0, 3)
                    .map(s => s.text.length > 30 ? s.text.substring(0, 30) + '…' : s.text);
                const previewText = previews.map(p => `"${this._esc(p)}"`).join(', ');
                const moreCount = entry.count > 3 ? ` 외 ${entry.count - 3}개` : '';
                html += `
                    <div class="sf-style-item" data-key="${this._escAttr(entry.styleKey)}">
                        <span class="sf-color-swatch">Aa</span>
                        <div class="sf-style-info">
                            <div class="sf-style-meta">
                                <span class="sf-font-name">${this._esc(entry.fontName)}</span>
                                <span class="sf-font-size">${entry.fontSize}pt</span>
                                <span class="sf-style-count">${entry.count}</span>
                            </div>
                            <div class="sf-style-preview">${previewText}${moreCount}</div>
                        </div>
                    </div>
                `;
            }
        }

        html += '</div>';
        this.modalContent.innerHTML = html;
        this._bindHeaderEvents();

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

        let html = this._renderHeader();

        html += `<div class="sf-body">`;
        html += `<div class="sf-match-header">
            <button class="sf-back-btn">← 목록으로</button>
            <div class="sf-match-info">
                <span class="sf-color-swatch">Aa</span>
                <strong>${this._esc(entry.fontName)}</strong> ${entry.fontSize}pt
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
        this._bindHeaderEvents();

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

    // ── 번호 검증: 텍스트에서 구조적 번호 패턴만 감지 ──
    _extractNumberSequences() {
        const results = [];

        // 번호 패턴 정의: 텍스트 시작부에 번호가 있는 구조적 패턴만
        const numPatterns = [
            { name: 'prefix_dot',   re: /^(\d+)\.\s/,                    extract: m => parseInt(m[1]) },  // "1. 제목"
            { name: 'prefix_paren', re: /^(\d+)\)\s/,                    extract: m => parseInt(m[1]) },  // "1) 제목"
            { name: 'prefix_space', re: /^(\d{2,})\s+[가-힣a-zA-Z]/,    extract: m => parseInt(m[1]) },  // "01 제목" (2자리 이상)
            { name: 'chapter_kr',   re: /^[제]?\s*(\d+)\s*[장절편화회부]/,  extract: m => parseInt(m[1]) },  // "제1장" "1장"
            { name: 'step',         re: /^(?:Step|STEP|step)\s*(\d+)/i,  extract: m => parseInt(m[1]) },  // "Step 1"
            { name: 'part',         re: /^(?:Part|PART|part)\s*(\d+)/i,  extract: m => parseInt(m[1]) },  // "PART 1"
            { name: 'sub_number',   re: /^(\d+)-(\d+)[\s.]/,            extract: m => parseFloat(`${m[1]}.${m[2]}`) }, // "1-1 제목"
        ];

        for (const entry of this.styles.values()) {
            if (entry.spans.length < 3) continue;

            // 페이지 순 정렬
            const sorted = [...entry.spans].sort((a, b) => {
                if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;
                return b.bbox.y - a.bbox.y;
            });

            for (const pat of numPatterns) {
                const matches = [];
                for (const span of sorted) {
                    const text = span.text.trim();
                    const m = text.match(pat.re);
                    if (m) {
                        matches.push({ span, num: pat.extract(m), matchText: m[0] });
                    }
                }

                // 최소 3개, 매칭률 80% 이상
                if (matches.length < 3 || matches.length / entry.spans.length < 0.8) continue;

                // 첫 번호가 0 또는 1로 시작하는지 확인
                const firstNum = matches[0].num;
                if (firstNum !== 0 && firstNum !== 1) continue;

                // 연속 증가 비율 확인: +1 증가가 전체의 70% 이상
                let seqCount = 0;
                for (let i = 1; i < matches.length; i++) {
                    if (matches[i].num - matches[i - 1].num === 1) seqCount++;
                }
                if (seqCount / (matches.length - 1) < 0.7) continue;

                // 유효한 시퀀스 — 문제 감지
                const issues = [];
                for (let i = 1; i < matches.length; i++) {
                    const curr = matches[i];
                    const prev = matches[i - 1];
                    const diff = curr.num - prev.num;

                    if (diff === 0) {
                        issues.push({
                            type: 'duplicate', index: i,
                            message: `중복: ${curr.num}`,
                            span: curr.span
                        });
                    } else if (diff > 1 && Number.isInteger(curr.num) && Number.isInteger(prev.num)) {
                        const missing = [];
                        for (let n = prev.num + 1; n < curr.num && missing.length < 10; n++) missing.push(n);
                        const suffix = (curr.num - prev.num - 1) > 10 ? ` 외 ${curr.num - prev.num - 1 - 10}개` : '';
                        issues.push({
                            type: 'gap', index: i,
                            message: `누락: ${missing.join(', ')}${suffix}`,
                            span: curr.span
                        });
                    } else if (diff < 0) {
                        issues.push({
                            type: 'order', index: i,
                            message: `순서 오류: ${prev.num} → ${curr.num}`,
                            span: curr.span
                        });
                    }
                }

                results.push({
                    entry, sorted: matches, issues,
                    patternName: pat.name
                });
                break; // 한 스타일에 하나의 패턴만
            }
        }

        // 이슈 있는 것 먼저
        results.sort((a, b) => b.issues.length - a.issues.length);
        return results;
    }

    // ── UI: 번호 검증 탭 ──
    renderNumberingCheck() {
        const sequences = this._extractNumberSequences();

        let html = this._renderHeader('numbering');
        html += '<div class="sf-body">';

        if (sequences.length === 0) {
            html += '<p style="text-align:center; color:#7f8c8d; padding:40px 20px;">번호 패턴이 감지된 스타일이 없습니다.</p>';
        } else {
            const totalIssues = sequences.reduce((s, seq) => s + seq.issues.length, 0);
            if (totalIssues > 0) {
                html += `<div class="sf-issue-banner sf-issue-error">${totalIssues}개 문제 발견</div>`;
            } else {
                html += `<div class="sf-issue-banner sf-issue-ok">모든 번호 순서 정상</div>`;
            }

            for (const seq of sequences) {
                const { entry, sorted, issues } = seq;
                const hasIssues = issues.length > 0;
                const issueIndices = new Set(issues.map(iss => iss.index));

                html += `<div class="sf-num-section ${hasIssues ? 'sf-has-issues' : ''}">`;
                html += `<div class="sf-num-header">
                    <span class="sf-color-swatch">Aa</span>
                    <strong>${this._esc(entry.fontName)}</strong> ${entry.fontSize}pt
                    <span class="sf-style-count">${sorted.length}개</span>
                    ${hasIssues ? `<span class="sf-issue-badge">${issues.length}개 문제</span>` : '<span class="sf-ok-badge">OK</span>'}
                </div>`;

                // 이슈 요약
                if (hasIssues) {
                    html += '<div class="sf-issue-list">';
                    for (const iss of issues) {
                        const icon = iss.type === 'duplicate' ? '⊜' : iss.type === 'gap' ? '⊘' : '⇅';
                        html += `<div class="sf-issue-item sf-issue-${iss.type}" data-page="${iss.span.pageNum}">
                            <span class="sf-issue-icon">${icon}</span>
                            <span class="sf-issue-msg">${this._esc(iss.message)}</span>
                            <span class="sf-issue-page">p.${iss.span.pageNum}</span>
                        </div>`;
                    }
                    html += '</div>';
                }

                // 번호 시퀀스 미리보기 (접이식)
                html += `<details class="sf-num-details">
                    <summary>전체 시퀀스 보기 (${sorted.length}개)</summary>
                    <div class="sf-num-sequence">`;
                for (let i = 0; i < sorted.length; i++) {
                    const item = sorted[i];
                    const isIssue = issueIndices.has(i);
                    const truncated = item.span.text.length > 50 ? item.span.text.substring(0, 50) + '…' : item.span.text;
                    html += `<div class="sf-num-item ${isIssue ? 'sf-num-error' : ''}" data-page="${item.span.pageNum}">
                        <span class="sf-num-value">${item.num}</span>
                        <span class="sf-num-text">${this._esc(truncated)}</span>
                        <span class="sf-num-page">p.${item.span.pageNum}</span>
                    </div>`;
                }
                html += '</div></details>';
                html += '</div>';
            }
        }

        html += '</div>';
        this.modalContent.innerHTML = html;
        this._bindHeaderEvents();

        // 클릭 시 페이지 이동
        this.modalContent.querySelectorAll('[data-page]').forEach(el => {
            el.style.cursor = 'pointer';
            el.addEventListener('click', () => {
                const pageNum = parseInt(el.dataset.page);
                if (this.viewer.scrollManager) {
                    this.viewer.scrollManager.scrollToPage(pageNum);
                }
            });
        });
    }

    // ── 내보내기 ──
    exportToClipboard() {
        if (!this.isAnalyzed) return;

        const sorted = [...this.styles.values()].sort((a, b) => b.count - a.count);
        let text = '폰트\t크기\t횟수\n';
        for (const entry of sorted) {
            text += `${entry.fontName}\t${entry.fontSize}\t${entry.count}\n`;
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
}
