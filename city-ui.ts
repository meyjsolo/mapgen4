/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2025 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * City marker UI + interaction. Renders each city as a DOM marker/label
 * overlay inside the map, positioned every frame from world coordinates via
 * the shared projection (so markers follow pan/zoom automatically).
 *
 * Interaction is pointer-based so it works for mouse AND touch:
 *   - tap (quick press-release)        -> select / deselect city
 *   - long-press (hold ~500ms) or      -> context menu:
 *       right-click                      * empty  : "创建城市"
 *                                        * city   : "编辑城市 / 删除城市"
 * Cities are stored in world coordinates (CityManager), never screen-space.
 */

import {CityManager} from './cities.ts';
import type Renderer from './render.ts';

const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD = 10; /* px before a press is treated as a drag */
const MENU_W = 140;
const MENU_H = 90;

type ElemSet = {marker: HTMLButtonElement; label: HTMLButtonElement};

interface DialogOptions {
    title: string;
    input?: {label: string; value: string};
    body?: string;
    ok: string;
    danger?: boolean;
    onOk: (name: string) => boolean; /* return false keeps the dialog open */
}

export default class CityUI {
    private layer: HTMLDivElement;
    private mapEl: HTMLElement;
    private els = new Map<string, ElemSet>();
    private menuEl: HTMLDivElement | null = null;
    private dialogEl: HTMLDivElement | null = null;

    selectedCityId: string | null = null;

    private press = {
        active: false,
        pointerId: -1,
        startX: 0,
        startY: 0,
        timer: null as number | null,
        cityId: null as string | null,
        longFired: false,
        suppressNextContext: false,
    };

    constructor(private render: Renderer, private cities: CityManager) {
        this.mapEl = document.getElementById('map') as HTMLElement;
        this.layer = document.createElement('div');
        this.layer.id = 'city-markers';
        this.mapEl.appendChild(this.layer);

        this.mapEl.addEventListener('pointerdown', this.onPress.bind(this));
        this.mapEl.addEventListener('pointermove', this.onMove.bind(this));
        this.mapEl.addEventListener('pointerup', this.onRelease.bind(this));
        this.mapEl.addEventListener('pointercancel', this.onRelease.bind(this));
        this.mapEl.addEventListener('contextmenu', this.onContextMenu.bind(this));
        window.addEventListener('keydown', this.onKey.bind(this));
        document.addEventListener('pointerdown', this.onDocPointerDown.bind(this));
    }

    /* Recreate all marker/label elements from the CityManager. Call after
     * create/edit/delete/load. */
    rebuild() {
        for (const e of this.els.values()) { e.marker.remove(); e.label.remove(); }
        this.els.clear();
        for (const c of this.cities.getCities()) {
            const marker = document.createElement('button');
            marker.type = 'button';
            marker.className = 'city-marker';
            marker.dataset.cityId = c.id;
            marker.setAttribute('aria-label', c.name);
            const label = document.createElement('button');
            label.type = 'button';
            label.className = 'city-label';
            label.dataset.cityId = c.id;
            label.textContent = c.name;
            this.layer.appendChild(marker);
            this.layer.appendChild(label);
            this.els.set(c.id, {marker, label});
        }
        this.applySelection();
        this.updatePositions();
    }

    /* Reposition every city marker/label from world coords via the
     * projection. Called every frame by the renderer. */
    updatePositions() {
        const W = this.mapEl.clientWidth, H = this.mapEl.clientHeight;
        if (W <= 0 || H <= 0) return;
        for (const c of this.cities.getCities()) {
            const e = this.els.get(c.id);
            if (!e) continue;
            const [nx, ny] = this.render.worldToScreen(c.x, c.y);
            const visible = nx >= -0.05 && nx <= 1.05 && ny >= -0.05 && ny <= 1.05;
            e.marker.style.display = visible ? '' : 'none';
            e.label.style.display = visible ? '' : 'none';
            if (!visible) continue;
            e.marker.style.left = (nx * W) + 'px';
            e.marker.style.top = (ny * H) + 'px';
            e.label.style.left = (nx * W) + 'px';
            e.label.style.top = (ny * H) + 'px';
        }
    }

    /* ---- selection ---- */

    private selectCity(id: string) {
        this.selectedCityId = id;
        this.applySelection();
    }

    private deselectAll() {
        this.selectedCityId = null;
        this.applySelection();
    }

