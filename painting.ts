/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2018 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * This module allows the user to paint constraints for the map generator
 */

/*
 * The painting interface uses a square array of elevations. As you
 * drag the mouse it will paint filled circles into the elevation map,
 * then send the elevation map to the generator to produce the output.
 */

import {createNoise2D} from 'simplex-noise';
import {makeRandFloat} from '@redblobgames/prng';
import {TERRAIN_NONE, TERRAIN_SNOW, TERRAIN_GRASS, TERRAIN_FOREST, TERRAIN_DESERT, TERRAIN_DIRT} from "./terrains.ts";
import {NUM_COUNTRIES, countryPalette} from "./countries.ts";

const CANVAS_WIDTH = 256;
const CANVAS_HEIGHT = 128;

const currentStroke = {
    /* elevation before the current paint stroke began */
    previousElevation: new Float32Array(CANVAS_WIDTH * CANVAS_HEIGHT),
    /* how long, in milliseconds, was spent painting */
    time: new Float32Array(CANVAS_WIDTH * CANVAS_HEIGHT),
    /* maximum strength applied */
    strength: new Float32Array(CANVAS_WIDTH * CANVAS_HEIGHT),
};


/* The elevation is -1.0 to 0.0 → water, 0.0 to +1.0 → land */
class Generator {
    seed = 0;
    island = 0;
    userHasPainted = false;
    terrainHasPainted = false;
    countryHasPainted = false;
    elevation: Float32Array;
    terrain: Float32Array;
    country: Float32Array;
    
    constructor () {
        this.elevation = new Float32Array(CANVAS_WIDTH * CANVAS_HEIGHT);
        this.terrain = new Float32Array(CANVAS_WIDTH * CANVAS_HEIGHT);
        this.country = new Float32Array(CANVAS_WIDTH * CANVAS_HEIGHT).fill(-1);
    }

    setElevationParam(elevationParam) {
        if (   elevationParam.seed   !== this.seed
            || elevationParam.island !== this.island) {
            this.seed   = elevationParam.seed;
            this.island = elevationParam.island;
            this.generate();
        }
    }
    
    /** Use a noise function to determine the shape */
    generate() {
        const {elevation, island} = this;
        const noise2D = createNoise2D(makeRandFloat(this.seed));
        const persistence = 1/2;
        const amplitudes = Array.from({length: 5}, (_, octave) => Math.pow(persistence, octave));

        function fbm_noise(nx, ny) {
            let sum = 0, sumOfAmplitudes = 0;
            for (let octave = 0; octave < amplitudes.length; octave++) {
                let frequency = 1 << octave;
                sum += amplitudes[octave] * noise2D(nx * frequency, ny * frequency);
                sumOfAmplitudes += amplitudes[octave];
            }
            return sum / sumOfAmplitudes;
        }

        for (let y = 0; y < CANVAS_HEIGHT; y++) {
            for (let x = 0; x < CANVAS_WIDTH; x++) {
                let p = y * CANVAS_WIDTH + x;
                let nx = 2 * x/CANVAS_WIDTH - 1,
                    ny = 2 * y/CANVAS_HEIGHT - 1;
                let distance = Math.max(Math.abs(nx), Math.abs(ny));
            let e = 0.5 * (fbm_noise(nx, ny) + island * (0.75 - 2 * distance * distance));
            if (e < -1.0) { e = -1.0; }
            if (e > +1.0) { e = +1.0; }
            elevation[p] = e > 0.0 ? TOOLS.valley.elevation : e;
            }
        }

        this.userHasPainted = false;
        this.terrain.fill(0);
        this.terrainHasPainted = false;
        this.country.fill(-1);
        this.countryHasPainted = false;
    }

