/*
 * From http://www.redblobgames.com/maps/mapgen4/
 * Copyright 2018 Red Blob Games <redblobgames@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *      http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import baseParam from "./config.js";
import {WorldManager} from "./world.ts";
import Painting from "./painting.ts";
import Renderer from "./render.ts";
import Bench from "./benchmark.ts";
import {CityManager} from "./cities.ts";
import CityUI from "./city-ui.ts";
import type {Tile} from "./world.ts";

/* The wild and city scenes are two completely independent maps: each
 * has its own parameters (seed, terrain, ...) and keeps its own state
 * when switching back and forth. */
let activeScene: 'wild' | 'city' = 'wild';
const params = {
    wild: JSON.parse(JSON.stringify(baseParam)),
    city: JSON.parse(JSON.stringify(baseParam)),
};
function getParam() { return params[activeScene]; }

/* Bumped whenever terrain-affecting inputs (painting, elevation/biomes/
 * rivers params, seed) change OUTSIDE of an active brush stroke. The
 * workers rebuild their world-level reference field (seamless rivers/
 * rainfall) only when this version changes, so painting rounds during a
 * stroke reuse the cached field and the refresh happens once when the
 * stroke ends. */
const envVersion = {wild: 0, city: 0};



// each parameter is [initial value, low, high]
const initialParams = {
    elevation: [
        ['seed', 187, 1, 1 << 30],
        ['island', 0.5, 0, 1],
        ['noisy_coastlines', 0.01, 0, 0.1],
        ['hill_height', 0.02, 0, 0.1],
        ['mountain_jagged', 0, 0, 1],
        ['mountain_sharpness', 9.8, 9.1, 12.5],
        ['mountain_folds', 0.05, 0.0, 0.5],
        ['ocean_depth', 1.40, 1, 3],
    ],
    biomes: [
        ['wind_angle_deg', 0, 0, 360],
        ['raininess', 0.9, 0, 2],
        ['rain_shadow', 0.5, 0.1, 2],
        ['evaporation', 0.5, 0, 1],
    ],
    rivers: [
        ['lg_min_flow', 2.7, -5, 5],
        ['lg_river_width', -2.4, -5, 5],
        ['flow', 0.2, 0, 1],
    ],
    render: [
        ['zoom', 100/2000, 100/2000, 100/512],
        ['x', 2000, 0, 4000],
        ['y', 1000, 0, 2000],
        ['light_angle_deg', 80, 0, 360],
        ['slope', 2, 0, 5],
        ['flat', 2.5, 0, 5],
        ['ambient', 0.25, 0, 1],
        ['overhead', 30, 0, 60],
        ['tilt_deg', 0, 0, 90],
        ['rotate_deg', 0, -180, 180],
        ['mountain_height', 80, 0, 250],
        ['outline_depth', 1, 0, 2],
        ['outline_strength', 15, 0, 30],
        ['outline_threshold', 0, 0, 100],
        ['outline_coast', 0, 0, 1],
        ['outline_water', 13.0, 0, 20], // things start going wrong when this is high
        ['biome_colors', 1, 0, 1],
        ['country_strength', 0.5, 0, 1],
        ['country_borders', 1.0, 0, 1],
        ['road_strength', 1.0, 0, 2],
        ['tree_density', 1.0, 0, 2],
    ],
};

    
/**
 * Starts the UI and the tile-based world/render pipeline.
 */
