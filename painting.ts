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
import {NUM_COUNTRIES, countryPalette} from "./countries.ts";
import {
    CITY_NONE, CITY_WATER, CITY_PARK, CITY_RESIDENTIAL, CITY_COMMERCIAL, cityPalette,
    OBJ_NONE, OBJ_ROAD, OBJ_BUILDING, OBJ_TREE,
} from "./city.ts";
import {TERRAIN_NONE, TERRAIN_SNOW, TERRAIN_GRASS, TERRAIN_FOREST, TERRAIN_DESERT, NUM_TERRAINS} from "./terrains.ts";

const CANVAS_SIZE = 128;

const currentStroke = {
    /* elevation before the current paint stroke began */
    previousElevation: new Float32Array(CANVAS_SIZE * CANVAS_SIZE),
    /* how long, in milliseconds, was spent painting */
    time: new Float32Array(CANVAS_SIZE * CANVAS_SIZE),
    /* maximum strength applied */
    strength: new Float32Array(CANVAS_SIZE * CANVAS_SIZE),
};


/* The elevation is -1.0 to 0.0 → water, 0.0 to +1.0 → land */
class Generator {
    seed = 0;
    island = 0;
    userHasPainted = false;
    elevation: Float32Array;
    country: Float32Array;
    countryHasPainted = false;
    city: Float32Array;
    cityHasPainted = false;
    objects: Float32Array;
    objectsHasPainted = false;
    terrain: Float32Array;
    terrainHasPainted = false;
    