    /**
     * Paint a circular region. x0, y0 should be 0 to 1
     */
    paintAt(tool: { elevation: number; },
            x0: number, y0: number,
            size: { innerRadius: number; outerRadius: number; rate: number; },
            deltaTimeInMs: number) {
        let {elevation} = this;
        /* This has two effects: first time you click the mouse it has a
         * strong effect, and it also limits the amount in case you
         * pause */
        deltaTimeInMs = Math.min(100, deltaTimeInMs);

        let newElevation = tool.elevation;
        let {innerRadius, outerRadius, rate} = size;
        let xc = (x0 * CANVAS_WIDTH) | 0, yc = (y0 * CANVAS_HEIGHT) | 0;
        let top = Math.ceil(Math.max(0, yc - outerRadius)),
            bottom = Math.floor(Math.min(CANVAS_HEIGHT-1, yc + outerRadius));
        for (let y = top; y <= bottom; y++) {
            let s = Math.sqrt(outerRadius * outerRadius - (y - yc) * (y - yc)) | 0;
            let left = Math.max(0, xc - s),
                right = Math.min(CANVAS_WIDTH-1, xc + s);
            for (let x = left; x <= right; x++) {
                let p = y * CANVAS_WIDTH + x;
                let distance = Math.sqrt((x - xc) * (x - xc) + (y - yc) * (y - yc));
                let strength = 1.0 - Math.min(1, Math.max(0, (distance - innerRadius) / (outerRadius - innerRadius)));
                let factor = rate/1000 * deltaTimeInMs;
                currentStroke.time[p] += strength * factor;
                if (strength > currentStroke.strength[p]) {
                    currentStroke.strength[p] = (1 - factor) * currentStroke.strength[p] + factor * strength;
                }
                let mix = currentStroke.strength[p] * Math.min(1, currentStroke.time[p]);
                elevation[p] = (1 - mix) * currentStroke.previousElevation[p] + mix * newElevation;
            }
        }

        this.userHasPainted = true;
    }

    /**
     * Stamp an explicit terrain type (e.g. snow) onto a disc. Painted
     * terrain overrides the automatic biome coloring for those regions.
     * When minElevation is given, the label is only stamped where the
     * elevation constraint has already risen past it — used by the snow
     * brush so the white label doesn't race ahead of the mountain relief
     * (paintAt accumulates elevation slowly, especially on fast
     * strokes; without the gate a quick swipe stamps full snow on flat
     * land and renders white before any mountain has formed).
     */
    paintTerrainAt(terrainType: number, x0: number, y0: number, outerRadius: number, minElevation?: number) {
        let {terrain, elevation} = this;
        // terrain values are stored spaced apart (0=auto, 4=snow, 8=grass,
        // 12=forest, 16=desert, 20=dirt) so bilinear sampling between two
        // labels never lands on a third label.
        const encoded = 4 * terrainType;
        const gate = minElevation ?? -Infinity;
        let xc = (x0 * CANVAS_WIDTH) | 0, yc = (y0 * CANVAS_HEIGHT) | 0;
        let top = Math.ceil(Math.max(0, yc - outerRadius)),
            bottom = Math.floor(Math.min(CANVAS_HEIGHT-1, yc + outerRadius));
        for (let y = top; y <= bottom; y++) {
            let s = Math.sqrt(outerRadius * outerRadius - (y - yc) * (y - yc)) | 0;
            let left = Math.max(0, xc - s),
                right = Math.min(CANVAS_WIDTH-1, xc + s);
            for (let x = left; x <= right; x++) {
                const p = y * CANVAS_WIDTH + x;
                if (elevation[p] >= gate) {
                    terrain[p] = encoded;
                }
            }
        }

        this.terrainHasPainted = true;
    }

    /**
     * Stamp the current country id onto a constant-filled disc. x0, y0
     * should be 0 to 1; radius is the brush size in canvas texels.
     */
    paintCountryAt(countryId: number, x0: number, y0: number, outerRadius: number) {
        let {country} = this;
        let xc = (x0 * CANVAS_WIDTH) | 0, yc = (y0 * CANVAS_HEIGHT) | 0;
        let top = Math.ceil(Math.max(0, yc - outerRadius)),
            bottom = Math.floor(Math.min(CANVAS_HEIGHT-1, yc + outerRadius));
        for (let y = top; y <= bottom; y++) {
            let s = Math.sqrt(outerRadius * outerRadius - (y - yc) * (y - yc)) | 0;
            let left = Math.max(0, xc - s),
                right = Math.min(CANVAS_WIDTH-1, xc + s);
            for (let x = left; x <= right; x++) {
                country[y * CANVAS_WIDTH + x] = countryId;
            }
        }

        this.countryHasPainted = true;
    }
}
let heightMap = new Generator();

const countryNames: string[] = new Array(NUM_COUNTRIES).fill('');

