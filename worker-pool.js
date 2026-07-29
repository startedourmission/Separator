// Worker Pool for Parallel PDF Processing
class WorkerPool {
    constructor(workerScript, poolSize = 4) {
        this.workerScript = workerScript;
        this.poolSize = poolSize;
        this.workers = [];
        this.taskQueue = [];
        this.activeWorkers = new Map(); // workerId -> { worker, busy, requestId }
        this.requestId = 0;
        this.pendingRequests = new Map(); // requestId -> { resolve, reject }
        this.initialized = false;
        this.pdfData = null;
    }

    async init() {
        if (this.initialized) return;

        const initPromises = [];

        for (let i = 0; i < this.poolSize; i++) {
            const worker = new Worker(this.workerScript, { type: 'module' });
            const workerId = i;

            this.activeWorkers.set(workerId, {
                worker,
                busy: false,
                currentRequestId: null
            });

            // Worker 메시지 핸들러 설정
            worker.onmessage = (e) => this.handleWorkerMessage(workerId, e);
            worker.onerror = (e) => this.handleWorkerError(workerId, e);

            // Worker 초기화
            try {
                await new Promise((resolve, reject) => {
                    const reqId = ++this.requestId;
                    this.pendingRequests.set(reqId, { resolve, reject, type: 'init' });

                    const originalHandler = worker.onmessage;
                    worker.onmessage = (e) => {
                        if (e.data.type === 'init') {
                            worker.onmessage = originalHandler;
                            const pending = this.pendingRequests.get(reqId);
                            if (pending) {
                                this.pendingRequests.delete(reqId);
                                if (e.data.success) {
                                    resolve();
                                } else {
                                    reject(new Error(e.data.message || 'Worker initialization failed'));
                                }
                            }
                        } else {
                            originalHandler(e);
                        }
                    };

                    worker.postMessage({ type: 'init' });
                });
            } catch (error) {
                console.error(`Worker ${workerId} initialization failed:`, error);
                // 초기화 실패 시 해당 워커 제거하고 계속 진행?
                // 여기서는 에러 로그만 남기고 일단 진행. 나중에 사용 시 에러날 것임.
            }
        }

        this.initialized = true;
        console.log(`WorkerPool initialized with ${this.poolSize} workers`);
    }

    setPDFData(pdfData) {
        // 같은 문서면 재전송하지 않음 — 각 워커는 이미 바이트를 캐시하고 있다
        if (this.pdfData === pdfData) return;
        this.pdfData = pdfData;
        this.broadcastPDF();
    }

    // 모든 워커에 문서 바이트를 1회 전송해 캐시시킴.
    // 이후 작업 메시지는 pdfData를 싣지 않으므로 작업당 수 MB 복제가 사라진다.
    // (postMessage는 워커별 FIFO — 이후 작업은 항상 갱신된 캐시를 본다)
    broadcastPDF() {
        if (!this.pdfData) return;
        for (const [, info] of this.activeWorkers) {
            info.worker.postMessage({ type: 'setPDF', data: { pdfData: this.pdfData } });
        }
    }

    // 아직 시작되지 않은 대기 중인 "스캔 청크" 작업을 취소.
    // 이미 워커에서 실행 중인 작업은 중간에 끊을 수 없으므로 그대로 두고,
    // 큐의 청크 작업만 비워 새 스캔이 곧바로 워커를 잡을 수 있게 한다.
    // 열람 렌더(process/processTiffsep) 등 다른 작업은 건드리지 않는다 —
    // 취소하면 화면 페이지가 빈 채로 남는다.
    cancelQueuedTasks() {
        const CHUNK_TYPES = new Set(['renderPagesChunk', 'processTiffsepChunk']);
        const keep = [];
        let dropped = 0;
        for (const task of this.taskQueue) {
            if (CHUNK_TYPES.has(task.type)) {
                // 대기 중이던 호출부가 영원히 매달리지 않도록 즉시 결과를 돌려준다
                if (task.resolve) task.resolve({ cancelled: true });
                dropped++;
            } else {
                keep.push(task);
            }
        }
        this.taskQueue = keep;
        return dropped;
    }

