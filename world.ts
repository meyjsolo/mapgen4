/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2025 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Spatial world management: quadtree-style tile pyramid over an expanded
 * world. Each LOD level halves the tile size AND the spacing, so every
 * tile at every level holds roughly the same number of cells (= the
 * native detail scale). LOD is selected from the zoom level, tiles
 * outside the viewport are culled, and an LRU cache bounds memory.
 */

export type TileKey = string;
export type WorldRect = [number, number, number, number]; // x0, y0, w, h

export interface Tile {
    key: TileKey;
    lod: number;
    tx: number;
    ty: number;
    rect: WorldRect;      // visible world rect (no apron)
    genRect: WorldRect;   // visible rect + apron (what gets generated)
    spacing: number;
    state: 'empty' | 'queued' | 'generating' | 'ready' | 'regen';
    hasData: boolean;     // has (possibly stale) generated data to display
    lastUsed: number;
}

const CANVAS_SIZE = 2048;

export class WorldManager {
    tiles = new Map<TileKey, Tile>();

    worldSize: number;
    baseSpacing: number;
    mountainSpacing: number;
    meshSeed: number;
    baseTilesPerAxis: number;
    minLevel: number;
    maxLevel: number;
    spacingFactor: number;
    apronCells: number;
    maxTiles: number;
    maxVisibleCells: number;
    zoomNative: number;

    onRequestTile: (tile: Tile) => void = () => {};
    onTileEvicted: (tile: Tile) => void = () => {};

    private pending = new Set<TileKey>();
    private queued: TileKey[] = [];
    private inflight = 0;
    maxInflight = 8;
    private frame = 0;

    constructor(cfg: any) {
        this.worldSize = cfg.world.size;
        this.baseSpacing = cfg.world.baseSpacing;
        this.mountainSpacing = cfg.world.mountainSpacing ?? cfg.mountainSpacing;
        this.meshSeed = cfg.mesh.seed;
        this.baseTilesPerAxis = cfg.world.baseTilesPerAxis;
        this.minLevel = cfg.lod.minLevel;
        this.maxLevel = cfg.lod.maxLevel;
        this.spacingFactor = cfg.lod.spacingFactor;
        this.apronCells = cfg.lod.apronCells;
        this.maxTiles = cfg.world.maxTiles;
        this.maxVisibleCells = Math.ceil(cfg.lod.maxVisibleTriangles / 2);
        this.maxInflight = cfg.lod.maxInflight ?? 8;
        this.zoomNative = 200 * cfg.lod.targetPixelsPerCell / (CANVAS_SIZE * cfg.world.baseSpacing);
    }

    get nativeTileSize(): number { return this.worldSize / this.baseTilesPerAxis; }

    tileSize(level: number): number { return this.nativeTileSize * Math.pow(this.spacingFactor, -level); }
    spacing(level: number): number { return this.baseSpacing * Math.pow(this.spacingFactor, -level); }
    grid(level: number): number { return Math.max(1, Math.round(this.worldSize / this.tileSize(level))); }
    cellsPerTile(level: number): number {
        const s = this.tileSize(level) / this.spacing(level);
        return s * s;
    }

    key(level: number, tx: number, ty: number): TileKey { return level + ':' + tx + ':' + ty; }

    levelForZoom(zoom: number): number {
        let level = Math.round(Math.log2(zoom / this.zoomNative));
        level = Math.max(this.minLevel, Math.min(this.maxLevel, level));
        return level;
    }

    tileRect(level: number, tx: number, ty: number): WorldRect {
        const size = this.tileSize(level);
        return [tx * size, ty * size, size, size];
    }

    private makeTile(level: number, tx: number, ty: number): Tile {
        const rect = this.tileRect(level, tx, ty);
        const spacing = this.spacing(level);
        const apron = spacing * this.apronCells;
        const genRect: WorldRect = [rect[0] - apron, rect[1] - apron, rect[2] + 2 * apron, rect[3] + 2 * apron];
        const tile: Tile = {
            key: this.key(level, tx, ty),
            lod: level, tx, ty,
            rect, genRect, spacing,
            state: 'empty',
            hasData: false,
            lastUsed: 0,
        };
        this.tiles.set(tile.key, tile);
        return tile;
    }

    private request(tile: Tile) {
        if (tile.state === 'queued' || tile.state === 'generating' || this.pending.has(tile.key)) return;
        tile.state = 'queued';
        this.queued.push(tile.key);
        this.flushQueue();
    }

    private flushQueue() {
        while (this.inflight < this.maxInflight && this.queued.length > 0) {
            const key = this.queued.shift()!;
            const tile = this.tiles.get(key);
            if (!tile) continue;
            this.inflight++;
            this.pending.add(key);
            tile.state = 'generating';
            this.onRequestTile(tile);
        }
    }

    markTileReady(key: TileKey, data: any) {
        const tile = this.tiles.get(key);
        if (!tile) return;
        this.inflight--;
        this.pending.delete(key);
        const regen = tile.state === 'regen';
        tile.state = 'ready';
        tile.hasData = true;
        (tile as any).data = data;
        if (regen) this.request(tile); // constraints changed while generating
        this.flushQueue();
    }