    constructor () {
        this.elevation = new Float32Array(CANVAS_SIZE * CANVAS_SIZE);
        // -1 means "no country"; otherwise a country palette index
        this.country = new Float32Array(CANVAS_SIZE * CANVAS_SIZE).fill(-1);
        // -1 means "not painted"; otherwise a city zone index
        this.city = new Float32Array(CANVAS_SIZE * CANVAS_SIZE).fill(-1);
        // 0 = automatic, -1 = erased, otherwise an object bitmask
        this.objects = new Float32Array(CANVAS_SIZE * CANVAS_SIZE).fill(0);
        // 0 = automatic; otherwise an explicit terrain type (e.g. snow)
        this.terrain = new Float32Array(CANVAS_SIZE * CANVAS_SIZE).fill(0);
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

        for (let y = 0; y < CANVAS_SIZE; y++) {
            for (let x = 0; x < CANVAS_SIZE; x++) {
                let p = y * CANVAS_SIZE + x;
                let nx = 2 * x/CANVAS_SIZE - 1,
                    ny = 2 * y/CANVAS_SIZE - 1;
                let distance = Math.max(Math.abs(nx), Math.abs(ny));
                let e = 0.5 * (fbm_noise(nx, ny) + island * (0.75 - 2 * distance * distance));
                if (e < -1.0) { e = -1.0; }
                if (e > +1.0) { e = +1.0; }
                elevation[p] = e;
                if (e > 0.0) {
                    let m = (0.5 * noise2D(nx + 30, ny + 50)
                             + 0.5 * noise2D(2*nx + 33, 2*ny + 55));
                    // TODO: make some of these into parameters
                    let mountain = Math.min(1.0, e * 5.0) * (1 - Math.abs(m) / 0.5);
                    if (mountain > 0.0) {
                        elevation[p] = Math.max(e, Math.min(e * 3, mountain));
                    }
                }
            }
        }

        this.userHasPainted = false;
        this.country.fill(-1);
        this.countryHasPainted = false;
        this.city.fill(-1);
        this.cityHasPainted = false;
        this.objects.fill(0);
        this.objectsHasPainted = false;
        this.terrain.fill(0);
        this.terrainHasPainted = false;
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
        let xc = (x0 * CANVAS_SIZE) | 0, yc = (y0 * CANVAS_SIZE) | 0;
        let top = Math.ceil(Math.max(0, yc - outerRadius)),
            bottom = Math.floor(Math.min(CANVAS_SIZE-1, yc + outerRadius));
        for (let y = top; y <= bottom; y++) {
            let s = Math.sqrt(outerRadius * outerRadius - (y - yc) * (y - yc)) | 0;
            let left = Math.max(0, xc - s),
                right = Math.min(CANVAS_SIZE-1, xc + s);
            for (let x = left; x <= right; x++) {
                let p = y * CANVAS_SIZE + x;
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
     * Stamp the current country id onto a constant-filled disc. x0, y0
     * should be 0 to 1; radius is the brush size in canvas texels.
     */
    paintCountryAt(countryId: number, x0: number, y0: number, outerRadius: number) {
        let {country} = this;
        let xc = (x0 * CANVAS_SIZE) | 0, yc = (y0 * CANVAS_SIZE) | 0;
        let top = Math.ceil(Math.max(0, yc - outerRadius)),
            bottom = Math.floor(Math.min(CANVAS_SIZE-1, yc + outerRadius));
        for (let y = top; y <= bottom; y++) {
            let s = Math.sqrt(outerRadius * outerRadius - (y - yc) * (y - yc)) | 0;
            let left = Math.max(0, xc - s),
                right = Math.min(CANVAS_SIZE-1, xc + s);
            for (let x = left; x <= right; x++) {
                country[y * CANVAS_SIZE + x] = countryId;
            }
        }

        this.countryHasPainted = true;
    }

    /**
     * Stamp a city zone onto a constant-filled disc. x0, y0 should be
     * 0 to 1; radius is the brush size in canvas texels.
     */
    paintCityAt(zone: number, x0: number, y0: number, outerRadius: number) {
        let {city} = this;
        let xc = (x0 * CANVAS_SIZE) | 0, yc = (y0 * CANVAS_SIZE) | 0;
        let top = Math.ceil(Math.max(0, yc - outerRadius)),
            bottom = Math.floor(Math.min(CANVAS_SIZE-1, yc + outerRadius));
        for (let y = top; y <= bottom; y++) {
            let s = Math.sqrt(outerRadius * outerRadius - (y - yc) * (y - yc)) | 0;
            let left = Math.max(0, xc - s),
                right = Math.min(CANVAS_SIZE-1, xc + s);
            for (let x = left; x <= right; x++) {
                city[y * CANVAS_SIZE + x] = zone;
            }
        }

        this.cityHasPainted = true;
    }

    /**
     * Stamp a forced object bit (road/building/tree) onto a disc.
     * Painted objects override the automatic zone-based placement.
     * The object's forbidden bit is cleared so it can appear again.
     */
    paintObjectAt(mask: number, x0: number, y0: number, outerRadius: number) {
        let {objects} = this;
        let xc = (x0 * CANVAS_SIZE) | 0, yc = (y0 * CANVAS_SIZE) | 0;
        let top = Math.ceil(Math.max(0, yc - outerRadius)),
            bottom = Math.floor(Math.min(CANVAS_SIZE-1, yc + outerRadius));
        for (let y = top; y <= bottom; y++) {
            let s = Math.sqrt(outerRadius * outerRadius - (y - yc) * (y - yc)) | 0;
            let left = Math.max(0, xc - s),
                right = Math.min(CANVAS_SIZE-1, xc + s);
            for (let x = left; x <= right; x++) {
                let v = objects[y * CANVAS_SIZE + x];
                let forbidden = (v >> 4) & 0xF;
                let forced = (v & 0xF) | mask;
                objects[y * CANVAS_SIZE + x] = ((forbidden & ~mask) << 4) | forced;
            }
        }

        this.objectsHasPainted = true;
    }

    /**
     * Stamp a forbidden object bit onto a disc: the object is removed
     * and will not reappear automatically.
     */
    eraseObjectAt(mask: number, x0: number, y0: number, outerRadius: number) {
        let {objects} = this;
        let xc = (x0 * CANVAS_SIZE) | 0, yc = (y0 * CANVAS_SIZE) | 0;
        let top = Math.ceil(Math.max(0, yc - outerRadius)),
            bottom = Math.floor(Math.min(CANVAS_SIZE-1, yc + outerRadius));
        for (let y = top; y <= bottom; y++) {
            let s = Math.sqrt(outerRadius * outerRadius - (y - yc) * (y - yc)) | 0;
            let left = Math.max(0, xc - s),
                right = Math.min(CANVAS_SIZE-1, xc + s);
            for (let x = left; x <= right; x++) {
                let v = objects[y * CANVAS_SIZE + x];
                let forbidden = ((v >> 4) & 0xF) | mask;
                let forced = (v & 0xF) & ~mask;
                objects[y * CANVAS_SIZE + x] = (forbidden << 4) | forced;
            }
        }

        this.objectsHasPainted = true;
    }

    /**
     * Stamp an explicit terrain type (e.g. snow) onto a disc. Painted
     * terrain overrides the automatic biome coloring for those regions.
     */
    paintTerrainAt(terrainType: number, x0: number, y0: number, outerRadius: number) {
        let {terrain} = this;
        let xc = (x0 * CANVAS_SIZE) | 0, yc = (y0 * CANVAS_SIZE) | 0;
        let top = Math.ceil(Math.max(0, yc - outerRadius)),
            bottom = Math.floor(Math.min(CANVAS_SIZE-1, yc + outerRadius));
        for (let y = top; y <= bottom; y++) {
            let s = Math.sqrt(outerRadius * outerRadius - (y - yc) * (y - yc)) | 0;
            let left = Math.max(0, xc - s),
                right = Math.min(CANVAS_SIZE-1, xc + s);
            for (let x = left; x <= right; x++) {
                terrain[y * CANVAS_SIZE + x] = terrainType;
            }
        }

        this.terrainHasPainted = true;
    }
}

/* Each scene (wild / city) is a completely independent map: its own
 * constraint canvases and country names. The active scene's generator
 * is what painting/exported operate on. */
type SceneName = 'wild' | 'city';
const scenes: { [scene in SceneName]: { gen: Generator; names: string[] } } = {
    wild: { gen: new Generator(), names: Array.from({length: NUM_COUNTRIES}, () => '') },
    city: { gen: new Generator(), names: Array.from({length: NUM_COUNTRIES}, () => '') },
};
let activeScene: SceneName = 'wild';
const g = () => scenes[activeScene].gen;
const sceneNames = () => scenes[activeScene].names;

let exported = {
    size: CANVAS_SIZE,
    onUpdate: () => {},
    screenToWorldCoords: coords => coords,
    setElevationParam: elevationParam => g().setElevationParam(elevationParam),
    userHasPainted: () => g().userHasPainted,
    countryHasPainted: () => g().countryHasPainted,
    cityHasPainted: () => g().cityHasPainted,
    objectsHasPainted: () => g().objectsHasPainted,
    terrainHasPainted: () => g().terrainHasPainted,
    setScene: (scene: SceneName) => { setScene(scene); },
};
/* The active scene's constraint arrays are exposed as live getters. */
Object.defineProperty(exported, 'constraints', { get: () => g().elevation });
Object.defineProperty(exported, 'country', { get: () => g().country });
Object.defineProperty(exported, 'city', { get: () => g().city });
Object.defineProperty(exported, 'objects', { get: () => g().objects });
Object.defineProperty(exported, 'terrain', { get: () => g().terrain });
Object.defineProperty(exported, 'countryNames', { get: () => sceneNames() });

document.getElementById('button-reset').addEventListener('click', () => {
    g().generate();
    for (let i = 0; i < NUM_COUNTRIES; i++) {
        sceneNames()[i] = '';
        const input = document.getElementById(`country-name-${i}`) as HTMLInputElement;
        if (input) { input.value = ''; }
    }
    exported.onUpdate();
});


/* Country selection: each palette swatch is both the palette and the
 * "country" tool. Clicking a swatch selects that country and switches
 * the active tool to country painting. Each row also has a text input
 * for the country name, shown on the map once the country is painted.
 */
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
        sceneNames()[i] = input.value;
        exported.onUpdate();
    });