    // 범용 단일 작업 실행. priority가 참이면 대기 큐 맨 앞에 끼어든다 —
    // 화면에 보이는 페이지 렌더가 백그라운드 스캔 청크들 뒤에 줄서지 않도록.
    runTask(type, data, { priority = false } = {}) {
        return new Promise((resolve, reject) => {
            const task = { type, data, resolve, reject };
            const available = this.getAvailableWorker();
            if (available) {
                this.executeTask(available.workerId, available.worker, task);
            } else if (priority) {
                this.taskQueue.unshift(task);
            } else {
                this.taskQueue.push(task);
            }
        });
    }

    handleWorkerMessage(workerId, e) {
        const { type, requestId, success, ...data } = e.data;

        const pending = this.pendingRequests.get(requestId);
        if (pending) {
            // 청크 스트리밍 중간 결과: 요청을 끝내지 않고 페이지 콜백만 호출
            if (type === 'chunkPageResult' || type === 'tiffsepChunkPage') {
                if (pending.onProgress) {
                    pending.onProgress({ type, success, ...data });
                }
                return;
            }

            this.pendingRequests.delete(requestId);

            // Worker를 다시 사용 가능하게 설정
            const workerInfo = this.activeWorkers.get(workerId);
            if (workerInfo) {
                workerInfo.busy = false;
                workerInfo.currentRequestId = null;
            }

            // type이 'error'이거나 success가 false인 경우 실패 처리
            if (type === 'error' || success === false) {
                pending.reject(new Error(data.message || 'Worker task failed'));
            } else {
                // success가 true이거나 type이 'result'인 경우 성공
                pending.resolve({ type, ...data });
            }

            // 대기 중인 작업 처리
            this.processQueue();
        }
    }

    handleWorkerError(workerId, error) {
        console.error(`Worker ${workerId} error:`, error);

        const workerInfo = this.activeWorkers.get(workerId);
        if (workerInfo && workerInfo.currentRequestId) {
            const pending = this.pendingRequests.get(workerInfo.currentRequestId);
            if (pending) {
                this.pendingRequests.delete(workerInfo.currentRequestId);
                pending.reject(error);
            }
            workerInfo.busy = false;
            workerInfo.currentRequestId = null;
        }

        // Worker 재생성
        this.recreateWorker(workerId);
    }

    async recreateWorker(workerId) {
        const oldInfo = this.activeWorkers.get(workerId);
        if (oldInfo) {
            oldInfo.worker.terminate();
        }

        const worker = new Worker(this.workerScript, { type: 'module' });
        this.activeWorkers.set(workerId, {
            worker,
            busy: false,
            currentRequestId: null
        });

        worker.onmessage = (e) => this.handleWorkerMessage(workerId, e);
        worker.onerror = (e) => this.handleWorkerError(workerId, e);

        // Worker 초기화
        await new Promise((resolve) => {
            const handler = (e) => {
                if (e.data.type === 'init') {
                    worker.onmessage = (e) => this.handleWorkerMessage(workerId, e);
                    resolve();
                }
            };
            worker.onmessage = handler;
            worker.postMessage({ type: 'init' });
        });

        // 재생성된 워커는 PDF 캐시가 비어 있으므로 다시 전송
        if (this.pdfData) {
            worker.postMessage({ type: 'setPDF', data: { pdfData: this.pdfData } });
        }

        console.log(`Worker ${workerId} recreated`);
    }

    getAvailableWorker() {
        for (const [workerId, info] of this.activeWorkers) {
            if (!info.busy) {
                return { workerId, worker: info.worker };
            }
        }
        return null;
    }

    processQueue() {
        while (this.taskQueue.length > 0) {
            const available = this.getAvailableWorker();
            if (!available) break;

            const task = this.taskQueue.shift();
            this.executeTask(available.workerId, available.worker, task);
        }
    }

    executeTask(workerId, worker, task) {
        const { type, data, resolve, reject, onProgress } = task;
        const reqId = ++this.requestId;

        const workerInfo = this.activeWorkers.get(workerId);
        workerInfo.busy = true;
        workerInfo.currentRequestId = reqId;

        this.pendingRequests.set(reqId, { resolve, reject, onProgress });

        // pdfData는 setPDFData 시점에 워커별로 캐시돼 있으므로 작업 메시지에 싣지 않는다.
        // (data에 명시적 pdfData가 있으면 그대로 전달 — 워커가 그것을 우선 사용)
        worker.postMessage({
            type,
            requestId: reqId,
            data
        });
    }

