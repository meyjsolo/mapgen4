/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2025 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * City data model. Cities are independent of the terrain generation: each
 * city is just an id, a display name and a position in world coordinates.
 */

export interface City {
    id: string;
    name: string;
    x: number; /* world X */
    y: number; /* world Y */
    placed: boolean; /* false = created in the panel but not yet dropped on the map */
}

export class CityManager {
    cities: City[] = [];
    private nextId = 1;

    createCity(name: string, x?: number, y?: number): City {
        const city: City = {
            id: 'city-' + (this.nextId++),
            name,
            x: x ?? 0,
            y: y ?? 0,
            placed: x !== undefined && y !== undefined,
        };
        this.cities.push(city);
        return city;
    }

    updateCity(id: string, name: string): City | null {
        const city = this.getCity(id);
        if (!city) return null;
        city.name = name;
        return city;
    }

    setCityPosition(id: string, x: number, y: number): City | null {
        const city = this.getCity(id);
        if (!city) return null;
        city.x = x;
        city.y = y;
        city.placed = true;
        return city;
    }

    deleteCity(id: string): boolean {
        const i = this.cities.findIndex(c => c.id === id);
        if (i < 0) return false;
        this.cities.splice(i, 1);
        return true;
    }

    getCity(id: string): City | null {
        return this.cities.find(c => c.id === id) ?? null;
    }

    getCities(): City[] {
        return this.cities;
    }

    toJSON(): City[] {
        return this.cities;
    }

    fromJSON(list: any[]) {
        this.cities = (list ?? []).map(c => ({
            id: String(c.id),
            name: String(c.name ?? ''),
            x: Number(c.x) || 0,
            y: Number(c.y) || 0,
            placed: c.placed !== false, /* old saves have no placed field */
        }));
        /* keep ids unique when new cities are created after a load */
        let max = 0;
        for (const c of this.cities) {
            const n = parseInt(String(c.id).replace(/^city-/, ''), 10);
            if (!isNaN(n) && n >= max) max = n;
        }
        this.nextId = max + 1;
    }
}