const MAX_UNDO = 10;
type Snapshot = { elevation: Float32Array; terrain: Float32Array; country: Float32Array };
const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];

function pushSnapshot(stack: Snapshot[]) {
    stack.push({
        elevation: Float32Array.from(heightMap.elevation),
        terrain: Float32Array.from(heightMap.terrain),
        country: Float32Array.from(heightMap.country),
    });
    if (stack.length > MAX_UNDO) { stack.shift(); }
}

function updateUndoRedoButtons() {
    (document.getElementById('button-undo') as HTMLButtonElement).disabled = undoStack.length === 0;
    (document.getElementById('button-redo') as HTMLButtonElement).disabled = redoStack.length === 0;
}

let exported = {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    onUpdate: () => {},
    screenToWorldCoords: coords => coords,
    constraints: heightMap.elevation,
    terrain: heightMap.terrain,
    country: heightMap.country,
    countryNames,
    setElevationParam: elevationParam => heightMap.setElevationParam(elevationParam),
    userHasPainted: () => heightMap.userHasPainted,
    terrainHasPainted: () => heightMap.terrainHasPainted,
    countryHasPainted: () => heightMap.countryHasPainted,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undo: () => {
        if (undoStack.length === 0) return;
        pushSnapshot(redoStack);
        const s = undoStack.pop() as Snapshot;
        heightMap.elevation.set(s.elevation);
        heightMap.terrain.set(s.terrain);
        heightMap.country.set(s.country);
        heightMap.userHasPainted = undoStack.length > 0;
        heightMap.terrainHasPainted = heightMap.terrain.some(v => v > 0);
        heightMap.countryHasPainted = heightMap.country.some(v => v >= 0);
        updateUndoRedoButtons();
        exported.onUpdate();
    },
    redo: () => {
        if (redoStack.length === 0) return;
        pushSnapshot(undoStack);
        const s = redoStack.pop() as Snapshot;
        heightMap.elevation.set(s.elevation);
        heightMap.terrain.set(s.terrain);
        heightMap.country.set(s.country);
        heightMap.userHasPainted = true;
        heightMap.terrainHasPainted = heightMap.terrain.some(v => v > 0);
        heightMap.countryHasPainted = heightMap.country.some(v => v >= 0);
        updateUndoRedoButtons();
        exported.onUpdate();
    },
    /* Serialize the painting state (constraint canvases, country names
     * and flags) for the save/load feature. */
    dumpScenes: () => ({
        wild: {
            seed: heightMap.seed,
            island: heightMap.island,
            elevation: Array.from(heightMap.elevation),
            country: Array.from(heightMap.country),
            terrain: Array.from(heightMap.terrain),
            names: countryNames.slice(),
            userHasPainted: heightMap.userHasPainted,
            countryHasPainted: heightMap.countryHasPainted,
            terrainHasPainted: heightMap.terrainHasPainted,
        },
    }),
    loadScenes: (data: any) => {
        const d = data?.wild;
        if (!d) return;
        heightMap.seed = d.seed;
        heightMap.island = d.island;
        heightMap.elevation.set(d.elevation);
        heightMap.country.set(d.country);
        heightMap.terrain.set(d.terrain);
        for (let i = 0; i < NUM_COUNTRIES; i++) countryNames[i] = (d.names ?? [])[i] ?? '';
        heightMap.userHasPainted = d.userHasPainted;
        heightMap.countryHasPainted = d.countryHasPainted;
        heightMap.terrainHasPainted = d.terrainHasPainted;
        /* refresh country name inputs */
        for (let i = 0; i < NUM_COUNTRIES; i++) {
            const input = document.getElementById(`country-name-${i}`) as HTMLInputElement;
            if (input) input.value = countryNames[i];
        }
        /* imported state replaces the history */
        undoStack.length = 0;
        redoStack.length = 0;
        updateUndoRedoButtons();
    },
};

document.getElementById('button-reset').addEventListener('click', () => {
    heightMap.generate();
    exported.onUpdate();
});

document.getElementById('button-undo').addEventListener('click', () => { exported.undo(); });
document.getElementById('button-redo').addEventListener('click', () => { exported.redo(); });
updateUndoRedoButtons();


