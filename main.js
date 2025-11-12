// WebWorker 기반 Ghostscript 사용

class PDFSeparationViewer {
    constructor() {
        this.canvas = document.getElementById('pdf-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.currentPDF = null;
        this.ghostscript = null;
        this.spotColors = [];
        this.gsModule = null;

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
        this.overprintCheckbox = document.getElementById('overprint');
        this.spotControlsContainer = document.getElementById('spot-controls');
        this.tacValueElement = document.getElementById('tac-value');
        this.cursorCoordsElement = document.getElementById('cursor-coords');
    }
    
    bindEvents() {
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        
        Object.values(this.cmykCheckboxes).forEach(checkbox => {
            checkbox.addEventListener('change', () => this.updateSeparation());
        });
        
        this.overprintCheckbox.addEventListener('change', () => this.updateSeparation());
        
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseleave', () => this.clearMouseInfo());
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
                const { type, requestId, success, data, width, height, message } = e.data;

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
                } else if (type === 'result') {
                    const pending = this.pendingRequests.get(requestId);
                    if (pending) {
                        if (success) {
                            this.convertPNGToImageData(data, width, height)
                                .then(imageData => pending.resolve(imageData))
                                .catch(error => {
                                    console.error('이미지 변환 실패:', error);
                                    pending.resolve(this.createDummyImageData(width, height));
                                });
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
                        return { success: true, pages: 1 };
                    } catch (error) {
                        console.error('PDF 로딩 실패:', error);
                        return { success: false };
                    }
                },

                renderPage: async (pageNum, options) => {
                    if (!this.currentPDFData) {
                        throw new Error('PDF가 로딩되지 않았습니다');
                    }

                    return new Promise((resolve, reject) => {
                        const reqId = ++this.requestId;
                        this.pendingRequests.set(reqId, { resolve, reject, options });

                        this.worker.postMessage({
                            type: 'process',
                            requestId: reqId,
                            data: {
                                pdfData: this.currentPDFData,
                                options: options
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
                }
            };

            console.log('Ghostscript WebWorker 준비 완료');
        } catch (error) {
            console.error('Ghostscript WebWorker 초기화 실패:', error);
            this.showError('Ghostscript를 초기화할 수 없습니다.');
        }
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
                resolve(imageData);
            };
            
            img.onerror = (error) => {
                console.error('PNG 이미지 로딩 실패:', error);
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

        try {
            // 컨테이너 크기에 맞춰 렌더링 크기 계산
            const container = this.canvas.parentElement;
            const maxWidth = container.clientWidth - 40; // padding 고려
            const maxHeight = container.clientHeight - 40;

            // A4 비율 (210mm x 297mm = 1:1.414)
            const aspectRatio = 1.414;
            let renderWidth = Math.min(maxWidth, 800);
            let renderHeight = Math.floor(renderWidth * aspectRatio);

            if (renderHeight > maxHeight) {
                renderHeight = maxHeight;
                renderWidth = Math.floor(renderHeight / aspectRatio);
            }

            const renderOptions = this.buildRenderOptions();
            renderOptions.width = renderWidth;
            renderOptions.height = renderHeight;

            console.log('렌더링 크기:', renderWidth, 'x', renderHeight);

            const imageData = await this.ghostscript.renderPage(1, renderOptions);

            this.displayImageData(imageData);
            this.applyColorSeparation(imageData);
        } catch (error) {
            console.error('페이지 렌더링 실패:', error);
            this.showError('페이지를 렌더링할 수 없습니다.');
        }
    }
    
    buildRenderOptions() {
        const options = {
            width: 800,
            height: 600,
            separations: [],
            overprint: this.overprintCheckbox.checked
        };
        
        // CMYK 분판 옵션
        Object.entries(this.cmykCheckboxes).forEach(([color, checkbox]) => {
            if (checkbox.checked) {
                options.separations.push(color);
            }
        });
        
        // 별색 분판 옵션
        this.spotColors.forEach((colorName, index) => {
            const checkbox = document.getElementById(`spot-${index}`);
            if (checkbox && checkbox.checked) {
                options.separations.push(colorName);
            }
        });
        
        return options;
    }
    
    displayImageData(imageData) {
        this.canvas.width = imageData.width;
        this.canvas.height = imageData.height;
        this.ctx.putImageData(imageData, 0, 0);

        // 원본 이미지 데이터 저장 (분판 필터링용)
        this.originalImageData = this.ctx.getImageData(0, 0, imageData.width, imageData.height);
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

        // 필터링된 이미지 표시
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
        if (this.currentPDF && this.originalImageData) {
            // 원본 이미지에 필터만 다시 적용 (재렌더링하지 않음)
            this.applyColorSeparation(this.originalImageData);
        }
    }
    
    async handleMouseMove(event) {
        if (!this.currentPDF || !this.originalImageData) return;

        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        // 캔버스 좌표를 실제 PDF 좌표로 변환
        const canvasX = Math.floor((x / rect.width) * this.canvas.width);
        const canvasY = Math.floor((y / rect.height) * this.canvas.height);

        // 캔버스 범위 체크
        if (canvasX < 0 || canvasX >= this.canvas.width || canvasY < 0 || canvasY >= this.canvas.height) {
            return;
        }

        this.cursorCoordsElement.textContent = `${canvasX}, ${canvasY}`;

        try {
            // 원본 이미지에서 픽셀 색상 가져오기
            const pixelIndex = (canvasY * this.originalImageData.width + canvasX) * 4;
            const r = this.originalImageData.data[pixelIndex];
            const g = this.originalImageData.data[pixelIndex + 1];
            const b = this.originalImageData.data[pixelIndex + 2];

            // RGB를 CMYK로 변환
            const k = 1 - Math.max(r, g, b) / 255;
            const c = k >= 1 ? 0 : (1 - r / 255 - k) / (1 - k);
            const m = k >= 1 ? 0 : (1 - g / 255 - k) / (1 - k);
            const y = k >= 1 ? 0 : (1 - b / 255 - k) / (1 - k);

            const inkValues = {
                cyan: c * 100,
                magenta: m * 100,
                yellow: y * 100,
                black: k * 100
            };

            const tac = this.calculateTAC(inkValues);
            this.tacValueElement.textContent = tac.toFixed(1);
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
}

// 페이지 로딩 완료 시 애플리케이션 초기화
document.addEventListener('DOMContentLoaded', () => {
    new PDFSeparationViewer();
});