function main() {
    const world = new WorldManager(getParam());
    const render = new Renderer(world, {canvasSize: baseParam.world.canvasSize});
    /* benchmark HUD + continuous rendering are opt-in (?bench=1); leaving
     * them off keeps the renderer demand-driven (no per-frame work when
     * nothing changed), which matters a lot on mobile */
    const benchParam = new URLSearchParams(window.location.search).get('bench');
    render.bench = new Bench(baseParam.benchmark.enabled || benchParam === '1');
    const cityManager = new CityManager();
    const cityUI = new CityUI(render, cityManager);
    render.cityUI = cityUI;

    /* set initial parameters */
    for (let phase of ['elevation', 'biomes', 'rivers', 'render']) {
        const container = document.createElement('div');
        const header = document.createElement('h3');
        header.appendChild(document.createTextNode(phase));
        container.appendChild(header);
        document.getElementById('sliders').appendChild(container);
        for (let [name, initialValue, min, max] of initialParams[phase]) {
            const step = name === 'seed'? 1 : 0.001;
            params.wild[phase][name] = initialValue;
            params.city[phase][name] = initialValue;

            let span = document.createElement('span');
            span.appendChild(document.createTextNode(name));
            
            let slider = document.createElement('input');
            slider.setAttribute('type', name === 'seed'? 'number' : 'range');
            slider.setAttribute('min', min);
            slider.setAttribute('max', max);
            slider.setAttribute('step', step.toString());
            slider.addEventListener('input', _event => {
                getParam()[phase][name] = slider.valueAsNumber;
                requestAnimationFrame(() => {
                    if (phase == 'render') { redraw(); }
                    else { envVersion[activeScene]++; generate(); }
                });
            });

            /* improve slider behavior on iOS */
            function handleTouch(event: TouchEvent) {
                let rect = slider.getBoundingClientRect();
                let value = (event.changedTouches[0].clientX - rect.left) / rect.width;
                value = min + value * (max - min);
                value = Math.round(value / step) * step;
                if (value < min) { value = min; }
                if (value > max) { value = max; }
                slider.value = value.toString();
                slider.dispatchEvent(new Event('input'));
                event.preventDefault();
                event.stopPropagation();
            };
            slider.addEventListener('touchmove', handleTouch);
            slider.addEventListener('touchstart', handleTouch);

            let label = document.createElement('label');
            label.setAttribute('id', `slider-${name}`);
            label.appendChild(span);
            label.appendChild(slider);

            /* road/tree densities are city-map only; hide their sliders */
            if (name === 'road_strength' || name === 'tree_density') {
                label.style.display = 'none';
            }

            container.appendChild(label);
            slider.value = initialValue;
        }
    }

    /* The city is its own fresh map: a different seed and a gentler,
     * flatter terrain so it reads as a city site. */
    params.city.elevation.seed = 424242;
    params.city.elevation.island = 0.5;
    params.city.elevation.hill_height = 0.005;
    /* buildings should tower over the flat ground, so use a small
     * vertical scale in the city scene */
    params.city.render.mountain_height = 4;

    /* scene toggle: switch between the wild world map and the city map */
    getParam().render.city_mode = 0;
    const cityContainer = document.createElement('div');
    cityContainer.setAttribute('id', 'city-mode-row');
    const cityButton = document.createElement('button');
    cityButton.setAttribute('id', 'button-city-mode');
    cityButton.textContent = '切换到城市地图';
    cityButton.addEventListener('click', () => {
        activeScene = activeScene === 'wild' ? 'city' : 'wild';
        getParam().render.city_mode = activeScene === 'city' ? 1 : 0;
        Painting.setScene(activeScene);
        cityButton.textContent = activeScene === 'city' ? '切回野外地图' : '切换到城市地图';
        syncSlidersToScene();
        generate();
    });
    cityContainer.appendChild(cityButton);
    /* city map entry is hidden; the button and its panel are not shown */
    cityContainer.style.display = 'none';
    document.getElementById('sliders').appendChild(cityContainer);

    /* reflect the active scene's parameters in the sliders */
    function syncSlidersToScene() {
        const p = getParam();
        for (let phase of ['elevation', 'biomes', 'rivers', 'render']) {
            for (let [name] of initialParams[phase]) {
                const input = document.querySelector(`#slider-${name} input`) as HTMLInputElement;
                if (input) { input.value = p[phase][name]; }
            }
        }
    }
    
    function redraw() {
        render.updateView(getParam().render);
    }

    /* Ask render module to copy WebGL into Canvas */
    function download() {
        render.screenshotCallback = () => {
            let a = document.createElement('a');
            render.screenshotCanvas.toBlob(blob => {
                // TODO: Firefox doesn't seem to allow a.click() to
                // download; is it everyone or just my setup?
                a.href = URL.createObjectURL(blob);
                a.setAttribute('download', `${activeScene}-${getParam().elevation.seed}.png`);
                a.click();
            });
        };
        render.updateView(getParam().render);
    }
    
    Painting.screenToWorldCoords = (coords) => {
        let out = render.screenToWorld(coords);
        let w = getParam().world.width, h = getParam().world.height;
        return [out[0] / w, out[1] / h];
    };

    const numWorkers = Math.max(1, getParam().world.maxWorkers ?? 4);
    const workers = Array.from({length: numWorkers}, () => new window.Worker("build/_worker.js"));
    let workerRR = 0;
    /* home worker per tile key — assigned on first request (round-robin),
     * then reused for every regeneration so the worker already holds the
     * cached mesh/Map/reference field and the regen takes the fast path */
    const tileWorker = new Map<string, number>();
    let initialized = false;
    let initializedCount = 0;

    for (const w of workers) {
        w.addEventListener('messageerror', event => {
            console.log("WORKER ERROR", event);
        });
        w.addEventListener('message', event => {
            const d = event.data;
            if (d.type === 'initDone') {
                initializedCount++;
                if (initializedCount >= workers.length) {
                    initialized = true;
                    redraw();
                }
                return;
            }
            if (d.type === 'tileReady') {
                const tile = world.tiles.get(d.key);
                if (!tile) return; /* tile was evicted while generating */
                /* Apply the data before markTileReady: a regeneration it
                 * triggers (state 'regen') must see the mesh we already
                 * hold so the re-request skips resending it. */
                if (!render.onTileReady(tile, d, {
                    borders: Painting.countryHasPainted(),
                    roads: d.scene === 'city',
                    buildings: d.scene === 'city',
                    trees: d.scene === 'city',
                    canopies: d.scene === 'wild',
                    autoObjects: getParam().city?.autoObjects ?? true,
                })) {
                    /* we no longer hold the geometry for this tile (evicted)
                     * but the worker wasn't asked for the mesh — mark for
                     * regeneration so the next update re-requests it */
                    tile.state = 'regen';
                }
                world.markTileReady(d.key, d);
                if (render.bench) render.bench.reportGen(d.elapsed);
                redraw();
            }
        });
    }

    /* Build the genTile message for a tile. */
    function genTileMessage(tile: Tile) {
        const p = getParam();
        Painting.setElevationParam(p.elevation);
        /* In the default flat-rectangle mode, force a flat valley floor
         * and no rivers without touching the slider values, so the
         * original terrain returns as soon as the user changes the seed. */
        const workerParam = Painting.isFlatDefault()
            ? {...p,
               elevation: {...p.elevation, noisy_coastlines: 0, hill_height: 0},
               rivers: {...p.rivers, flow: 0}}
            : p;
        return {
            type: 'genTile',
            key: tile.key,
            scene: activeScene,
            lod: tile.lod,
            tx: tile.tx,
            ty: tile.ty,
            genRect: tile.genRect,
            rect: tile.rect,
            refVersion: envVersion[activeScene],
            param: workerParam,
            /* the mesh never changes per tile key: ask the worker to ship it
             * only when we don't already hold the geometry (first request or
             * after an LRU eviction); regenerations send just the map arrays */
            needsMesh: !render.tileGeo.has(tile.key),
            constraints: {
                sizeW: Painting.size.w,
                sizeH: Painting.size.h,
                constraints: Painting.constraints,
                country: Painting.country,
                city: Painting.city,
                objects: Painting.objects,
                terrain: Painting.terrain,
            },
        };
    }

    /* Request generation of a tile. The first time a tile key is seen it
     * goes round-robin to pick a home worker; every subsequent request
     * (regeneration after painting, re-request after eviction) goes back
     * to that same worker, which already holds the cached mesh, Map and
     * reference field — so regenerations always take the fast path. */
    world.onRequestTile = (tile: Tile) => {
        if (!initialized) return;
        let w = tileWorker.get(tile.key);
        if (w === undefined) {
            w = workerRR++ % workers.length;
            tileWorker.set(tile.key, w);
        }
        workers[w].postMessage(genTileMessage(tile));
    };

    /* Drop the tile's GPU buffers + geometry when evicted from the cache. */
    world.onTileEvicted = (tile: Tile) => {
        render.releaseTile(tile);
    };

    function updateUI() {
        let userHasPainted = Painting.userHasPainted();
        let countryHasPainted = Painting.countryHasPainted();
        let cityHasPainted = Painting.cityHasPainted();
        let objectsHasPainted = Painting.objectsHasPainted();
        let terrainHasPainted = Painting.terrainHasPainted();
        (document.querySelector("#slider-seed input") as HTMLInputElement).disabled = userHasPainted;
        (document.querySelector("#slider-island input") as HTMLInputElement).disabled = userHasPainted;
        (document.querySelector("#button-reset") as HTMLInputElement).disabled = !(userHasPainted || countryHasPainted || cityHasPainted || objectsHasPainted || terrainHasPainted);
    }
    
    /* Invalidate the viewport's tiles and redraw; used when painting or
     * terrain parameters change. Only the visible tiles are regenerated. */
    function generate() {
        const rp = getParam().render;
        const visibleW = 200 / rp.zoom;
        world.invalidateRect([rp.x - visibleW/2, rp.y - visibleW/2, visibleW, visibleW]);
        render.setCountryNames(Painting.countryNames);
        updateUI();
        redraw();
    }

        /* Painting fires onUpdate for every pointer move. The original mapgen4
     * feel is that the real terrain follows the brush: regenerate in rounds
     * while painting (never more than one round in flight, so the workers
     * aren't flooded and results stay ordered), and keep showing the last
     * data until each round lands. The colored preview overlay is optional
     * (config lod.paintPreview). */
    Painting.previewEnabled = baseParam.lod.paintPreview ?? false;
    let paintTimer: number | null = null;
    let paintDirty = false; /* the canvas holds paint no round has picked up yet */
    Painting.onUpdate = () => {
        if (Painting.previewEnabled) redraw(); // instant overlay feedback
        paintDirty = true;
        if (paintTimer === null && !world.hasPendingWork()) {
            paintTimer = window.setTimeout(() => {
                paintTimer = null;
                paintDirty = false;
                generate();
            }, getParam().lod.paintDebounceMs ?? 30);
        }
    };
    /* Stroke finished. Two savings:
     * 1. Only bump envVersion when the reference field can affect the
     *    output — with constant rainfall and the local river chain off,
     *    the reference (rainfall lookup + river seeding) is invariant
     *    under painting, so the catch-up round can reuse the cached
     *    field instead of every worker rebuilding the whole-world map.
     * 2. Skip the catch-up regen entirely when the last round already
     *    reflects the canvas, so lifting the pen doesn't leave a round
     *    in flight that would block the next stroke's first feedback. */
    Painting.onStrokeEnd = () => {
        const p = getParam();
        if (p.lod?.localRivers !== false || p.biomes?.constantRainfall == null) {
            envVersion[activeScene]++;
        }
        const pending = paintTimer !== null || paintDirty;
        if (paintTimer !== null) { clearTimeout(paintTimer); paintTimer = null; }
        paintDirty = false;
        if (pending) generate();
    };

    render.setCountryNames(Painting.countryNames);

    /* Kick off the workers with the world/lod configuration. */
    const p = getParam();
    for (const w of workers) {
        w.postMessage({
            type: 'init',
            world: p.world,
            lod: p.lod,
            meshSeed: p.mesh.seed,
            mountainSpacing: p.world.mountainSpacing,
        });
    }

    const downloadButton = document.getElementById('button-download');
    if (downloadButton) downloadButton.addEventListener('click', download);

    /* ---- export / import map state ---- */
    function exportState() {
        const data = {
            activeScene,
            params: params,
            scenes: Painting.dumpScenes(),
            cities: cityManager.toJSON(),
        };
        const blob = new Blob([JSON.stringify(data)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.setAttribute('download', 'mapgen4-save.json');
        a.click();
        URL.revokeObjectURL(url);
    }

    function importState(file: File) {
        file.text().then(text => {
            const data = JSON.parse(text);
            if (!data || !data.params || !data.scenes) { throw "bad save file"; }
            params.wild = Object.assign({}, baseParam, data.params.wild);
            params.city = Object.assign({}, baseParam, data.params.city);
            Painting.loadScenes(data.scenes);
            activeScene = 'wild';
            getParam().render.city_mode = 0;
            Painting.setScene(activeScene);
            syncSlidersToScene();
            cityManager.fromJSON(data.cities);
            cityUI.selectedCityId = null;
            cityUI.rebuild();
            envVersion.wild++; envVersion.city++;
            generate();
        }).catch(err => {
            console.error("import failed", err);
            alert("导入失败：文件格式不正确");
        });
    }

    const exportButton = document.createElement('button');
    exportButton.setAttribute('id', 'button-export');
    exportButton.textContent = '导出地图';
    exportButton.addEventListener('click', exportState);

    const importButton = document.createElement('button');
    importButton.setAttribute('id', 'button-import');
    importButton.textContent = '导入地图';
    const fileInput = document.createElement('input');
    fileInput.setAttribute('type', 'file');
    fileInput.setAttribute('accept', '.json');
    fileInput.style.display = 'none';
    importButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files[0]) { importState(fileInput.files[0]); }
        fileInput.value = '';
    });

    const ioRow = document.createElement('div');
    ioRow.setAttribute('id', 'io-row');
    ioRow.appendChild(exportButton);
    ioRow.appendChild(importButton);
    ioRow.appendChild(fileInput);
    document.getElementById('sliders').appendChild(ioRow);
}

main();