    private applySelection() {
        for (const [id, e] of this.els) {
            const sel = id === this.selectedCityId;
            e.marker.classList.toggle('selected', sel);
            e.label.classList.toggle('selected', sel);
        }
    }

    /* ---- coordinate helpers (reuse the renderer's projection) ---- */

    private canvasRect(): DOMRect {
        return (document.getElementById('mapgen4') as HTMLElement).getBoundingClientRect();
    }

    private pointerWorld(clientX: number, clientY: number): {x: number; y: number} {
        const r = this.canvasRect();
        const w = this.render.screenToWorld([
            (clientX - r.left) / r.width,
            (clientY - r.top) / r.height,
        ]);
        return {x: w[0], y: w[1]};
    }

    /* Screen-space hit test: return the city whose marker or label occupies
     * the given client position, or null. */
    private cityIdAt(clientX: number, clientY: number): string | null {
        for (const [id, e] of this.els) {
            if (e.marker.style.display === 'none' && e.label.style.display === 'none') continue;
            const mr = e.marker.getBoundingClientRect();
            if (clientX >= mr.left && clientX <= mr.right && clientY >= mr.top && clientY <= mr.bottom) return id;
            const lr = e.label.getBoundingClientRect();
            if (clientX >= lr.left && clientX <= lr.right && clientY >= lr.top && clientY <= lr.bottom) return id;
        }
        return null;
    }

    /* ---- pointer gestures (tap / long-press) ---- */

    private onPress(e: PointerEvent) {
        if (e.button !== 0) return; /* right/middle handled by contextmenu */
        this.closeMenu();
        this.press.active = true;
        this.press.pointerId = e.pointerId;
        this.press.startX = e.clientX;
        this.press.startY = e.clientY;
        this.press.longFired = false;
        this.press.suppressNextContext = false;
        this.press.cityId = this.cityIdAt(e.clientX, e.clientY);
        if (this.press.timer !== null) clearTimeout(this.press.timer);
        this.press.timer = window.setTimeout(() => this.fireLongPress(), LONG_PRESS_MS);
    }

    private onMove(e: PointerEvent) {
        if (!this.press.active || e.pointerId !== this.press.pointerId) return;
        const dx = e.clientX - this.press.startX, dy = e.clientY - this.press.startY;
        if (Math.hypot(dx, dy) > MOVE_THRESHOLD && !this.press.longFired) {
            if (this.press.timer !== null) { clearTimeout(this.press.timer); this.press.timer = null; }
        }
    }

    private onRelease(e: PointerEvent) {
        if (!this.press.active || e.pointerId !== this.press.pointerId) return;
        const p = this.press;
        this.press = { ...this.press, active: false, pointerId: -1, timer: null, longFired: false, suppressNextContext: false };
        if (p.timer !== null) clearTimeout(p.timer);
        if (p.longFired) return; /* a menu is already open; don't tap-select */
        const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
        if (moved > MOVE_THRESHOLD) return; /* was a drag/pan */
        /* it's a tap */
        if (p.cityId) this.selectCity(p.cityId);
        else this.deselectAll();
    }

    private fireLongPress() {
        this.press.longFired = true;
        this.press.suppressNextContext = true;
        const world = this.pointerWorld(this.press.startX, this.press.startY);
        if (this.press.cityId) {
            this.openMenu(this.press.startX, this.press.startY, this.press.cityId);
        } else {
            this.openCreateMenu(this.press.startX, this.press.startY, world.x, world.y);
        }
    }

    private onContextMenu(e: MouseEvent) {
        e.preventDefault();
        if (this.press.suppressNextContext) { this.press.suppressNextContext = false; return; }
        this.closeMenu();
        const world = this.pointerWorld(e.clientX, e.clientY);
        const id = this.cityIdAt(e.clientX, e.clientY);
        if (id) {
            this.openMenu(e.clientX, e.clientY, id);
        } else {
            this.openCreateMenu(e.clientX, e.clientY, world.x, world.y);
        }
    }

    private onDocPointerDown(e: PointerEvent) {
        if (this.menuEl && e.target && !this.menuEl.contains(e.target as Node)) {
            this.closeMenu();
        }
    }