    row.appendChild(btn);
    row.appendChild(input);
    countryToolbar.appendChild(row);
}


const SIZES = {
    // rate is effect per second
    tiny:   {key: '1', rate: 9, innerRadius: 1.5, outerRadius: 2.5},
    small:  {key: '2', rate: 8, innerRadius: 2, outerRadius: 6},
    medium: {key: '3', rate: 5, innerRadius: 5, outerRadius: 10},
    large:  {key: '4', rate: 3, innerRadius: 10, outerRadius: 16},
};

const TOOLS = {
    ocean:    {elevation: -0.25},
    shallow:  {elevation: -0.05},
    valley:   {elevation: +0.05},
    mountain: {elevation: +1.0},
};

/* In city mode the four terrain tools are reinterpreted as zone
 * brushes; the tool buttons are recolored to match. */
const CITY_TOOLS = {
    ocean:    CITY_WATER,
    shallow:  CITY_PARK,
    valley:   CITY_RESIDENTIAL,
    mountain: CITY_COMMERCIAL,
};

const TOOL_BUTTONS = ['ocean', 'shallow', 'valley', 'mountain'];
const TOOL_SVG_OPACITY = '0.25';

/* City object brushes: paint/erase roads, buildings and trees. Only
 * usable in the city scene; painting an object overrides the automatic
 * zone-based placement, erase forbids it. */
