/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2025 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * City marker UI + interaction. Cities are managed from an edit panel on
 * the right side of the page (#city-panel):
 *   - "创建城市" button -> name dialog -> city appears in the panel list
 *     (not on the map yet; it is "unplaced").
 *   - drag a panel item onto the map -> the city is placed at the drop
 *     point; dragging a placed city's panel item re-places it.
 *   - click a panel item -> menu: 修改名称 / 删除城市.
 * On the map each placed city is a DOM marker/label overlay positioned
 * every frame from world coordinates via the shared projection (so markers
 * follow pan/zoom automatically):
 *   - tap a marker  -> select / deselect
 *   - drag a marker -> move the city to a new position
 * Cities are stored in world coordinates (CityManager), never screen-space.
 */

import {CityManager} from './cities.ts';
import type Renderer from './render.ts';

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
    private panelEl: HTMLElement;
    private listEl: HTMLDivElement;
    private els = new Map<string, ElemSet>();
    private menuEl: HTMLDivElement | null = null;
    private dialogEl: HTMLDivElement | null = null;
    private ghostEl: HTMLDivElement | null = null;

    selectedCityId: string | null = null;

    /* map press state: tap-select or marker drag */
    private press = {
        active: false,
        pointerId: -1,
        startX: 0,
        startY: 0,
        cityId: null as string | null,
        dragging: false,
    };

    constructor(private render: Renderer, private cities: CityManager) {
        this.mapEl = document.getElementById('map') as HTMLElement;
        this.layer = document.createElement('div');
        this.layer.id = 'city-markers';
        this.mapEl.appendChild(this.layer);

        this.panelEl = document.getElementById('city-panel') as HTMLElement;
        const title = document.createElement('div');
        title.className = 'city-panel-title';
        title.textContent = '城市';
        const createBtn = document.createElement('button');
        createBtn.type = 'button';
        createBtn.className = 'city-create-btn';
        createBtn.textContent = '＋ 创建城市';
        createBtn.addEventListener('click', () => this.openCreateDialog());
        this.listEl = document.createElement('div');
        this.listEl.className = 'city-list';
        this.panelEl.appendChild(title);
        this.panelEl.appendChild(createBtn);
        this.panelEl.appendChild(this.listEl);

        this.mapEl.addEventListener('pointerdown', this.onPress.bind(this));
        this.mapEl.addEventListener('pointermove', this.onMove.bind(this));
        this.mapEl.addEventListener('pointerup', this.onRelease.bind(this));
        this.mapEl.addEventListener('pointercancel', this.onRelease.bind(this));
        window.addEventListener('keydown', this.onKey.bind(this));
        document.addEventListener('pointerdown', this.onDocPointerDown.bind(this));

        this.rebuild();
    }

    /* Recreate all marker/label elements and the panel list from the
     * CityManager. Call after create/edit/delete/place/load. */
    rebuild() {
        for (const e of this.els.values()) { e.marker.remove(); e.label.remove(); }
        this.els.clear();
        this.listEl.textContent = '';
        for (const c of this.cities.getCities()) {
            if (c.placed) {
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
            this.listEl.appendChild(this.buildPanelItem(c.id, c.name, c.placed));
        }
        this.applySelection();
        this.updatePositions();
    }

    /* ---- panel ---- */

    private buildPanelItem(cityId: string, name: string, placed: boolean): HTMLDivElement {
        const item = document.createElement('div');
        item.className = 'city-item' + (placed ? '' : ' unplaced');
        item.dataset.cityId = cityId;
        const dot = document.createElement('span');
        dot.className = 'city-item-dot';
        const text = document.createElement('span');
        text.className = 'city-item-name';
        text.textContent = name;
        item.appendChild(dot);
        item.appendChild(text);
        if (!placed) {
            const hint = document.createElement('span');
            hint.className = 'city-item-hint';
            hint.textContent = '拖到地图放置';
            item.appendChild(hint);
        }

        let startX = 0, startY = 0, dragging = false, pointerId = -1;
        item.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0) return;
            this.closeMenu();
            pointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            dragging = false;
            item.setPointerCapture(pointerId);
            e.preventDefault();
        });
        item.addEventListener('pointermove', (e: PointerEvent) => {
            if (e.pointerId !== pointerId) return;
            if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_THRESHOLD) {
                dragging = true;
                this.showGhost(name, e.clientX, e.clientY);
            }
            if (dragging) this.moveGhost(e.clientX, e.clientY);
        });
        const finish = (e: PointerEvent) => {
            if (e.pointerId !== pointerId) return;
            pointerId = -1;
            if (dragging) {
                dragging = false;
                this.hideGhost();
                const r = this.canvasRect();
                if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
                    const w = this.pointerWorld(e.clientX, e.clientY);
                    this.cities.setCityPosition(cityId, w.x, w.y);
                    this.selectedCityId = cityId;
                    this.rebuild();
                }
            } else {
                this.openItemMenu(e.clientX, e.clientY, cityId);
            }
        };
        item.addEventListener('pointerup', finish);
        item.addEventListener('pointercancel', (e: PointerEvent) => {
            if (e.pointerId !== pointerId) return;
            pointerId = -1;
            dragging = false;
            this.hideGhost();
        });
        return item;
    }

    private showGhost(name: string, x: number, y: number) {
        this.hideGhost();
        const ghost = document.createElement('div');
        ghost.className = 'city-drag-ghost';
        const dot = document.createElement('span');
        dot.className = 'city-item-dot';
        const text = document.createElement('span');
        text.textContent = name;
        ghost.appendChild(dot);
        ghost.appendChild(text);
        document.body.appendChild(ghost);
        this.ghostEl = ghost;
        this.moveGhost(x, y);
    }

    private moveGhost(x: number, y: number) {
        if (!this.ghostEl) return;
        this.ghostEl.style.left = x + 'px';
        this.ghostEl.style.top = y + 'px';
    }

    private hideGhost() {
        if (this.ghostEl) { this.ghostEl.remove(); this.ghostEl = null; }
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

    /* ---- map pointer gestures (tap-select / marker drag) ---- */

    private onPress(e: PointerEvent) {
        if (e.button !== 0) return;
        this.closeMenu();
        this.press.active = true;
        this.press.pointerId = e.pointerId;
        this.press.startX = e.clientX;
        this.press.startY = e.clientY;
        this.press.dragging = false;
        this.press.cityId = this.cityIdAt(e.clientX, e.clientY);
        if (this.press.cityId) {
            /* keep receiving moves even off the marker; the canvas never
             * sees this press, so painting does not start */
            this.mapEl.setPointerCapture(e.pointerId);
        }
    }

    private onMove(e: PointerEvent) {
        if (!this.press.active || e.pointerId !== this.press.pointerId) return;
        const dx = e.clientX - this.press.startX, dy = e.clientY - this.press.startY;
        if (!this.press.dragging && Math.hypot(dx, dy) > MOVE_THRESHOLD) {
            this.press.dragging = true;
        }
        if (this.press.dragging && this.press.cityId) {
            const w = this.pointerWorld(e.clientX, e.clientY);
            this.cities.setCityPosition(this.press.cityId, w.x, w.y);
            this.updatePositions();
        }
    }

    private onRelease(e: PointerEvent) {
        if (!this.press.active || e.pointerId !== this.press.pointerId) return;
        const p = this.press;
        this.press = { active: false, pointerId: -1, startX: 0, startY: 0, cityId: null, dragging: false };
        if (p.dragging) return; /* marker move already committed during drag */
        const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
        if (moved > MOVE_THRESHOLD) return; /* was a drag/pan */
        /* it's a tap */
        if (p.cityId) this.selectCity(p.cityId);
        else this.deselectAll();
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

    /* ---- panel item menu ---- */

    private menuButton(text: string, fn: () => void): HTMLButtonElement {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.addEventListener('click', () => fn());
        return b;
    }

    private openItemMenu(x: number, y: number, cityId: string) {
        this.closeMenu();
        const menu = document.createElement('div');
        menu.className = 'city-menu';
        menu.appendChild(this.menuButton('修改名称', () => {
            this.closeMenu();
            this.openEditDialog(cityId);
        }));
        menu.appendChild(this.menuButton('删除城市', () => {
            this.closeMenu();
            this.openDeleteDialog(cityId);
        }));
        menu.style.left = Math.min(x, Math.max(0, window.innerWidth - MENU_W)) + 'px';
        menu.style.top = Math.min(y, Math.max(0, window.innerHeight - MENU_H)) + 'px';
        document.body.appendChild(menu);
        this.menuEl = menu;
    }

    private closeMenu() {
        if (this.menuEl) { this.menuEl.remove(); this.menuEl = null; }
    }

    /* ---- dialogs ---- */

    private openCreateDialog() {
        this.openDialog({
            title: '创建城市',
            input: {label: '城市名称', value: ''},
            ok: '创建',
            onOk: (name) => {
                const city = this.cities.createCity(name);
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
