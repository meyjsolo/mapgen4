/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2025 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Lightweight performance benchmark: FPS, per-frame render time, worker
 * generation time, visible cell count, and JS heap memory. Enabled via
 * config.js (benchmark.enabled).
 */

export default class Bench {
    enabled: boolean;
    fps = 0;
    renderMs = 0;
    genMs = 0;
    visibleCells = 0;
    private frames = 0;
    private lastSecond = 0;
    private elem: HTMLElement | null = null;

    constructor(enabled: boolean) {
        this.enabled = enabled;
        if (enabled) {
            this.elem = document.getElementById('timing');
            if (!this.elem) {
                this.elem = document.createElement('div');
                this.elem.setAttribute('id', 'timing');
                document.body.appendChild(this.elem);
            }
        }
    }

    /** Called once per rendered frame. */
    fpsTick() {
        if (!this.enabled) return;
        this.frames++;
        const now = performance.now();
        if (now - this.lastSecond >= 500) {
            this.fps = this.frames * 1000 / (now - this.lastSecond);
            this.frames = 0;
            this.lastSecond = now;
            this.report();
        }
    }

    reportGen(ms: number) {
        if (this.enabled) this.genMs = ms;
    }

    private report() {
        const mem = (performance as any).memory?.usedJSHeapSize ?? 0;
        const line = `fps ${this.fps.toFixed(1)} | render ${this.renderMs.toFixed(1)}ms | ` +
            `gen ${this.genMs.toFixed(1)}ms | cells ${this.visibleCells}` +
            (mem ? ` | mem ${(mem / 1048576).toFixed(1)}MB` : '');
        if (this.elem) this.elem.innerText = line;
        if (typeof console !== 'undefined') console.log('[bench]', line);
    }
}