const CITY_OBJECT_TOOLS = [
    {key: 'road',     label: 'road',     color: 'hsl(0, 0%, 28%)'},
    {key: 'building', label: 'building', color: 'hsl(35, 40%, 46%)'},
    {key: 'tree',     label: 'tree',     color: 'hsl(120, 35%, 34%)'},
    {key: 'erase',    label: 'erase',    color: 'hsl(0, 0%, 88%)'},
];
const CITY_TOOL_KEYS = CITY_OBJECT_TOOLS.map(t => t.key);
const cityToolbar = document.getElementById('city-tools');
for (let t of CITY_OBJECT_TOOLS) {
    const row = document.createElement('div');
    row.setAttribute('class', 'city-tool-row');
    const btn = document.createElement('button');
    btn.setAttribute('id', `city-tool-${t.key}`);
    btn.style.background = t.color;
    btn.setAttribute('title', t.label);
    btn.addEventListener('click', () => {
        currentTool = t.key;
        displayCurrentTool();
    });
    const span = document.createElement('span');
    span.appendChild(document.createTextNode(t.label));
    row.appendChild(btn);
    row.appendChild(span);
    cityToolbar.appendChild(row);
}

/* Terrain brushes: paint an explicit terrain type (snow, grass, ...)
 * over the wild map, overriding the automatic biome colors. Snow also
 * raises the elevation (like the mountain brush) so it gets real
 * mountain relief; grass keeps the land low and flat (like the valley
 * brush). */
const TERRAIN_TOOLS = [
    {key: 'snow',   label: 'snow',   type: TERRAIN_SNOW,   elevation: +1.0},
    {key: 'grass',  label: 'grass',  type: TERRAIN_GRASS,  elevation: +0.05},
    {key: 'forest', label: 'forest', type: TERRAIN_FOREST, elevation: +0.1},
    {key: 'desert', label: 'desert', type: TERRAIN_DESERT, elevation: +0.05},
];
const TERRAIN_TOOL_KEYS = TERRAIN_TOOLS.map(t => t.key);
/* The four terrain buttons are plain buttons in embed.html (like the
 * original terrain tools); bind them like the other tools below. */

function setScene(scene: SceneName) {
    activeScene = scene;
    /* countries row and city object tools share the same panel */
    document.getElementById('countries').style.display = scene === 'city' ? 'none' : '';
    document.getElementById('city-tools').style.display = scene === 'city' ? 'flex' : 'none';
    /* terrain brushes (snow/grass/forest/desert) are wild-map only */
    for (const t of TERRAIN_TOOLS) {
        document.getElementById(t.key).style.display = scene === 'city' ? 'none' : '';
    }
    if (scene === 'wild' && CITY_TOOL_KEYS.includes(currentTool)) {
        currentTool = 'mountain';
    }
    if (scene === 'city' && TERRAIN_TOOL_KEYS.includes(currentTool)) {
        currentTool = 'mountain';
    }
    for (const name of TOOL_BUTTONS) {
        const btn = document.getElementById(name) as HTMLButtonElement;
        if (!btn) continue;
        const svg = btn.querySelector('svg') as SVGSVGElement;
        if (scene === 'city') {
            const [r, g, b] = cityPalette[CITY_TOOLS[name]];
            btn.style.background = `rgb(${255*r|0},${255*g|0},${255*b|0})`;
            if (svg) svg.style.opacity = TOOL_SVG_OPACITY;
        } else {
            btn.style.background = '';
            if (svg) svg.style.opacity = '';
        }
    }
    /* show the active scene's country names in the inputs */
    for (let i = 0; i < NUM_COUNTRIES; i++) {
        const input = document.getElementById(`country-name-${i}`) as HTMLInputElement;
        if (input) { input.value = scenes[activeScene].names[i]; }
    }
    displayCurrentTool();
}