    private onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            if (this.dialogEl) this.closeDialog();
            else if (this.menuEl) this.closeMenu();
        }
    }

    /* ---- context menu ---- */

    private menuButton(text: string, fn: () => void): HTMLButtonElement {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.addEventListener('click', () => fn());
        return b;
    }

    private openCreateMenu(x: number, y: number, wx: number, wy: number) {
        this.closeMenu();
        const menu = document.createElement('div');
        menu.className = 'city-menu';
        menu.appendChild(this.menuButton('创建城市', () => {
            this.closeMenu();
            this.openCreateDialog(wx, wy);
        }));
        this.showMenu(menu, x, y);
    }

    private openMenu(x: number, y: number, cityId: string) {
        this.closeMenu();
        const menu = document.createElement('div');
        menu.className = 'city-menu';
        menu.appendChild(this.menuButton('编辑城市', () => {
            this.closeMenu();
            this.openEditDialog(cityId);
        }));
        menu.appendChild(this.menuButton('删除城市', () => {
            this.closeMenu();
            this.openDeleteDialog(cityId);
        }));
        this.showMenu(menu, x, y);
    }

    private showMenu(menu: HTMLDivElement, x: number, y: number) {
        menu.style.left = Math.min(x, Math.max(0, window.innerWidth - MENU_W)) + 'px';
        menu.style.top = Math.min(y, Math.max(0, window.innerHeight - MENU_H)) + 'px';
        document.body.appendChild(menu);
        this.menuEl = menu;
    }

    private closeMenu() {
        if (this.menuEl) { this.menuEl.remove(); this.menuEl = null; }
    }

    /* ---- dialogs ---- */

    private openCreateDialog(x: number, y: number) {
        this.openDialog({
            title: '创建城市',
            input: {label: '城市名称', value: ''},
            ok: '创建',
            onOk: (name) => {
                const city = this.cities.createCity(name, x, y);
                this.selectedCityId = city.id;
                this.rebuild();
                return true;
            },
        });
    }

    private openEditDialog(id: string) {
        const c = this.cities.getCity(id);
        if (!c) return;
        this.openDialog({
            title: '编辑城市',
            input: {label: '城市名称', value: c.name},
            ok: '保存',
            onOk: (name) => {
                this.cities.updateCity(id, name);
                this.rebuild();
                return true;
            },
        });
    }

    private openDeleteDialog(id: string) {
        const c = this.cities.getCity(id);
        if (!c) return;
        this.closeMenu();
        this.openDialog({
            title: '删除城市',
            body: '确定删除「' + c.name + '」？',
            ok: '删除',
            danger: true,
            onOk: () => {
                if (this.selectedCityId === id) this.selectedCityId = null;
                this.cities.deleteCity(id);
                this.rebuild();
                return true;
            },
        });
    }

    private openDialog(opts: DialogOptions) {
        this.closeDialog();
        const modal = document.createElement('div');
        modal.className = 'city-dialog-modal';
        const card = document.createElement('div');
        card.className = 'city-dialog-card';

        const h3 = document.createElement('h3');
        h3.textContent = opts.title;
        card.appendChild(h3);

        let input: HTMLInputElement | null = null;
        if (opts.input) {
            const label = document.createElement('label');
            label.textContent = opts.input.label;
            input = document.createElement('input');
            input.type = 'text';
            input.value = opts.input.value;
            input.placeholder = opts.input.label;
            card.appendChild(label);
            card.appendChild(input);
        } else if (opts.body) {
            const p = document.createElement('p');
            p.className = 'city-dialog-body';
            p.textContent = opts.body;
            card.appendChild(p);
        }

        const err = document.createElement('div');
        err.className = 'city-error';
        card.appendChild(err);

        const actions = document.createElement('div');
        actions.className = 'city-dialog-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', () => this.closeDialog());
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = opts.danger ? 'danger' : 'primary';
        okBtn.textContent = opts.ok;
        okBtn.addEventListener('click', () => {
            const name = input ? input.value.trim() : '';
            if (opts.input && !name) { err.textContent = '城市名称不能为空'; if (input) input.focus(); return; }
            if (opts.onOk(name)) this.closeDialog();
        });
        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
        card.appendChild(actions);

        modal.appendChild(card);
        document.body.appendChild(modal);
        this.dialogEl = modal;
        if (input) { input.focus(); }
    }

    private closeDialog() {
        if (this.dialogEl) { this.dialogEl.remove(); this.dialogEl = null; }
    }
}