const SIZES = {
    // rate is effect per second
    mini:   {key: '0', rate: 5, innerRadius: 0.5, outerRadius: 0.75},
    tiny:   {key: '1', rate: 4.5, innerRadius: 1.5, outerRadius: 2.5},
    small:  {key: '2', rate: 4, innerRadius: 2, outerRadius: 6},
    medium: {key: '3', rate: 2.5, innerRadius: 5, outerRadius: 10},
    large:  {key: '4', rate: 1.5, innerRadius: 10, outerRadius: 16},
};

const TOOLS = {
    ocean:    {elevation: -0.25},
    shallow:  {elevation: -0.05},
    valley:   {elevation: +0.05},
    mountain: {elevation: +1.0},
};

/* Terrain brushes: paint an explicit terrain type (snow, grass, ...)
 * over the wild map, overriding the automatic biome colors. Snow also
 * raises the elevation (like the mountain brush) so it gets real
 * mountain relief; the others keep the land low (like the valley
 * brush). minElevation gates the snow label so it doesn't outpace the
 * slowly-accumulating mountain relief. */
const TERRAIN_TOOLS = [
    {key: 'snow',   label: 'snow',   type: TERRAIN_SNOW,   elevation: +1.0, minElevation: 0.3},
    {key: 'grass',  label: 'grass',  type: TERRAIN_GRASS,  elevation: +0.05},
    {key: 'forest', label: 'forest', type: TERRAIN_FOREST, elevation: +0.1},
    {key: 'desert', label: 'desert', type: TERRAIN_DESERT, elevation: +0.05},
    {key: 'dirt',   label: 'dirt',   type: TERRAIN_DIRT,   elevation: +0.05},
];
const TERRAIN_TOOL_KEYS = TERRAIN_TOOLS.map(t => t.key);

let currentTool = 'mountain';
let currentSize = 'small';

function displayCurrentTool() {
    const className = 'current-control';
    for (let c of document.querySelectorAll("."+className)) {
        c.classList.remove(className);
    }
    if (currentTool === 'country') {
        document.getElementById(`country-${currentCountry}`).classList.add(className);
    } else {
        document.getElementById(currentTool).classList.add(className);
    }
    document.getElementById(currentSize).classList.add(className);
}

const controls: [string, string, () => void][] = [
    ['0', "mini",     () => { currentSize = 'mini'; }],
    ['1', "tiny",     () => { currentSize = 'tiny'; }],
    ['2', "small",    () => { currentSize = 'small'; }],
    ['3', "medium",   () => { currentSize = 'medium'; }],
    ['4', "large",    () => { currentSize = 'large'; }],
    ['q', "ocean",    () => { currentTool = 'ocean'; }],
    ['w', "shallow",  () => { currentTool = 'shallow'; }],
    ['e', "valley",   () => { currentTool = 'valley'; }],
    ['r', "mountain", () => { currentTool = 'mountain'; }],
];

window.addEventListener('keydown', e => {
    for (let control of controls) {
        if (e.key === control[0]) { control[2](); displayCurrentTool(); }
    }
});

window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const mod = e.metaKey || e.ctrlKey;
    const undo = mod && !e.shiftKey && e.key.toLowerCase() === 'z';
    const redo = mod && ((e.shiftKey && e.key.toLowerCase() === 'z') || (!e.shiftKey && e.key.toLowerCase() === 'y'));
    if (undo) { e.preventDefault(); exported.undo(); }
    else if (redo) { e.preventDefault(); exported.redo(); }
});

for (let control of controls) {
    document.getElementById(control[1]).addEventListener('click', () => { control[2](); displayCurrentTool(); } );
}

/* terrain brush buttons (snow/grass/forest/desert/dirt) in embed.html */
for (let t of TERRAIN_TOOLS) {
    document.getElementById(t.key).addEventListener('click', () => { currentTool = t.key; displayCurrentTool(); } );
}

/* Country brushes: clicking a swatch selects that country and switches
 * the active tool to country painting. Each row also has a text input
 * for the country name, shown on the map once the country is painted. */