    markTileFailed(key: TileKey) {
        const tile = this.tiles.get(key);
        if (!tile) return;
        this.inflight--;
        this.pending.delete(key);
        tile.state = 'empty';
        this.flushQueue();
    }

    private countVisibleTiles(level: number, viewRect: WorldRect): number {
        const ts = this.tileSize(level), grid = this.grid(level);
        const tx0 = Math.max(0, Math.floor(viewRect[0] / ts));
        const ty0 = Math.max(0, Math.floor(viewRect[1] / ts));
        const tx1 = Math.min(grid - 1, Math.floor((viewRect[0] + viewRect[2]) / ts));
        const ty1 = Math.min(grid - 1, Math.floor((viewRect[1] + viewRect[3]) / ts));
        return Math.max(0, tx1 - tx0 + 1) * Math.max(0, ty1 - ty0 + 1);
    }

    private ensureTile(level: number, tx: number, ty: number): Tile {
        const key = this.key(level, tx, ty);
        let tile = this.tiles.get(key);
        if (!tile) tile = this.makeTile(level, tx, ty);
        tile.lastUsed = this.frame;
        if (tile.state === 'empty' || tile.state === 'regen') {
            tile.state = 'empty';
            this.request(tile);
        }
        return tile;
    }

    /**
     * Called every frame. Selects the LOD from the zoom, viewport-culls
     * tiles, requests missing ones, and returns the ready tiles to draw.
     * Tiles that aren't ready yet fall back to their coarsest ready
     * ancestor so the viewport never goes blank while finer tiles load.
     */
    update(zoom: number, viewRect: WorldRect): Tile[] {
        this.frame++;
        let level = this.levelForZoom(zoom);

        // Soft budget: coarsen the LOD when too many cells would be visible.
        while (level > this.minLevel &&
               this.countVisibleTiles(level, viewRect) * this.cellsPerTile(level) > this.maxVisibleCells) {
            level--;
        }

        const ts = this.tileSize(level), grid = this.grid(level);
        const tx0 = Math.max(0, Math.floor(viewRect[0] / ts));
        const ty0 = Math.max(0, Math.floor(viewRect[1] / ts));
        const tx1 = Math.min(grid - 1, Math.floor((viewRect[0] + viewRect[2]) / ts));
        const ty1 = Math.min(grid - 1, Math.floor((viewRect[1] + viewRect[3]) / ts));

        const wanted: [number, number][] = [];
        for (let ty = ty0; ty <= ty1; ty++) {
            for (let tx = tx0; tx <= tx1; tx++) {
                wanted.push([tx, ty]);
                this.ensureTile(level, tx, ty);
            }
        }

        const out: Tile[] = [];
        const visibleKeys = new Set<TileKey>();
        for (const [tx, ty] of wanted) {
            const key = this.key(level, tx, ty);
            visibleKeys.add(key);
            let tile = this.tiles.get(key)!;
            if (tile.hasData) {
                // keep showing the previous data while a regeneration is in
                // flight, so painting/parameter changes don't flicker
                out.push(tile);
                continue;
            }
            // no data yet: walk up the quadtree until we find a ready ancestor
            let guard = 0;
            while (tile.state !== 'ready') {
                if (tile.lod <= this.minLevel || guard++ > 16) break;
                const pl = tile.lod - 1;
                const ptx = tile.tx >> 1, pty = tile.ty >> 1;
                const pkey = this.key(pl, ptx, pty);
                visibleKeys.add(pkey);
                tile = this.ensureTile(pl, ptx, pty);
            }
            if (tile.state === 'ready') out.push(tile);
        }

        // Coarse tiles drawn first; finer ones (if any) cover them.
        out.sort((a, b) => a.lod - b.lod);

        // LRU eviction: drop the oldest tiles that aren't visible now.
        if (this.tiles.size > this.maxTiles) {
            const candidates: Tile[] = [];
            for (const tile of this.tiles.values()) {
                if (visibleKeys.has(tile.key)) continue;
                if (tile.state === 'queued' || tile.state === 'generating') continue;
                candidates.push(tile);
            }
            candidates.sort((a, b) => a.lastUsed - b.lastUsed);
            while (this.tiles.size > this.maxTiles && candidates.length > 0) {
                const tile = candidates.shift()!;
                this.tiles.delete(tile.key);
                this.onTileEvicted(tile);
            }
        }
        return out;
    }

    /** True while any tile regeneration is still queued/in flight. */
    hasPendingWork(): boolean {
        for (const tile of this.tiles.values()) {
            if (tile.state === 'queued' || tile.state === 'generating') return true;
        }
        return false;
    }

    /** Invalidate tiles overlapping a world rect (e.g. after painting). */
    invalidateRect(rect: WorldRect) {
        for (const tile of this.tiles.values()) {
            const [x0, y0, w, h] = tile.rect;
            if (x0 < rect[0] + rect[2] && x0 + w > rect[0] &&
                y0 < rect[1] + rect[3] && y0 + h > rect[1]) {
                if (tile.state === 'ready') tile.state = 'regen';
                else if (tile.state === 'generating') tile.state = 'regen';
                /* queued tiles pick up the new constraints when sent */
            }
        }
    }
}
