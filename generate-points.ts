/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2023 Red Blob Games <redblobgames@gmail.com>
 * @license Apache-2.0 <https://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * This module calculates
 *   * boundary points
 *   * mountain points
 *   * all other points
 */

import Poisson from 'fast-2d-poisson-disk-sampling';
import {makeRandFloat} from '@redblobgames/prng';
import {generateInteriorBoundaryPoints, generateExteriorBoundaryPoints} from "./dual-mesh/create.ts";

export type Point = [number, number];
export type PointsData = {
    points: Point[];
    numExteriorBoundaryPoints: number;
    numInteriorBoundaryPoints: number;
    numMountainPoints: number;
}

/**
   Generate points which will be seeds for Delaunay Triangulation, and
   will become regions ("r") in the resulting dual mesh.

   The points are returned in a single array with four contiguous blocks:

   [ e e e e e | i i i i i | m m m m m | p p p p p ]
     ^^^^^^^^^   ^^^^^^^^^   ^^^^^^^^^   ^^^^^^^^^
        |           |           |           |______ other interior points
        |           |           |_numMountainPoints mountain peak points
        |           |_____numInteriorBoundaryPoints interior boundary points
        |_________________numExteriorBoundaryPoints exterior boundary points
        

 */
export function choosePoints(seed: number, spacing: number, mountainSpacing: number): PointsData {
    // Generate both interior and exterior boundary points; see
    // https://www.redblobgames.com/x/2314-poisson-with-boundary/
    const boundarySpacing = spacing * Math.sqrt(2);
    const bounds = {left: 0, top: 0, width: 1000, height: 1000}; // left,top must be 0 for poisson
    let interiorBoundaryPoints = generateInteriorBoundaryPoints(bounds, boundarySpacing);
    let exteriorBoundaryPoints = generateExteriorBoundaryPoints(bounds, boundarySpacing);
    
    // Second, generate the mountain points, with the interior boundary points pushing mountains away
    let mountainPointsGenerator = new Poisson({
        shape: [bounds.width, bounds.height],
        radius: mountainSpacing,
        tries: 30,
    }, makeRandFloat(seed));
    for (let p of interiorBoundaryPoints) { if (!mountainPointsGenerator.addPoint(p)) throw "mtn point did not get added"; }
    let interiorPoints: Point[] = mountainPointsGenerator.fill(); // now contains both interior boundary points and mountain points
    let numMountainPoints = interiorPoints.length - interiorBoundaryPoints.length;
    
    // Generate the rest of the mesh points with the interior boundary points and mountain points as constraints
    let generator = new Poisson({
        shape: [bounds.width, bounds.height],
        radius: spacing,
        tries: 6, // NOTE: below 5 is unstable, and 5 is borderline; defaults to 30, but lower is faster
    }, makeRandFloat(seed));
    for (let p of interiorPoints) { if (!generator.addPoint(p)) throw "point did not get added"; }
    interiorPoints = generator.fill(); // now contains interior boundary points, mountain points, and rest of points
    
    return {
        points: exteriorBoundaryPoints.concat(interiorPoints),
        numExteriorBoundaryPoints: exteriorBoundaryPoints.length,
        numInteriorBoundaryPoints: interiorBoundaryPoints.length,
        numMountainPoints
    };
}


/**
 * Like choosePoints, but for a single world tile. The tile rectangle is
 * given in world coordinates as [x0, y0, width, height]. `mountainPoints`
 * is the world-level, LOD-independent mountain peak list; peaks inside the
 * rectangle become constrained points (and therefore mesh regions) so
 * mountains align across LODs and tiles.
 *
 * The returned `numMountainPoints` counts only the mountain points that
 * actually made it into the mesh (some may be rejected because they are
 * too close to a boundary point).
 */
export function chooseTilePoints(seed: number, spacing: number, mountainSpacing: number,
                                 rect: [number, number, number, number],
                                 mountainPoints: Float32Array): PointsData {
    const [x0, y0, w, h] = rect;
    // Work in local coordinates: the poisson library expects an origin
    // at (0,0), so generate locally then offset back to world coords.
    const bounds = {left: 0, top: 0, width: w, height: h};
    const boundarySpacing = spacing * Math.sqrt(2);
    const interiorBoundaryPoints = generateInteriorBoundaryPoints(bounds, boundarySpacing);
    const exteriorBoundaryPoints = generateExteriorBoundaryPoints(bounds, boundarySpacing);

    // Mountain peaks inside the rect, translated to local coordinates.
    const mtnLocal: Point[] = [];
    for (let i = 0; i < mountainPoints.length; i += 2) {
        const px = mountainPoints[i], py = mountainPoints[i+1];
        if (px >= x0 && px < x0 + w && py >= y0 && py < y0 + h) {
            mtnLocal.push([px - x0, py - y0]);
        }
    }

    const mountainPointsGenerator = new Poisson({
        shape: [w, h],
        radius: mountainSpacing,
        tries: 30,
    }, makeRandFloat(seed));
    for (let p of interiorBoundaryPoints) { if (!mountainPointsGenerator.addPoint(p)) throw "mtn boundary point did not get added"; }
    for (let p of mtnLocal) { mountainPointsGenerator.addPoint(p); /* may be rejected; that's ok */}
    let interiorPoints: Point[] = mountainPointsGenerator.fill();
    let numMountainPoints = mtnLocal.length;

    const generator = new Poisson({
        shape: [w, h],
        radius: spacing,
        tries: 6,
    }, makeRandFloat(seed));
    for (let p of interiorPoints) { if (!generator.addPoint(p)) throw "point did not get added"; }
    interiorPoints = generator.fill();

    const offset = (p: Point): Point => [p[0] + x0, p[1] + y0];
    return {
        points: exteriorBoundaryPoints.concat(interiorPoints).map(offset),
        numExteriorBoundaryPoints: exteriorBoundaryPoints.length,
        numInteriorBoundaryPoints: interiorBoundaryPoints.length,
        numMountainPoints,
    };
}


/**
 * Generate the world-level mountain peak set, once, from the mesh seed.
 * The peaks are stored as a flat Float32Array of [x, y] pairs. Peaks are
 * LOD-independent, so each tile picks up the peaks in its rectangle and
 * the resulting mountains align across LODs and tiles.
 */
export function generateMountainPeaks(seed: number, mountainSpacing: number, worldSize: number): Float32Array {
    const generator = new Poisson({
        shape: [worldSize, worldSize],
        radius: mountainSpacing,
        tries: 30,
    }, makeRandFloat(seed));
    const points = generator.fill();
    const out = new Float32Array(2 * points.length);
    for (let i = 0; i < points.length; i++) {
        out[2*i] = points[i][0];
        out[2*i+1] = points[i][1];
    }
    return out;
}
