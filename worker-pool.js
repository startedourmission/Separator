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
            const initPromise = new Promise((resolve, reject) => {
                const reqId = ++this.requestId;
                this.pendingRequests.set(reqId, { resolve, reject, type: 'init' });

                const originalHandler = worker.onmessage;
                worker.onmessage = (e) => {
                    if (e.data.type === 'init') {
                        worker.onmessage = originalHandler;
                        const pending = this.pendingRequests.get(reqId);
                        if (pending) {
                            this.pendingRequests.delete(reqId);
                            resolve();
                        }
                    } else {
                        originalHandler(e);
                    }
                };

                worker.postMessage({ type: 'init' });
            });

            initPromises.push(initPromise);
        }

        await Promise.all(initPromises);
        this.initialized = true;
        console.log(`WorkerPool initialized with ${this.poolSize} workers`);
    }

    setPDFData(pdfData) {
        this.pdfData = pdfData;
    }

    handleWorkerMessage(workerId, e) {
        const { type, requestId, success, ...data } = e.data;

        const pending = this.pendingRequests.get(requestId);
        if (pending) {
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
        const { type, data, resolve, reject } = task;
        const reqId = ++this.requestId;

        const workerInfo = this.activeWorkers.get(workerId);
        workerInfo.busy = true;
        workerInfo.currentRequestId = reqId;

        this.pendingRequests.set(reqId, { resolve, reject });

        worker.postMessage({
            type,
            requestId: reqId,
            data: {
                ...data,
                pdfData: this.pdfData
            }
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
