import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import { decayParcels, parseDecayInterval, createTiles2D, createGraphFromTiles } from "./utils.js"

const client = new DeliverooApi(
    'http://localhost:8080',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjNiZGJmMSIsIm5hbWUiOiJUd29CYW5hbmFzIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTEzNjA2NDF9.J5uTBh3yTrUviXsl0o8djdHoMQ03tS0CE0lnJUDdKCE'
)

let DECAY_INTERVAL = 0;
let OBS_RANGE = 0;
let MOVE_DURATION = 0;
let MOVE_STEPS = 0;
let MAX_PARCELS = 0;
let AGENT_OBS_RANGE = 0;
let CLOCK = 0;

client.onConfig(config => {
    console.log("Received config:", config);

    DECAY_INTERVAL = parseDecayInterval(config.PARCEL_DECADING_INTERVAL);
    OBS_RANGE = Number(config.PARCELS_OBSERVATION_DISTANCE);
    AGENT_OBS_RANGE = Number(config.AGENTS_OBSERVATION_DISTANCE);
    CLOCK = Number(config.CLOCK);
    MOVE_DURATION = Number(config.MOVEMENT_DURATION);
    MOVE_STEPS = Number(config.MOVEMENT_STEPS);
    MAX_PARCELS = Number(config.PARCELS_MAX);
});

/**
 * @type { {id:string, name:string, x:number, y:number, score:number} }
 */
const me = {id: null, name: null, x: null, y: null, score: null};

/**
 * @type { Map< string, {id: string, carriedBy?: string, x:number, y:number, reward:number, lastSeen:number} > }
 */
const parcels = new Map();
// #######################################################################################################################
// CHANGE NAME AND CHECK CARRIED BY
//##########################################################################################################################

// CHECK ID CONSISTENCY
/**
 * @type { Map< string, {id: string, reward:number, lastSeen:number} > }
 */
const carriedParcels = new Map();

/**
 * @type { Map< string, {id: string, x:number, y:number} > }
 */
const agents = new Map();

/**
 * @type { Map< string, {x:number, y:number, type:Number} > }
 */
const deliveryCells = new Map();

export {deliveryCells}

client.onMap((width, height, tiles) => {
    deliveryCells.clear();

    for (const tile of tiles) {
        if (tile.type === 2) {
            deliveryCells.set("(" + tile.x + "," + tile.y + ")", tile);
        }
    }

    const tiles2D = createTiles2D(width, height, tiles);
    const { graph, nodePositions } = createGraphFromTiles(width, height, tiles2D);

    global.graph = graph;
    global.nodePositions = nodePositions;
    global.mapWidth = width;
    global.mapHeight = height;
    global.tiles2D = tiles2D;


})