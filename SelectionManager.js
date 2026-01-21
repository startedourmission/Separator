// Selection Manager - Drag-to-Select Logic
export class SelectionManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.isActive = false;
        this.isSelecting = false;
        this.startX = 0;
        this.startY = 0;
        this.selectionBox = null;
        this.overlay = null;
        this.toggleBtn = document.getElementById('toggle-selection-mode');
        this.statusEl = document.getElementById('selection-status');
        this.resultPanel = document.getElementById('analysis-result-panel');
        this.resultContent = document.getElementById('analysis-content');

        this.init();
    }

    init() {
        // Create selection box element
        this.selectionBox = document.createElement('div');
        this.selectionBox.className = 'selection-box';
        document.body.appendChild(this.selectionBox);

        // Toggle Button Event
        if (this.toggleBtn) {
            this.toggleBtn.addEventListener('click', () => this.toggleMode());
        }

        // Mouse Events on viewport
        const viewport = document.getElementById('scroll-viewport');
        viewport.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        window.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        window.addEventListener('mouseup', (e) => this.handleMouseUp(e));
    }

    toggleMode() {
        this.isActive = !this.isActive;
        if (this.isActive) {
            this.toggleBtn.classList.add('active');
            this.statusEl.textContent = '분석할 영역을 드래그하세요';
            this.viewer.scrollManager.viewport.style.cursor = 'crosshair';
            this.resultPanel.style.display = 'block';
        } else {
            this.toggleBtn.classList.remove('active');
            this.statusEl.textContent = '드래그하여 텍스트나 QR코드를 스캔하세요';
            this.viewer.scrollManager.viewport.style.cursor = 'default';
            this.selectionBox.style.display = 'none';
        }
    }

    handleMouseDown(e) {
        if (!this.isActive) return;
        // Only start selection if clicking on a page canvas or wrapper
        if (!e.target.closest('.page-wrapper')) return;

        this.isSelecting = true;
        this.startX = e.clientX;
        this.startY = e.clientY;

        this.selectionBox.style.left = `${this.startX}px`;
        this.selectionBox.style.top = `${this.startY}px`;
        this.selectionBox.style.width = '0px';
        this.selectionBox.style.height = '0px';
        this.selectionBox.style.display = 'block';

        e.preventDefault(); // Prevent text selection or scrolling
    }

    handleMouseMove(e) {
        if (!this.isSelecting) return;

        const currentX = e.clientX;
        const currentY = e.clientY;

        const width = Math.abs(currentX - this.startX);
        const height = Math.abs(currentY - this.startY);
        const left = Math.min(currentX, this.startX);
        const top = Math.min(currentY, this.startY);

        this.selectionBox.style.width = `${width}px`;
        this.selectionBox.style.height = `${height}px`;
        this.selectionBox.style.left = `${left}px`;
        this.selectionBox.style.top = `${top}px`;
    }

    async handleMouseUp(e) {
        if (!this.isSelecting) return;
        this.isSelecting = false;
        this.selectionBox.style.display = 'none';

        if (!this.isActive) return;

        // Calculate selection bounds
        const rect = {
            x: parseInt(this.selectionBox.style.left),
            y: parseInt(this.selectionBox.style.top),
            width: parseInt(this.selectionBox.style.width),
            height: parseInt(this.selectionBox.style.height)
        };

        if (rect.width < 10 || rect.height < 10) return; // Ignore small clicks

        this.analyzeSelection(rect);
    }

    async analyzeSelection(rect) {
        console.log('analyzeSelection called', rect);
        this.statusEl.textContent = '분석 중...';
        this.resultContent.innerHTML = '<div class="spinner" style="width: 20px; height: 20px; border-width: 2px;"></div>';

        try {
            // 1. Identify which page is under the selection
            const centerX = rect.x + rect.width / 2;
            const centerY = rect.y + rect.height / 2;

            this.selectionBox.style.display = 'none';
            const targetEl = document.elementFromPoint(centerX, centerY);

            const canvas = targetEl.closest('canvas');
            if (!canvas) {
                throw new Error('선택한 영역에 페이지가 없습니다.');
            }

            // 2. Capture Image Data from Canvas
            const canvasRect = canvas.getBoundingClientRect();

            const intersectX = Math.max(rect.x, canvasRect.left);
            const intersectY = Math.max(rect.y, canvasRect.top);
            const intersectRight = Math.min(rect.x + rect.width, canvasRect.right);
            const intersectBottom = Math.min(rect.y + rect.height, canvasRect.bottom);

            const captureWidth = intersectRight - intersectX;
            const captureHeight = intersectBottom - intersectY;

            if (captureWidth <= 0 || captureHeight <= 0) {
                throw new Error('유효한 페이지 영역이 아닙니다.');
            }

            // Canvas coordinate mapping
            const scaleX = canvas.width / canvasRect.width;
            const scaleY = canvas.height / canvasRect.height;

            const sx = (intersectX - canvasRect.left) * scaleX;
            const sy = (intersectY - canvasRect.top) * scaleY;
            const sWidth = captureWidth * scaleX;
            const sHeight = captureHeight * scaleY;

            // Extract image data
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = sWidth; // High Res
            tempCanvas.height = sHeight;

            const ctx = tempCanvas.getContext('2d');
            ctx.drawImage(canvas, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);

            // DEBUG: Display captured image
            const debugContainer = document.createElement('div');
            debugContainer.style.marginBottom = '15px';
            debugContainer.style.borderBottom = '1px solid #eee';
            debugContainer.style.paddingBottom = '10px';

            const debugTitle = document.createElement('div');
            debugTitle.textContent = '캡처된 이미지 (디버깅용):';
            debugTitle.style.fontSize = '0.7em';
            debugTitle.style.color = '#999';
            debugContainer.appendChild(debugTitle);

            try {
                const debugImg = document.createElement('img');
                debugImg.src = tempCanvas.toDataURL();
                debugImg.style.maxWidth = '100%';
                debugImg.style.border = '1px solid #ddd';
                debugImg.style.display = 'block';
                debugContainer.appendChild(debugImg);
            } catch (e) {
                // Ignore
            }

            this.resultContent.innerHTML = '';
            this.resultContent.appendChild(debugContainer);

            // 3. Scan Code (ZXing)
            const resultList = document.createElement('div');
            let foundCode = false;

            try {
                const codeResult = await this.scanCode(tempCanvas, ctx, sWidth, sHeight);
                if (codeResult) {
                    foundCode = true;
                    const link = this.createHyperlink(codeResult.text);
                    resultList.innerHTML += `
                        <div class="result-item">
                            <div class="result-header">
                                <span>${codeResult.type} 감지됨</span>
                                <span class="result-type-badge qr">${codeResult.type}</span>
                            </div>
                            <div class="result-text" style="font-weight:bold; font-size:1.1em; word-break:break-all;">
                                ${link ? `<a href="${link}" target="_blank" class="result-link" style="display:inline; margin-top:0;">🔗 ${codeResult.text}</a>` : codeResult.text}
                            </div>
                        </div>
                    `;
                }
            } catch (e) {
                console.warn('Scan Error:', e);
            }

            // 4. OCR Scan
            const text = await this.performOCR(tempCanvas);
            if (text && text.trim().length > 0) {
                const trimmedText = text.trim();
                const link = this.createHyperlink(trimmedText);
                resultList.innerHTML += `
                    <div style="${foundCode ? 'margin-top: 15px; padding-top: 10px; border-top: 1px dashed #ddd;' : ''}">
                        <div class="result-header">
                            <span>텍스트 인식됨</span>
                            <span class="result-type-badge text">OCR</span>
                        </div>
                        <div class="result-text">
                            ${link ? `<a href="${link}" target="_blank" class="result-link" style="display:inline; margin-top:0;">🔗 ${trimmedText}</a>` : trimmedText}
                        </div>
                    </div>
                `;
            } else if (!foundCode) {
                resultList.innerHTML += '<div style="color:#7f8c8d; text-align:center; padding: 10px;">인식된 텍스트나 코드가 없습니다.</div>';
            }

            this.resultContent.appendChild(resultList);
            this.statusEl.textContent = '분석 완료';

        } catch (error) {
            console.error(error);
            this.resultContent.innerHTML += `<div style="color:red; margin-top:10px;">오류: ${error.message}</div>`;
            this.statusEl.textContent = '오류 발생';
        }
    }

    async scanCode(canvas, ctx, width, height) {
        console.log('scanCode called. ZXing available:', !!window.ZXing);
        if (!window.ZXing) {
            console.warn('ZXing library not found in window');
            return null;
        }

        const hints = new Map();
        const formats = [
            ZXing.BarcodeFormat.QR_CODE,
            ZXing.BarcodeFormat.DATA_MATRIX,
            ZXing.BarcodeFormat.CODE_128,
            ZXing.BarcodeFormat.EAN_13,
            ZXing.BarcodeFormat.EAN_8,
            ZXing.BarcodeFormat.CODE_39,
            ZXing.BarcodeFormat.UPC_A,
            ZXing.BarcodeFormat.UPC_E,
            ZXing.BarcodeFormat.CODABAR,
            ZXing.BarcodeFormat.ITF
        ];
        hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
        hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

        try {
            const codeReader = new ZXing.BrowserMultiFormatReader(hints);
            console.log('ZXing Reader initialized');

            // Helper to convert canvas to image and decode
            const decodeCanvasViaImage = async (cvs) => {
                return new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => {
                        // console.log("Image loaded for ZXing (Size: " + img.width + "x" + img.height + ")");
                        codeReader.decodeFromImage(img)
                            .then(resolve)
                            .catch((err) => {
                                // console.log("decodeFromImage rejected:", err);
                                reject(err);
                            });
                    };
                    img.onerror = (err) => reject(new Error("Image load failed"));
                    img.src = cvs.toDataURL();
                });
            };

            // Helper to try decoding with logging
            const tryDecode = async (cvs, label) => {
                try {
                    console.log(`ZXing: Attempting ${label}... (Size: ${cvs.width}x${cvs.height})`);
                    // Use decodeFromImage logic instead of decodeFromCanvas
                    const result = await decodeCanvasViaImage(cvs);

                    if (result) {
                        console.log(`ZXing found (${label}):`, result);
                        return { type: 'CODE (' + result.getBarcodeFormat() + ')', text: result.getText() };
                    }
                } catch (err) {
                    // Log failure for each attempt
                    // console.log(`ZXing ${label} failed:`, err);
                }
                return null;
            };

            // 1. Try Original (Raw Capture - Best for QR)
            let result = await tryDecode(canvas, 'Original');
            if (result) return result;

            // --- STRATEGY 2: Upscaling (2x) ---
            // Small or low-res 1D barcodes fail often. Upscaling with nearest-neighbor helps.
            const upscaledCanvas = this.upscaleCanvas(canvas, 2);

            // 2. Try Upscaled + Padded (Primary fix for 1D barcodes)
            // 50px padding on the upscaled image (effectively 25px original)
            const upscaledPadded = this.padCanvas(upscaledCanvas, 50);
            result = await tryDecode(upscaledPadded, 'Upscaled (2x) + Padded');
            if (result) return result;

            // 3. Try Upscaled + Padded + Rotated (For vertical barcodes)
            const upscaledRotated = this.rotateCanvas(upscaledPadded);
            result = await tryDecode(upscaledRotated, 'Upscaled (2x) + Padded + Rotated');
            if (result) return result;

            // 4. Try Upscaled + Padded + Binarized (For low contrast)
            const upscaledBinarized = this.preprocessImage(upscaledPadded, 2); // 2 = Binarize
            result = await tryDecode(upscaledBinarized, 'Upscaled (2x) + Padded + Binarized');
            if (result) return result;

            // --- STRATEGY 3: Original Scale Fallbacks ---

            // 5. Try Padded + Binarized (Original scale)
            const paddedCanvas = this.padCanvas(canvas, 50);
            const binarizedPadded = this.preprocessImage(paddedCanvas, 2);
            result = await tryDecode(binarizedPadded, 'Padded & Binarized (Original)');
            if (result) return result;

            // 6. Try Preprocessed (Original) - General fallback
            const processedCanvas = this.preprocessImage(canvas, 0);
            result = await tryDecode(processedCanvas, 'Preprocessed');
            if (result) return result;

            // 7. Try Inverted (for Dark Mode QR)
            const invertedCanvas = this.preprocessImage(canvas, 1);
            result = await tryDecode(invertedCanvas, 'Inverted');
            if (result) return result;

        } catch (e) {
            console.error('ZXing unexpected error:', e);
        }

        return null;
    }

    // Helper to add white padding (Quiet Zone)
    padCanvas(sourceCanvas, padding) {
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;
        const temp = document.createElement('canvas');
        temp.width = w + padding * 2;
        temp.height = h + padding * 2;
        const ctx = temp.getContext('2d');

        // Fill white
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, temp.width, temp.height);

        // Draw centered
        ctx.drawImage(sourceCanvas, padding, padding);
        return temp;
    }

    // Helper to rotate canvas 90 degrees
    rotateCanvas(sourceCanvas) {
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;
        const temp = document.createElement('canvas');
        temp.width = h; // Swap w/h
        temp.height = w;
        const ctx = temp.getContext('2d');

        ctx.translate(h / 2, w / 2);
        ctx.rotate(90 * Math.PI / 180);
        ctx.drawImage(sourceCanvas, -w / 2, -h / 2);

        return temp;
    }

    // Helper to upscale canvas (e.g. 2x)
    upscaleCanvas(sourceCanvas, scale) {
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;
        const temp = document.createElement('canvas');
        temp.width = w * scale;
        temp.height = h * scale;
        const ctx = temp.getContext('2d');

        // Critical: Disable smoothing to keep barcode edges sharp
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sourceCanvas, 0, 0, w, h, 0, 0, temp.width, temp.height);

        return temp;
    }

    preprocessImage(sourceCanvas, type) {
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;
        const temp = document.createElement('canvas');
        temp.width = w;
        temp.height = h;
        const ctx = temp.getContext('2d');
        ctx.drawImage(sourceCanvas, 0, 0);

        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            // Grayscale (Luminosity)
            let gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;

            if (type === 1) { // Invert
                gray = 255 - gray;
            } else if (type === 2) { // Binarize (Threshold)
                gray = gray > 128 ? 255 : 0;
            } else { // Standard Contrast Boost
                // Simple contrast
                gray = (gray - 128) * 1.5 + 128;
                // Clamp
                gray = Math.max(0, Math.min(255, gray));
            }

            data[i] = gray;
            data[i + 1] = gray;
            data[i + 2] = gray;
        }

        ctx.putImageData(imageData, 0, 0);
        return temp;
    }

    async performOCR(canvas) {
        if (!window.Tesseract) return null;
        const result = await Tesseract.recognize(
            canvas,
            'eng+kor', // English and Korean
            {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        this.statusEl.textContent = `텍스트 인식 중... ${Math.round(m.progress * 100)}%`;
                    }
                }
            }
        );
        return result.data.text;
    }

    createHyperlink(text) {
        const urlRegex = /(https?:\/\/[^\s]+)/g; // Simple regex
        const match = text.match(urlRegex);
        if (match) return match[0];

        // Check for www.
        if (text.includes('www.') && !text.includes('http')) {
            const wwwMatch = text.match(/(www\.[^\s]+)/g);
            if (wwwMatch) return 'http://' + wwwMatch[0];
        }
        return null;
    }
}
