/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2018 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * Configuration parameters shared by the point precomputation and the
 * map generator. Some of these objects are empty because they will be
 * filled in by the map generator.
 */

export default {
    spacing: 5.5,
    mountainSpacing: 25,
    map: {
        width: 2000,
        height: 1000,
    },
    mesh: {
        seed: 12345,
    },
    elevation: {
    },
    biomes: {
    },
    rivers: {
    },
    render: {
    },
};
