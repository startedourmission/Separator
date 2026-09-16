// 설정별 원본 잉크판을 재사용하고, 같은 페이지를 동시에 요청해도 GS는 한 번만 실행한다.
export class PageRenderCache {
    constructor(maxBytes = 512 * 1024 * 1024) {
        this.maxBytes = maxBytes;
        this.entries = new Map();
        this.pending = new Map();
        this.bytes = 0;
        this.revision = 0;
    }

    clear() {
        this.revision++;
        this.entries.clear();
        this.pending.clear();
        this.bytes = 0;
    }

    async getOrRender(key, render) {
        if (this.entries.has(key)) {
            const entry = this.entries.get(key);
            this.entries.delete(key);
            this.entries.set(key, entry);
            return entry.data;
        }
        if (this.pending.has(key)) return this.pending.get(key);
        const revision = this.revision;
        const task = Promise.resolve().then(render).then(data => {
            if (revision !== this.revision) return data;
            const arrays = [data.imageData?.data,
                ...Object.values(data.imageData?.channels || {}),
                ...Object.values(data.spotColorData || {})];
            const bytes = arrays.reduce((sum, array) => sum + (array?.byteLength || 0), 0);
            if (bytes > this.maxBytes) return data;
            while (this.bytes + bytes > this.maxBytes && this.entries.size) {
                const oldest = this.entries.keys().next().value;
                this.bytes -= this.entries.get(oldest).bytes;
                this.entries.delete(oldest);
            }
            this.entries.set(key, { data, bytes });
            this.bytes += bytes;
            return data;
        }).finally(() => {
            if (this.pending.get(key) === task) this.pending.delete(key);
        });
        this.pending.set(key, task);
        return task;
    }
}