let currentTool = 'mountain';
let currentSize = 'small';

function displayCurrentTool() {
    const className = 'current-control';
    for (let c of document.querySelectorAll("."+className)) {
        c.classList.remove(className);
    }
    if (currentTool !== 'country') {
        let id;
        if (CITY_TOOL_KEYS.includes(currentTool)) { id = `city-tool-${currentTool}`; }
        else { id = currentTool; }
        document.getElementById(id).classList.add(className);
    }
    document.getElementById(currentSize).classList.add(className);
    if (currentTool === 'country') {
        document.getElementById(`country-${currentCountry}`).classList.add(className);
    }
}

const controls: [string, string, () => void][] = [
    ['1', "tiny",     () => { currentSize = 'tiny'; }],
    ['2', "small",    () => { currentSize = 'small'; }],
    ['3', "medium",   () => { currentSize = 'medium'; }],
    ['4', "large",    () => { currentSize = 'large'; }],
    ['q', "ocean",    () => { currentTool = 'ocean'; }],
    ['w', "shallow",  () => { currentTool = 'shallow'; }],
    ['e', "valley",   () => { currentTool = 'valley'; }],
    ['r', "mountain", () => { currentTool = 'mountain'; }],
    ['a', "road",     () => { currentTool = 'road'; }],
    ['s', "building", () => { currentTool = 'building'; }],
    ['d', "tree",     () => { currentTool = 'tree'; }],
    ['f', "erase",    () => { currentTool = 'erase'; }],
];

window.addEventListener('keydown', e => {
    for (let control of controls) {
        if (e.key === control[0]) { control[2](); displayCurrentTool(); }
    }
});

for (let control of controls) {
    const el = document.getElementById(control[1]) ?? document.getElementById(`city-tool-${control[1]}`);
    if (el) { el.addEventListener('click', () => { control[2](); displayCurrentTool(); }); }
}
/* terrain brush buttons (snow/grass/forest/desert) in embed.html */
for (let t of TERRAIN_TOOLS) {
    const el = document.getElementById(t.key);
    if (el) { el.addEventListener('click', () => { currentTool = t.key; displayCurrentTool(); }); }
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
        currentStroke.previousElevation.set(g().elevation);
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
            // disc, so moving the brush edits the border directly.
            g().paintCountryAt(currentCountry, coords[0], coords[1], brushSize.outerRadius);
        } else if (TERRAIN_TOOL_KEYS.includes(currentTool)) {
            // Terrain brushes paint an explicit terrain type (snow, ...).
            // Snow also raises the elevation like the mountain brush, so
            // the painted area gets real mountain relief (white snow).
            const terrainTool = TERRAIN_TOOLS.find(t => t.key === currentTool)!;
            if (terrainTool.elevation !== undefined) {
                g().paintAt({elevation: terrainTool.elevation}, coords[0], coords[1],
                            brushSize, nowMs - timestamp);
            }
            g().paintTerrainAt(terrainTool.type, coords[0], coords[1], brushSize.outerRadius);
        } else if (activeScene === 'city') {
            // City brushes: zone stamps, or paint/erase objects.
            if (currentTool === 'road') {
                g().paintObjectAt(OBJ_ROAD, coords[0], coords[1], brushSize.outerRadius);
            } else if (currentTool === 'building') {
                g().paintObjectAt(OBJ_BUILDING, coords[0], coords[1], brushSize.outerRadius);
            } else if (currentTool === 'tree') {
                g().paintObjectAt(OBJ_TREE, coords[0], coords[1], brushSize.outerRadius);
            } else if (currentTool === 'erase') {
                // erase removes all object types in the brush area
                g().eraseObjectAt(OBJ_ROAD | OBJ_BUILDING | OBJ_TREE, coords[0], coords[1], brushSize.outerRadius);
            } else {
                g().paintCityAt(CITY_TOOLS[currentTool], coords[0], coords[1], brushSize.outerRadius);
            }
        } else {
            // Original terrain brushes also clear any explicit terrain
            // type (snow/grass) so their colors cover the painted area.
            g().paintTerrainAt(TERRAIN_NONE, coords[0], coords[1], brushSize.outerRadius);
            g().paintAt(TOOLS[currentTool], coords[0], coords[1],
                        brushSize, nowMs - timestamp);
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