    // 페이지 렌더링 요청
    renderPage(pageNum, options) {
        return new Promise((resolve, reject) => {
            const task = {
                type: 'process',
                data: {
                    options,
                    pageNum
                },
                resolve,
                reject
            };

            const available = this.getAvailableWorker();
            if (available) {
                this.executeTask(available.workerId, available.worker, task);
            } else {
                this.taskQueue.push(task);
            }
        });
    }

    // 여러 페이지 병렬 렌더링
    async renderPagesParallel(pageNumbers, optionsGenerator) {
        const promises = pageNumbers.map(pageNum => {
            const options = optionsGenerator(pageNum);
            return this.renderPage(pageNum, options)
                .then(result => ({ pageNum, result, success: true }))
                .catch(error => ({ pageNum, error, success: false }));
        });

        return Promise.all(promises);
    }

    // 페이지 범위를 한 번의 GS 실행으로 렌더링 (tiff32nc). 페이지 결과는 onPageResult로 스트리밍.
    renderPagesChunk(firstPage, lastPage, dpi, onPageResult, excludeAnnots = false) {
        return new Promise((resolve, reject) => {
            const task = {
                type: 'renderPagesChunk',
                data: { firstPage, lastPage, dpi, excludeAnnots },
                resolve,
                reject,
                onProgress: onPageResult
            };

            const available = this.getAvailableWorker();
            if (available) {
                this.executeTask(available.workerId, available.worker, task);
            } else {
                this.taskQueue.push(task);
            }
        });
    }

    // 페이지 범위를 한 번의 tiffsep 실행으로 분판 렌더링. 페이지 결과는 onPageResult로 스트리밍.
    processTiffsepChunk(firstPage, lastPage, dpi, onPageResult, excludeAnnots = false) {
        return new Promise((resolve, reject) => {
            const task = {
                type: 'processTiffsepChunk',
                data: { firstPage, lastPage, dpi, excludeAnnots },
                resolve,
                reject,
                onProgress: onPageResult
            };

            const available = this.getAvailableWorker();
            if (available) {
                this.executeTask(available.workerId, available.worker, task);
            } else {
                this.taskQueue.push(task);
            }
        });
    }

    // 배치 처리 (메모리 관리를 위해 청크 단위로 처리)
    async renderPagesInBatches(pageNumbers, optionsGenerator, batchSize = null, onPageComplete = null) {
        const effectiveBatchSize = batchSize || this.poolSize;
        const results = [];

        for (let i = 0; i < pageNumbers.length; i += effectiveBatchSize) {
            const batch = pageNumbers.slice(i, i + effectiveBatchSize);
            const batchResults = await this.renderPagesParallel(batch, optionsGenerator);

            for (const result of batchResults) {
                results.push(result);
                if (onPageComplete) {
                    onPageComplete(result);
                }
            }
        }

        return results;
    }

    // 단일 Worker 요청 (기존 API 호환용)
    async executeOnSingleWorker(type, data) {
        return new Promise((resolve, reject) => {
            const task = {
                type,
                data,
                resolve,
                reject
            };

            const available = this.getAvailableWorker();
            if (available) {
                this.executeTask(available.workerId, available.worker, task);
            } else {
                this.taskQueue.push(task);
            }
        });
    }

    // 리소스 정리
    terminate() {
        for (const [, info] of this.activeWorkers) {
            info.worker.terminate();
        }
        this.activeWorkers.clear();
        this.taskQueue = [];
        this.pendingRequests.clear();
        this.initialized = false;
        console.log('WorkerPool terminated');
    }

    // 현재 상태 조회
    getStatus() {
        let busyCount = 0;
        for (const [, info] of this.activeWorkers) {
            if (info.busy) busyCount++;
        }
        return {
            totalWorkers: this.poolSize,
            busyWorkers: busyCount,
            availableWorkers: this.poolSize - busyCount,
            queuedTasks: this.taskQueue.length,
            pendingRequests: this.pendingRequests.size
        };
    }
}

export { WorkerPool };