let currentCountry = 0;
const countryToolbar = document.getElementById('countries');
for (let i = 0; i < NUM_COUNTRIES; i++) {
    const [r, g, b] = countryPalette[i];
    const row = document.createElement('div');
    row.setAttribute('class', 'country-row');

    const btn = document.createElement('button');
    btn.setAttribute('id', `country-${i}`);
    btn.setAttribute('title', `country ${i+1} (paint with this brush)`);
    btn.style.background = `rgb(${255*r|0},${255*g|0},${255*b|0})`;
    btn.addEventListener('click', () => {
        currentTool = 'country';
        currentCountry = i;
        displayCurrentTool();
    });

    const input = document.createElement('input');
    input.setAttribute('id', `country-name-${i}`);
    input.setAttribute('type', 'text');
    input.setAttribute('placeholder', 'name');
    input.addEventListener('input', () => {
        countryNames[i] = input.value;
        exported.onUpdate();
    });

    row.appendChild(btn);
    row.appendChild(input);
    countryToolbar.appendChild(row);
}
displayCurrentTool();


function setUpPaintEventHandling() {
    const el = document.getElementById('mapgen4');
    let dragging = false;
    let timestamp = 0;
    
    function start(event: PointerEvent) {
        if (event.button !== 0) return; // left button only
        el.setPointerCapture(event.pointerId);
        
        dragging = true;
        timestamp = Date.now();
        currentStroke.time.fill(0);
        currentStroke.strength.fill(0);
        currentStroke.previousElevation.set(heightMap.elevation);
        pushSnapshot(undoStack);
        redoStack.length = 0;
        updateUndoRedoButtons();
        move(event);
    }

    function end(_event) {
        dragging = false;
    }

    function move(event: PointerEvent) {
        if (!dragging) return;

        const nowMs = Date.now();
        const bounds = el.getBoundingClientRect();
        let coords = [
            (event.x - bounds.left) / bounds.width,
            (event.y - bounds.top) / bounds.height,
        ];
        coords = exported.screenToWorldCoords(coords);
        let brushSize = SIZES[currentSize];
        if (event.pointerType === 'pen' && event.pressure !== 0.5) {
            // Pointer Event spec says 0.5 sent when pen does not
            // support pressure; I primarily added this for Apple
            // Pencil but haven't tested on others. I want pressure
            // 0.25 to correspond to "regular" pressure for the given
            // brush size, so radius should be 1.0. I am *not*
            // currently supporting Macbook pressure-sensitive
            // touchpads, which don't show up under Pointer Events.
            // https://developer.mozilla.org/en-US/docs/Web/API/Force_Touch_events
            let radius = 2 * Math.sqrt(event.pressure);
            brushSize = {
                key: brushSize.key,
                innerRadius: Math.max(1, brushSize.innerRadius * radius),
                outerRadius: Math.max(2, brushSize.outerRadius * radius),
                rate: brushSize.rate,
            };
        }
        if (event.shiftKey) {
            // Hold down shift to paint slowly
            brushSize = {...brushSize, rate: brushSize.rate/4};
        }
        if (currentTool === 'country') {
            // Countries stamp the selected country id as a constant
            // disc, so moving the brush edits the borders directly.
            heightMap.paintCountryAt(currentCountry, coords[0], coords[1], brushSize.outerRadius);
        } else {
            const terrainTool = TERRAIN_TOOL_KEYS.includes(currentTool)
                ? TERRAIN_TOOLS.find(t => t.key === currentTool) : undefined;
            if (terrainTool) {
                // Terrain brushes also raise/lower the elevation so the
                // painted terrain matches the relief (snow raises it like
                // mountains, grass/desert/dirt keep it low like valleys).
                heightMap.paintAt({elevation: terrainTool.elevation}, coords[0], coords[1],
                                  brushSize, nowMs - timestamp);
                heightMap.paintTerrainAt(terrainTool.type, coords[0], coords[1],
                                         brushSize.outerRadius, terrainTool.minElevation);
            } else {
                // Original terrain brushes also clear any explicit terrain
                // type (snow/grass/...) so their colors cover the painted area.
                heightMap.paintTerrainAt(TERRAIN_NONE, coords[0], coords[1], brushSize.outerRadius);
                heightMap.paintAt(TOOLS[currentTool], coords[0], coords[1],
                                  brushSize, nowMs - timestamp);
            }
        }
        timestamp = nowMs;
        exported.onUpdate();
    }
        
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointermove', move)
    el.addEventListener('touchstart', (e) => e.preventDefault()); // prevent scroll
}
setUpPaintEventHandling();



export default exported;
